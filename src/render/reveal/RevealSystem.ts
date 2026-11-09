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

/** Texels per side of a reclaim region. */
const REGION = 16;
/** Side of the coarse grid sampled by `inkedFraction`. */
const PROGRESS_N = 64;

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
  /**
   * Co-op: the partner's crystal (slot 1). Counts as a second *primary* source (survives the
   * Blank Page, stamps history). src/coop/puppet.ts `crystalView` wraps it as a RevealAPI.
   */
  readonly center2 = new THREE.Vector3();
  radius2: number = TUNING.crystal.radiusIdle;
  targetRadius2: number = TUNING.crystal.radiusIdle;
  private dual = false;
  /** Disable history stamping/sampling (Low quality). */
  historyEnabled = true;

  readonly uniforms: Record<string, THREE.IUniform>;

  private readonly noise = noiseData();
  /** @internal */
  readonly size: number;
  /** @internal */
  readonly hist: Float32Array;
  /** @internal */
  readonly bytes: Uint8Array;
  /** @internal */
  readonly histTex: THREE.DataTexture;
  private histMinX: number;
  private histMinZ: number;
  private histWorld: number;
  private histDirty = false;
  private stampAcc = 0;
  private fadeAcc = 0;
  private readonly sources: Source[] = [];
  private nextHandle = 1;
  /** @internal */
  time = 0;
  private growth = 0;
  private readonly np: RevealNoiseParams = { scale: 3, amp: 0.6, seep: 0, time: 0, growth: 0, fingers: 0 };
  private readonly srcVecs: THREE.Vector4[];
  /** 1 = permanent texel (kills, dash trails, prints): skipped by the regular fade. */
  /** @internal */
  readonly perm: Uint8Array;
  /** Per-region (REGION² texels) sim time of the last ink stamp, for blank-paper reclaim. */
  /** @internal */
  readonly regionLast: Float32Array;
  private readonly regions: number;
  private reclaimAcc = 0;
  /** Reclaim strength multiplier (difficulty / daily rules). 0 disables reclaim. */
  reclaimMul = 1;
  /** Coarse PROGRESS_N² mask of cells that count toward `inkedFraction` (walkable area). */
  private readonly progressMask: Uint8Array;
  private progressTotal: number;
  /** Temporary radius cap ("AND THEN THE CRYSTAL WENT OUT"). */
  private radiusCap = Number.POSITIVE_INFINITY;
  private radiusCapT = 0;

  constructor(size: number = TUNING.quality.revealHistorySize) {
    this.size = size;
    this.hist = new Float32Array(size * size);
    this.bytes = new Uint8Array(size * size * 2);
    this.perm = new Uint8Array(size * size);
    this.regions = Math.max(1, Math.ceil(size / REGION));
    this.regionLast = new Float32Array(this.regions * this.regions);
    this.progressMask = new Uint8Array(PROGRESS_N * PROGRESS_N).fill(1);
    this.progressTotal = PROGRESS_N * PROGRESS_N;
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
      uRevealCenter2: { value: this.center2 },
      uRevealRadius2: { value: this.radius2 },
      uRevealDual: { value: 0 },
    };
  }

  /** Co-op: enable / disable the second crystal. */
  setDual(on: boolean): void {
    this.dual = on;
    this.uniforms.uRevealDual!.value = on ? 1 : 0;
    if (!on) this.radius2 = this.targetRadius2 = TUNING.crystal.radiusIdle;
  }

  get dualActive(): boolean {
    return this.dual;
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
    this.strip(ax, az, bx, bz, halfWidth, true);
  }

  /**
   * Blank a strip back to paper (history and permanence zeroed) WITHOUT the eraser's
   * never-re-ink mark: the player can ink it again (Editor's Hand).
   */
  clearStrip(ax: number, az: number, bx: number, bz: number, halfWidth: number): void {
    this.strip(ax, az, bx, bz, halfWidth, false);
  }

  /**
   * Permanent ink (The Ink Remembers): stamps a circle the regular fade never removes — only
   * blank-paper reclaim (long-unvisited regions) or an erase can. No-op without history (Low).
   */
  stampPermanent(x: number, z: number, r: number): void {
    if (!this.historyEnabled || r <= 0) return;
    this.stamp(x, z, r, true);
    this.histDirty = true;
  }

  /** Permanent capsule along a→b (dash trails). */
  stampSegmentPermanent(ax: number, az: number, bx: number, bz: number, r: number): void {
    if (!this.historyEnabled || r <= 0) return;
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / Math.max(0.2, r * 0.5)));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      this.stamp(ax + (bx - ax) * t, az + (bz - az) * t, r, true);
    }
    this.histDirty = true;
  }

  /** True if the texel under (x,z) is permanent ink (tests / debug). */
  isPermanent(x: number, z: number): boolean {
    const k = this.texelIndex(x, z);
    return k >= 0 && this.perm[k] === 1;
  }

  /** Raw stamped history value 0..1 at the texel under (x,z) (tests / debug). */
  historyAt(x: number, z: number): number {
    const k = this.texelIndex(x, z);
    return k >= 0 ? this.hist[k]! : 0;
  }

  private texelIndex(x: number, z: number): number {
    const N = this.size;
    const i = Math.floor(((x - this.histMinX) / this.histWorld) * N);
    const j = Math.floor(((z - this.histMinZ) / this.histWorld) * N);
    if (i < 0 || j < 0 || i >= N || j >= N) return -1;
    return j * N + i;
  }

  /** Collapse the crystal to at most `r` metres for `seconds` (caption effect). */
  capRadius(r: number, seconds: number): void {
    this.radiusCap = Math.max(0, r);
    this.radiusCapT = Math.max(0, seconds);
  }

  get radiusCapped(): boolean {
    return this.radiusCapT > 0;
  }

  /** Free (dead) source slots; ambient effects (rain) only spend slots when plenty are free. */
  freeSources(): number {
    let n = 0;
    for (const s of this.sources) if (!s.alive) n++;
    return n;
  }

  /**
   * Restrict `inkedFraction` to cells where `inside(x, z)` (walkable area). Sampled on a coarse
   * grid once per page; call after `setHistoryBounds`. `null` counts every cell.
   */
  setProgressMask(inside: ((x: number, z: number) => boolean) | null): void {
    const P = PROGRESS_N;
    const cell = this.histWorld / P;
    let total = 0;
    for (let j = 0; j < P; j++)
      for (let i = 0; i < P; i++) {
        const inn = !inside || inside(this.histMinX + (i + 0.5) * cell, this.histMinZ + (j + 0.5) * cell);
        this.progressMask[j * P + i] = inn ? 1 : 0;
        if (inn) total++;
      }
    this.progressTotal = total;
  }

  /** Fraction (0..1) of the masked page currently inked (history above the revealed threshold). */
  inkedFraction(): number {
    if (this.progressTotal <= 0) return 0;
    const P = PROGRESS_N;
    const N = this.size;
    const step = N / P;
    let n = 0;
    for (let j = 0; j < P; j++) {
      const row = Math.min(N - 1, Math.floor((j + 0.5) * step)) * N;
      for (let i = 0; i < P; i++) {
        if (!this.progressMask[j * P + i]) continue;
        if (this.hist[row + Math.min(N - 1, Math.floor((i + 0.5) * step))]! > 0.5) n++;
      }
    }
    return n / this.progressTotal;
  }

  private strip(ax: number, az: number, bx: number, bz: number, halfWidth: number, mark: boolean): void {
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
        if (mark) {
          const cur = this.bytes[k * 2 + 1]! / 255;
          if (e > cur) this.bytes[k * 2 + 1] = Math.round(e * 255);
        }
        if (e > 0.5) this.perm[k] = 0;
        this.hist[k] = this.hist[k]! * (1 - e);
        this.bytes[k * 2] = Math.round(this.hist[k]! * 255);
      }
    }
    this.histTex.needsUpdate = true;
  }

  private clearHistory(): void {
    this.hist.fill(0);
    this.bytes.fill(0);
    this.perm.fill(0);
    this.regionLast.fill(this.time);
    this.histTex.needsUpdate = true;
  }

  update(dt: number): void {
    const C = TUNING.crystal;
    const R = TUNING.reveal;
    this.time += dt;
    const prev = this.radius;
    if (this.radiusCapT > 0) {
      this.radiusCapT -= dt;
      if (this.radiusCapT <= 0) this.radiusCap = Number.POSITIVE_INFINITY;
    }
    const target = Math.min(this.targetRadius, this.radiusCap);
    // a collapse snuffs fast (the ink "goes out"); everything else eases as tuned
    const tau = target > this.radius ? C.growTime : this.radiusCapT > 0 ? 0.25 : C.shrinkTime;
    const k = tau > 0 ? 1 - Math.exp((-dt * 4.6) / tau) : 1;
    this.radius += (target - this.radius) * k;
    if (Math.abs(target - this.radius) < 1e-4) this.radius = target;
    const span = Math.max(0.5, (C.radiusHeld - C.radiusIdle) / Math.max(0.05, C.growTime));
    const g = dt > 0 ? Math.max(0, (this.radius - prev) / dt / span) : 0;
    this.growth += (Math.min(1, g * 1.6) - this.growth) * (1 - Math.exp(-dt * 8));
    if (this.dual) {
      const t2 = Math.min(this.targetRadius2, this.radiusCap);
      const tau2 = t2 > this.radius2 ? C.growTime : this.radiusCapT > 0 ? 0.25 : C.shrinkTime;
      this.radius2 += (t2 - this.radius2) * (tau2 > 0 ? 1 - Math.exp((-dt * 4.6) / tau2) : 1);
      if (Math.abs(t2 - this.radius2) < 1e-4) this.radius2 = t2;
    }

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
        if (this.dual) this.stamp(this.center2.x, this.center2.z, this.radius2);
        this.fadeAcc = 0;
        this.stampAcc %= stepS;
        this.histDirty = true;
      }
      this.reclaimAcc += dt;
      if (this.reclaimAcc >= 1) {
        if (this.reclaim(this.reclaimAcc)) this.histDirty = true;
        this.reclaimAcc = 0;
      }
    }
    if (this.histDirty) {
      this.histTex.needsUpdate = true;
      this.histDirty = false;
    }

    const u = this.uniforms;
    u.uRevealRadius!.value = this.radius;
    u.uRevealRadius2!.value = this.radius2;
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
      if (v <= 0 || this.perm[k]) continue;
      const nv = v - amount;
      h[k] = Math.max(nv, 0);
      b[k * 2] = Math.round(h[k]! * 255);
    }
  }

  /**
   * Blank-paper reclaim: regions nobody re-inked for `reclaimAfterS` slowly whiten — permanent
   * ink included (a texel that reaches paper loses its permanence). Returns true if anything changed.
   */
  private reclaim(elapsed: number): boolean {
    const M = TUNING.worldMeta.inkMemory;
    const amount = elapsed * M.reclaimPerSec * this.reclaimMul;
    if (amount <= 0) return false;
    const N = this.size;
    const R = this.regions;
    let changed = false;
    for (let rj = 0; rj < R; rj++)
      for (let ri = 0; ri < R; ri++) {
        if (this.time - this.regionLast[rj * R + ri]! < M.reclaimAfterS) continue;
        const j1 = Math.min(N, (rj + 1) * REGION);
        const i1 = Math.min(N, (ri + 1) * REGION);
        for (let j = rj * REGION; j < j1; j++)
          for (let i = ri * REGION; i < i1; i++) {
            const k = j * N + i;
            const v = this.hist[k]!;
            if (v <= 0) continue;
            const nv = v - amount;
            if (nv <= 0) {
              this.hist[k] = 0;
              this.perm[k] = 0;
            } else this.hist[k] = nv;
            this.bytes[k * 2] = Math.round(this.hist[k]! * 255);
            changed = true;
          }
      }
    return changed;
  }

  private touchRegions(i0: number, i1: number, j0: number, j1: number): void {
    const R = this.regions;
    const r0 = Math.max(0, Math.floor(i0 / REGION));
    const r1 = Math.min(R - 1, Math.floor(i1 / REGION));
    const q0 = Math.max(0, Math.floor(j0 / REGION));
    const q1 = Math.min(R - 1, Math.floor(j1 / REGION));
    for (let q = q0; q <= q1; q++) for (let r = r0; r <= r1; r++) this.regionLast[q * R + r] = this.time;
  }

  private stamp(cx: number, cz: number, r: number, permanent = false): void {
    const N = this.size;
    const ts = this.histWorld / N;
    const edge = TUNING.crystal.edgeWidth;
    const reach = r + edge;
    const i0 = Math.max(1, Math.floor((cx - reach - this.histMinX) / ts));
    const i1 = Math.min(N - 2, Math.ceil((cx + reach - this.histMinX) / ts));
    const j0 = Math.max(1, Math.floor((cz - reach - this.histMinZ) / ts));
    const j1 = Math.min(N - 2, Math.ceil((cz + reach - this.histMinZ) / ts));
    if (i0 > i1 || j0 > j1) return;
    this.touchRegions(i0, i1, j0, j1);
    const permMin = TUNING.worldMeta.inkMemory.permanentMin;
    for (let j = j0; j <= j1; j++) {
      const dz = this.histMinZ + (j + 0.5) * ts - cz;
      for (let i = i0; i <= i1; i++) {
        const dx = this.histMinX + (i + 0.5) * ts - cx;
        const v = stampValue(Math.sqrt(dx * dx + dz * dz), r, edge);
        const k = j * N + i;
        if (v <= 0) continue;
        // Erased texels never re-ink.
        const e = this.bytes[k * 2 + 1]! / 255;
        const nv = v * (1 - e);
        if (permanent && nv >= permMin) this.perm[k] = 1;
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
    let prim = circleField(x - this.center.x, z - this.center.z, this.radius, n, edge);
    if (this.dual)
      prim = Math.max(prim, circleField(x - this.center2.x, z - this.center2.z, this.radius2, n, edge));
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
    this.radius2 = this.targetRadius2 = TUNING.crystal.radiusIdle;
    this.blankPage = 0;
    this.growth = 0;
    this.radiusCap = Number.POSITIVE_INFINITY;
    this.radiusCapT = 0;
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
