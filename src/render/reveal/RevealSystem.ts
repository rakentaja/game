import * as THREE from 'three';
import type { RevealAPI } from '../../core/types';
import { TUNING } from '../../data/tuning';
import { noiseData, noiseTexture } from '../noise';
import {
  circleField,
  combineField,
  historyField,
  MAX_SOURCES_GLSL,
  type RevealNoiseParams,
  revealOffset,
  smooth01,
  stampValue,
} from './revealMath';

interface Source {
  handle: number;
  x: number;
  z: number;
  r: number;
  life: number;
  age: number;
  alive: boolean;
}

/**
 * The ink reveal mask. CPU-authoritative: the history map is kept on the CPU (Float32 master +
 * RG8 mirror uploaded as a DataTexture), so `revealAt` samples exactly the bytes the GPU sees and
 * no readback is ever needed. See docs/DECISIONS.md (render, reveal history).
 */
export class RevealSystem implements RevealAPI {
  readonly center = new THREE.Vector3();
  radius: number = TUNING.crystal.radiusIdle;
  targetRadius: number = TUNING.crystal.radiusIdle;
  blankPage = 0;
  /** Disable history stamping/sampling (Low quality). */
  historyEnabled = true;

  readonly uniforms: Record<string, THREE.IUniform>;

  private readonly noise = noiseData();
  private readonly size: number;
  private readonly hist: Float32Array;
  private readonly bytes: Uint8Array;
  private readonly histTex: THREE.DataTexture;
  private histMinX: number;
  private histMinZ: number;
  private histWorld: number;
  private histDirty = false;
  private stampAcc = 0;
  private fadeAcc = 0;
  private readonly sources: Source[] = [];
  private nextHandle = 1;
  private time = 0;
  private growth = 0;
  private readonly np: RevealNoiseParams = { scale: 3, amp: 0.6, seep: 0, time: 0, growth: 0, fingers: 0 };
  private readonly srcVecs: THREE.Vector4[];

  constructor(size: number = TUNING.quality.revealHistorySize) {
    this.size = size;
    this.hist = new Float32Array(size * size);
    this.bytes = new Uint8Array(size * size * 2);
    this.histTex = new THREE.DataTexture(this.bytes, size, size, THREE.RGFormat, THREE.UnsignedByteType);
    this.histTex.magFilter = this.histTex.minFilter = THREE.LinearFilter;
    this.histTex.wrapS = this.histTex.wrapT = THREE.ClampToEdgeWrapping;
    this.histTex.generateMipmaps = false;
    this.histTex.flipY = false;
    this.histTex.colorSpace = THREE.NoColorSpace;
    this.histTex.unpackAlignment = 1;
    this.histTex.needsUpdate = true;
    this.histWorld = TUNING.reveal.historyWorldSize;
    this.histMinX = -this.histWorld / 2;
    this.histMinZ = -this.histWorld / 2;
    for (let i = 0; i < TUNING.reveal.maxSources; i++) {
      this.sources.push({ handle: 0, x: 0, z: 0, r: 0, life: 0, age: 0, alive: false });
    }
    this.srcVecs = [];
    for (let i = 0; i < MAX_SOURCES_GLSL; i++) this.srcVecs.push(new THREE.Vector4());
    this.uniforms = {
      uNoise: { value: noiseTexture() },
      uRevealCenter: { value: this.center },
      uRevealRadius: { value: this.radius },
      uRevealEdge: { value: TUNING.crystal.edgeWidth },
      uRevealAmp: { value: TUNING.crystal.fbmAmp },
      uRevealScale: { value: TUNING.crystal.fbmScale },
      uRevealTime: { value: 0 },
      uRevealSeep: { value: TUNING.reveal.seepSpeed },
      uRevealGrowth: { value: 0 },
      uRevealFingers: { value: TUNING.reveal.growthFingers },
      uRevealBlank: { value: 0 },
      uRevealHist: { value: this.histTex },
      uRevealHistRect: { value: new THREE.Vector4(this.histMinX, this.histMinZ, 1 / this.histWorld, 1) },
      uRevealSources: { value: this.srcVecs },
      uRevealSourceCount: { value: 0 },
    };
  }

  /** World rect covered by the 256² history map. Clears history. */
  setHistoryBounds(minX: number, minZ: number, worldSize: number): void {
    this.histMinX = minX;
    this.histMinZ = minZ;
    this.histWorld = worldSize;
    (this.uniforms.uRevealHistRect!.value as THREE.Vector4).set(minX, minZ, 1 / worldSize, 1);
    this.clearHistory();
  }

  addSource(x: number, z: number, radius: number, life: number): number {
    let slot = this.sources.find((s) => !s.alive);
    if (!slot) {
      // Recycle the oldest relative to its life.
      slot = this.sources[0]!;
      for (const s of this.sources) if (s.age / s.life > slot.age / slot.life) slot = s;
    }
    slot.handle = this.nextHandle++;
    slot.x = x;
    slot.z = z;
    slot.r = radius;
    slot.life = Math.max(0.01, life);
    slot.age = 0;
    slot.alive = true;
    this.syncSources();
    return slot.handle;
  }

  removeSource(handle: number): void {
    for (const s of this.sources) if (s.alive && s.handle === handle) s.alive = false;
    this.syncSources();
  }

  /** Effective animated radius of a source (ease-in, shrink over the last `sourceFadeFrac`). */
  private sourceRadius(s: Source): number {
    const grow = TUNING.reveal.sourceGrowS;
    const fade = TUNING.reveal.sourceFadeFrac;
    const gin = grow > 0 ? Math.min(1, s.age / grow) : 1;
    const easeIn = 1 - (1 - gin) * (1 - gin) * (1 - gin);
    const left = 1 - s.age / s.life;
    const out = fade > 0 ? Math.min(1, left / fade) : 1;
    const easeOut = out * out * (3 - 2 * out);
    return s.r * easeIn * easeOut;
  }

  private syncSources(): void {
    let n = 0;
    for (const s of this.sources) {
      if (!s.alive || n >= MAX_SOURCES_GLSL) continue;
      this.srcVecs[n]!.set(s.x, s.z, this.sourceRadius(s), 0);
      n++;
    }
    for (let i = n; i < MAX_SOURCES_GLSL; i++) this.srcVecs[i]!.set(0, 0, -100, 0);
    this.uniforms.uRevealSourceCount!.value = n;
  }

  eraseStrip(ax: number, az: number, bx: number, bz: number, halfWidth: number): void {
    const N = this.size;
    const ts = this.histWorld / N;
    const pad = halfWidth + ts * 2;
    const i0 = Math.max(1, Math.floor((Math.min(ax, bx) - pad - this.histMinX) / ts));
    const i1 = Math.min(N - 2, Math.ceil((Math.max(ax, bx) + pad - this.histMinX) / ts));
    const j0 = Math.max(1, Math.floor((Math.min(az, bz) - pad - this.histMinZ) / ts));
    const j1 = Math.min(N - 2, Math.ceil((Math.max(az, bz) + pad - this.histMinZ) / ts));
    const abx = bx - ax;
    const abz = bz - az;
    const len2 = abx * abx + abz * abz || 1e-6;
    for (let j = j0; j <= j1; j++) {
      const wz = this.histMinZ + (j + 0.5) * ts;
      for (let i = i0; i <= i1; i++) {
        const wx = this.histMinX + (i + 0.5) * ts;
        let t = ((wx - ax) * abx + (wz - az) * abz) / len2;
        t = t < 0 ? 0 : Math.min(t, 1);
        const dx = wx - (ax + abx * t);
        const dz = wz - (az + abz * t);
        const d = Math.sqrt(dx * dx + dz * dz);
        const e = smooth01((halfWidth - d) / (ts * 1.5) + 0.5);
        if (e <= 0) continue;
        const k = j * N + i;
        const cur = this.bytes[k * 2 + 1]! / 255;
        if (e > cur) this.bytes[k * 2 + 1] = Math.round(e * 255);
        this.hist[k] = this.hist[k]! * (1 - e);
        this.bytes[k * 2] = Math.round(this.hist[k]! * 255);
      }
    }
    this.histTex.needsUpdate = true;
  }

  private clearHistory(): void {
    this.hist.fill(0);
    this.bytes.fill(0);
    this.histTex.needsUpdate = true;
  }

  update(dt: number): void {
    const C = TUNING.crystal;
    const R = TUNING.reveal;
    this.time += dt;
    const prev = this.radius;
    const tau = this.targetRadius > this.radius ? C.growTime : C.shrinkTime;
    const k = tau > 0 ? 1 - Math.exp((-dt * 4.6) / tau) : 1;
    this.radius += (this.targetRadius - this.radius) * k;
    if (Math.abs(this.targetRadius - this.radius) < 1e-4) this.radius = this.targetRadius;
    const span = Math.max(0.5, (C.radiusHeld - C.radiusIdle) / Math.max(0.05, C.growTime));
    const g = dt > 0 ? Math.max(0, (this.radius - prev) / dt / span) : 0;
    this.growth += (Math.min(1, g * 1.6) - this.growth) * (1 - Math.exp(-dt * 8));

    for (const s of this.sources) {
      if (!s.alive) continue;
      s.age += dt;
      if (s.age >= s.life) s.alive = false;
    }
    this.syncSources();

    if (this.historyEnabled) {
      this.fadeAcc += dt;
      this.stampAcc += dt;
      const stepS = 1 / R.historyStampHz;
      if (this.stampAcc >= stepS) {
        this.fadeHistory(this.fadeAcc * R.historyFadePerSec);
        this.stamp(this.center.x, this.center.z, this.radius);
        this.fadeAcc = 0;
        this.stampAcc %= stepS;
        this.histDirty = true;
      }
    }
    if (this.histDirty) {
      this.histTex.needsUpdate = true;
      this.histDirty = false;
    }

    const u = this.uniforms;
    u.uRevealRadius!.value = this.radius;
    u.uRevealTime!.value = this.time;
    u.uRevealGrowth!.value = this.growth;
    u.uRevealBlank!.value = this.blankPage;
    u.uRevealEdge!.value = C.edgeWidth;
    u.uRevealAmp!.value = C.fbmAmp;
    u.uRevealScale!.value = C.fbmScale;
    u.uRevealSeep!.value = R.seepSpeed;
    u.uRevealFingers!.value = R.growthFingers;
    (u.uRevealHistRect!.value as THREE.Vector4).w = this.historyEnabled ? 1 : 0;
  }

  private fadeHistory(amount: number): void {
    if (amount <= 0) return;
    const h = this.hist;
    const b = this.bytes;
    for (let k = 0; k < h.length; k++) {
      const v = h[k]!;
      if (v <= 0) continue;
      const nv = v - amount;
      h[k] = Math.max(nv, 0);
      b[k * 2] = Math.round(h[k]! * 255);
    }
  }

  private stamp(cx: number, cz: number, r: number): void {
    const N = this.size;
    const ts = this.histWorld / N;
    const edge = TUNING.crystal.edgeWidth;
    const reach = r + edge;
    const i0 = Math.max(1, Math.floor((cx - reach - this.histMinX) / ts));
    const i1 = Math.min(N - 2, Math.ceil((cx + reach - this.histMinX) / ts));
    const j0 = Math.max(1, Math.floor((cz - reach - this.histMinZ) / ts));
    const j1 = Math.min(N - 2, Math.ceil((cz + reach - this.histMinZ) / ts));
    for (let j = j0; j <= j1; j++) {
      const dz = this.histMinZ + (j + 0.5) * ts - cz;
      for (let i = i0; i <= i1; i++) {
        const dx = this.histMinX + (i + 0.5) * ts - cx;
        const v = stampValue(Math.sqrt(dx * dx + dz * dz), r, edge);
        const k = j * N + i;
        if (v <= this.hist[k]!) continue;
        // Erased texels never re-ink.
        const e = this.bytes[k * 2 + 1]! / 255;
        const nv = v * (1 - e);
        if (nv <= this.hist[k]!) continue;
        this.hist[k] = nv;
        this.bytes[k * 2] = Math.round(nv * 255);
      }
    }
  }

  /** Bilinear sample (ClampToEdge, LINEAR) of the uploaded RG8 history, channel 0/1. */
  private sampleHist(x: number, z: number, ch: number): number {
    const N = this.size;
    const fx = ((x - this.histMinX) / this.histWorld) * N - 0.5;
    const fz = ((z - this.histMinZ) / this.histWorld) * N - 0.5;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const c = (v: number) => (v < 0 ? 0 : Math.min(v, N - 1));
    const x0 = c(ix);
    const x1 = c(ix + 1);
    const z0 = c(iz);
    const z1 = c(iz + 1);
    const b = this.bytes;
    const a00 = b[(z0 * N + x0) * 2 + ch]!;
    const a10 = b[(z0 * N + x1) * 2 + ch]!;
    const a01 = b[(z1 * N + x0) * 2 + ch]!;
    const a11 = b[(z1 * N + x1) * 2 + ch]!;
    const top = a00 + (a10 - a00) * tx;
    const bot = a01 + (a11 - a01) * tx;
    return (top + (bot - top) * tz) / 255;
  }

  /** Pre-smoothstep field (see revealMath). Exposed for tests / debug overlay. */
  fieldAt(x: number, z: number): number {
    const C = TUNING.crystal;
    const np = this.np;
    np.scale = C.fbmScale;
    np.amp = C.fbmAmp;
    np.seep = TUNING.reveal.seepSpeed;
    np.time = this.time;
    np.growth = this.growth;
    np.fingers = TUNING.reveal.growthFingers;
    const edge = C.edgeWidth;
    const n = revealOffset(this.noise, x, z, np);
    const prim = circleField(x - this.center.x, z - this.center.z, this.radius, n, edge);
    let sec = -1;
    const count = this.uniforms.uRevealSourceCount!.value as number;
    for (let i = 0; i < count; i++) {
      const s = this.srcVecs[i]!;
      sec = Math.max(sec, circleField(x - s.x, z - s.y, s.z, n, edge));
    }
    let erase = 0;
    if (this.historyEnabled) {
      sec = Math.max(sec, historyField(this.sampleHist(x, z, 0), n, edge));
      erase = this.sampleHist(x, z, 1);
    }
    return combineField(prim, sec, this.blankPage, erase);
  }

  revealAt(x: number, z: number): number {
    return smooth01(this.fieldAt(x, z));
  }

  isRevealed(x: number, z: number): boolean {
    return this.fieldAt(x, z) > 0.5;
  }

  reset(): void {
    this.radius = this.targetRadius = TUNING.crystal.radiusIdle;
    this.blankPage = 0;
    this.growth = 0;
    for (const s of this.sources) s.alive = false;
    this.syncSources();
    this.clearHistory();
  }

  /** Force a GPU re-upload (after WebGL context restore). */
  markDirty(): void {
    this.histTex.needsUpdate = true;
  }

  dispose(): void {
    this.histTex.dispose();
  }
}
