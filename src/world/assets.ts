/**
 * Typed asset loader for public/assets (built by `bun run assets`).
 *
 *   await preload(['wizard', 'props_forest'], (p) => bar.value = p.ratio);
 *   const wiz = await loadAsset('wizard');        // fresh clone (skinned meshes cloned properly)
 *   const idle = getClip('wizard', 'idle');        // 'wizard@idle'
 *   const rock = await loadAsset('rock_a');        // prop node cloned out of its pack
 *
 * - One network request per file (packs shared by many prop ids), cached as a promise.
 * - Progress is reported in bytes using the manifest sizes (streamed when possible).
 * - Transient failures retry with exponential backoff.
 * - GLBs are meshopt-compressed: MeshoptDecoder is registered on the GLTFLoader.
 * Nothing here runs per frame.
 */
import { type AnimationClip, type Object3D, type Texture, TextureLoader } from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

export type AssetType = 'character' | 'prop-pack' | 'prop' | 'texture' | 'font' | 'license-text';

export interface ManifestEntry {
  file: string;
  type: AssetType;
  title: string;
  bytes: number;
  tris?: number;
  bones?: number;
  clips?: Record<string, { duration: number }>;
  sockets?: string[];
  materials?: string[];
  height?: number;
  node?: string;
  pack?: string;
  bounds?: { min: number[]; max: number[] };
  width?: number;
  license: string;
}

export interface Manifest {
  version: 1;
  assets: Record<string, ManifestEntry>;
}

export interface LoadedGltf {
  scene: Object3D;
  animations: AnimationClip[];
}

export interface LoadProgress {
  loaded: number;
  total: number;
  /** 0..1 */
  ratio: number;
  /** Id currently downloading (last progress event). */
  current: string | null;
}

export interface LoaderDeps {
  fetch: (url: string) => Promise<Response>;
  /** Parse a GLB buffer. Default: three GLTFLoader + MeshoptDecoder. */
  parseGltf: (buf: ArrayBuffer, url: string) => Promise<LoadedGltf>;
  /** Deep clone that keeps skinned meshes bound to their own bones. */
  clone: (o: Object3D) => Object3D;
  loadTexture: (url: string) => Promise<Texture>;
  sleep: (ms: number) => Promise<void>;
}

export class AssetError extends Error {
  constructor(
    message: string,
    readonly id: string,
  ) {
    super(message);
    this.name = 'AssetError';
  }
}

export class AssetLoader {
  private manifest: Manifest | null = null;
  private manifestPromise: Promise<Manifest> | null = null;
  private readonly files = new Map<string, Promise<LoadedGltf>>();
  private readonly ready = new Map<string, LoadedGltf>();
  private readonly textures = new Map<string, Promise<Texture>>();
  private readonly clipCache = new Map<string, AnimationClip | null>();

  constructor(
    readonly base: string,
    private readonly deps: LoaderDeps,
    readonly retries = 3,
  ) {}

  async loadManifest(): Promise<Manifest> {
    if (this.manifest) return this.manifest;
    this.manifestPromise ??= this.withRetry('manifest', async () => {
      const res = await this.deps.fetch(`${this.base}manifest.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as Manifest;
    }).then((m) => {
      this.manifest = m;
      return m;
    });
    try {
      return await this.manifestPromise;
    } catch (e) {
      this.manifestPromise = null; // allow a later retry (e.g. back online)
      throw e;
    }
  }

  /** Manifest entry (manifest must be loaded). */
  entry(id: string): ManifestEntry {
    const e = this.manifest?.assets[id];
    if (!e) throw new AssetError(`unknown asset "${id}"`, id);
    return e;
  }

  url(id: string): string {
    return this.base + this.entry(id).file;
  }

  has(id: string): boolean {
    return !!this.manifest?.assets[id];
  }

  /**
   * Download (or reuse) every file needed by `ids`. Progress counts each file once.
   */
  async preload(ids: readonly string[], onProgress?: (p: LoadProgress) => void): Promise<void> {
    await this.loadManifest();
    const byFile = new Map<string, { id: string; bytes: number }>();
    for (const id of ids) {
      const e = this.entry(id);
      const file = e.file;
      const owner = e.pack ? this.entry(e.pack) : e;
      if (!byFile.has(file)) byFile.set(file, { id, bytes: owner.bytes });
    }
    const total = [...byFile.values()].reduce((s, f) => s + f.bytes, 0);
    const done = new Map<string, number>();
    const report = (current: string | null) => {
      const loaded = [...done.values()].reduce((s, v) => s + v, 0);
      onProgress?.({ loaded, total, ratio: total ? Math.min(1, loaded / total) : 1, current });
    };
    report(null);
    await Promise.all(
      [...byFile.entries()].map(async ([file, { id, bytes }]) => {
        const e = this.entry(id);
        const tick = (n: number) => {
          done.set(file, Math.min(bytes, n));
          report(id);
        };
        if (file.endsWith('.glb')) await this.gltf(id, tick);
        else if (e.type === 'texture') await this.loadTexture(id);
        else await this.fetchBytes(id, this.base + file, tick);
        done.set(file, bytes);
        report(id);
      }),
    );
  }

  /** Fresh instance: characters/packs get a deep clone; prop ids return a clone of their node. */
  async loadAsset(id: string): Promise<LoadedGltf> {
    await this.loadManifest();
    const e = this.entry(id);
    const g = await this.gltf(id);
    if (e.node) {
      const node = g.scene.getObjectByName(e.node);
      if (!node) throw new AssetError(`node "${e.node}" missing in ${e.file}`, id);
      const c = this.deps.clone(node);
      c.position.set(0, 0, 0);
      c.quaternion.identity();
      c.scale.set(1, 1, 1);
      return { scene: c, animations: [] };
    }
    return { scene: this.deps.clone(g.scene), animations: g.animations };
  }

  /**
   * Animation clip by short or full name ('idle' or 'wizard@idle'). Requires the asset to be
   * loaded (preload/loadAsset); returns null if it isn't or the clip doesn't exist.
   */
  getClip(id: string, name: string): AnimationClip | null {
    const key = `${id}|${name}`;
    const cached = this.clipCache.get(key);
    if (cached !== undefined) return cached;
    const e = this.manifest?.assets[id];
    const g = e ? this.ready.get(e.file) : undefined;
    if (!g) return null;
    const full = name.includes('@') ? name : `${id}@${name}`;
    const clip = g.animations.find((a) => a.name === full) ?? null;
    if (clip) this.clipCache.set(key, clip);
    return clip;
  }

  async loadTexture(id: string): Promise<Texture> {
    await this.loadManifest();
    const url = this.url(id);
    let p = this.textures.get(url);
    if (!p) {
      p = this.withRetry(id, () => this.deps.loadTexture(url));
      this.textures.set(url, p);
      p.catch(() => this.textures.delete(url));
    }
    return p;
  }

  private gltf(id: string, onBytes?: (n: number) => void): Promise<LoadedGltf> {
    const e = this.entry(id);
    const url = this.base + e.file;
    let p = this.files.get(e.file);
    if (!p) {
      p = this.fetchBytes(id, url, onBytes).then(async (buf) => {
        const g = await this.deps.parseGltf(buf, url);
        this.ready.set(e.file, g);
        return g;
      });
      this.files.set(e.file, p);
      p.catch(() => this.files.delete(e.file)); // failed loads can be retried later
    }
    return p;
  }

  private fetchBytes(id: string, url: string, onBytes?: (n: number) => void): Promise<ArrayBuffer> {
    return this.withRetry(id, async () => {
      const res = await this.deps.fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      if (!onBytes || !res.body) return res.arrayBuffer();
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        n += value.byteLength;
        onBytes(n);
      }
      const out = new Uint8Array(n);
      let o = 0;
      for (const c of chunks) {
        out.set(c, o);
        o += c.byteLength;
      }
      return out.buffer;
    });
  }

  private async withRetry<T>(id: string, fn: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        if (attempt < this.retries) await this.deps.sleep(250 * 2 ** attempt);
      }
    }
    throw new AssetError(`failed to load "${id}": ${(last as Error)?.message ?? last}`, id);
  }
}

// ───────────────────────────── default browser instance ─────────────────────────────

export function browserDeps(): LoaderDeps {
  const gltf = new GLTFLoader();
  gltf.setMeshoptDecoder(MeshoptDecoder);
  const tex = new TextureLoader();
  return {
    fetch: (u) => fetch(u),
    parseGltf: (buf, url) =>
      new Promise((resolve, reject) =>
        gltf.parse(buf, url.slice(0, url.lastIndexOf('/') + 1), (g) => resolve(g), reject),
      ),
    clone: (o) => skeletonClone(o),
    loadTexture: (u) => tex.loadAsync(u),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

let defaultLoader: AssetLoader | null = null;

/** Lazily created loader rooted at `${BASE_URL}assets/`. */
export function assets(): AssetLoader {
  defaultLoader ??= new AssetLoader(`${import.meta.env?.BASE_URL ?? '/'}assets/`, browserDeps());
  return defaultLoader;
}

export const loadManifest = () => assets().loadManifest();
export const loadAsset = (id: string) => assets().loadAsset(id);
export const getClip = (id: string, name: string) => assets().getClip(id, name);
export const preload = (ids: readonly string[], onProgress?: (p: LoadProgress) => void) =>
  assets().preload(ids, onProgress);
export const loadTexture = (id: string) => assets().loadTexture(id);

/** Find a socket node (e.g. 'socket_crystal') inside a loaded instance. */
export function socket(root: Object3D, name: string): Object3D | null {
  return root.getObjectByName(name) ?? null;
}
