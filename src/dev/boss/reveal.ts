/**
 * DEV HARNESS ONLY — stand-in RevealAPI: printed-history map over the arena (1 = printed,
 * 0 = erased by the Editor), crystal circle, temporary sources, Blank Page override.
 */
import * as THREE from 'three';
import type { RevealAPI } from '../../core/types';

const N = 256;
const SIZE = 44; // metres covered by the history map
const MAX_SRC = 8;

export class StubReveal implements RevealAPI {
  readonly center = new THREE.Vector3();
  radius = 3;
  targetRadius = 3;
  blankPage = 0;
  private hist = new Uint8Array(N * N).fill(255);
  private tex = new THREE.DataTexture(this.hist, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  private origin = new THREE.Vector2(-SIZE / 2, -SIZE / 2 + 1);
  private sources: THREE.Vector4[] = [];
  private life = new Float32Array(MAX_SRC);
  private life0 = new Float32Array(MAX_SRC);
  readonly uniforms: Record<string, THREE.IUniform>;
  private dirty = true;

  constructor() {
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;
    for (let i = 0; i < MAX_SRC; i++) this.sources.push(new THREE.Vector4(0, 0, 0, 0));
    this.uniforms = {
      uHist: { value: this.tex },
      uHistRect: { value: new THREE.Vector4(this.origin.x, this.origin.y, SIZE, SIZE) },
      uRevealCenter: { value: this.center },
      uRevealRadius: { value: this.radius },
      uBlank: { value: 0 },
      uSources: { value: this.sources },
    };
  }

  addSource(x: number, z: number, radius: number, life: number): number {
    let best = 0;
    for (let i = 0; i < MAX_SRC; i++) if (this.life[i]! < this.life[best]!) best = i;
    this.sources[best]!.set(x, z, radius, 1);
    this.life[best] = life;
    this.life0[best] = life;
    return best;
  }
  removeSource(h: number): void {
    if (this.sources[h]) {
      this.sources[h].z = 0;
      this.life[h] = 0;
    }
  }

  eraseStrip(ax: number, az: number, bx: number, bz: number, hw: number): void {
    const s = N / SIZE;
    const minX = Math.floor((Math.min(ax, bx) - hw - this.origin.x) * s);
    const maxX = Math.ceil((Math.max(ax, bx) + hw - this.origin.x) * s);
    const minY = Math.floor((Math.min(az, bz) - hw - this.origin.y) * s);
    const maxY = Math.ceil((Math.max(az, bz) + hw - this.origin.y) * s);
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    for (let y = Math.max(0, minY); y <= Math.min(N - 1, maxY); y++) {
      for (let x = Math.max(0, minX); x <= Math.min(N - 1, maxX); x++) {
        const px = this.origin.x + (x + 0.5) / s;
        const pz = this.origin.y + (y + 0.5) / s;
        let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
        t = t < 0 ? 0 : Math.min(t, 1);
        const qx = ax + dx * t - px;
        const qz = az + dz * t - pz;
        const d = Math.sqrt(qx * qx + qz * qz);
        // ragged eraser edge
        const rag = Math.sin(px * 3.1 + pz * 1.7) * 0.12 + Math.sin(px * 7.3 - pz * 5.1) * 0.06;
        const v = Math.min(1, Math.max(0, (d - (hw + rag) + 0.15) / 0.3));
        const i = y * N + x;
        const nv = Math.min(this.hist[i]!, Math.round(v * 255));
        if (nv !== this.hist[i]) {
          this.hist[i] = nv;
          this.dirty = true;
        }
      }
    }
  }

  private histAt(x: number, z: number): number {
    const s = N / SIZE;
    const ix = Math.floor((x - this.origin.x) * s);
    const iy = Math.floor((z - this.origin.y) * s);
    if (ix < 0 || iy < 0 || ix >= N || iy >= N) return 1;
    return this.hist[iy * N + ix]! / 255;
  }

  revealAt(x: number, z: number): number {
    let m = this.histAt(x, z) * (1 - this.blankPage);
    const d = Math.hypot(x - this.center.x, z - this.center.z);
    m = Math.max(m, Math.min(1, Math.max(0, (this.radius - d) / 0.9)));
    for (const s of this.sources) {
      if (s.z <= 0) continue;
      const ds = Math.hypot(x - s.x, z - s.y);
      m = Math.max(m, Math.min(1, Math.max(0, (s.z - ds) / 0.6)) * s.w);
    }
    return m;
  }
  isRevealed(x: number, z: number): boolean {
    return this.revealAt(x, z) > 0.5;
  }

  update(dt: number): void {
    const k = this.targetRadius > this.radius ? 0.6 : 1.4;
    this.radius += (this.targetRadius - this.radius) * Math.min(1, (dt / k) * 3);
    this.uniforms.uRevealRadius!.value = this.radius;
    this.uniforms.uBlank!.value = this.blankPage;
    for (let i = 0; i < MAX_SRC; i++) {
      if (this.life[i]! > 0) {
        this.life[i]! -= dt;
        this.sources[i]!.w = Math.min(1, Math.max(0, this.life[i]! / Math.max(0.01, this.life0[i]! * 0.4)));
        if (this.life[i]! <= 0) this.sources[i]!.z = 0;
      }
    }
    if (this.dirty) {
      this.tex.needsUpdate = true;
      this.dirty = false;
    }
  }

  reset(): void {
    this.hist.fill(255);
    this.dirty = true;
    this.blankPage = 0;
  }
}
