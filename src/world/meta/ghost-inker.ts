/** Ghost Inker playback silhouette (lazy chunk: only runs with a ghost enabled load it). */
import * as THREE from 'three';
import type { GameContext } from '../../core/types';
import { type GhostTrack, sampleTrack } from './ghost';

// ───────────── playback silhouette ─────────────

/** Translucent-reading pencil wizard: robe cone, head, hat, staff — dashed pencil, never inked. */
export class GhostInker {
  readonly object = new THREE.Group();
  private track: GhostTrack | null = null;
  private readonly mat: THREE.ShaderMaterial;
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly s = { x: 0, z: 0, yaw: 0 };
  private disposeOutline: (() => void) | null = null;

  constructor(private readonly ctx: GameContext) {
    this.mat = ctx.render.createInkMaterial({ ramp: 'staff', reveal: false, printed: 0, sketch: 0.7 });
    const part = (g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, rz = 0) => {
      this.geos.push(g);
      const m = new THREE.Mesh(g, this.mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, 0, rz);
      this.object.add(m);
    };
    part(new THREE.ConeGeometry(0.42, 1.15, 9, 1, true), 0, 0.58, 0);
    part(new THREE.SphereGeometry(0.2, 10, 8), 0, 1.3, 0);
    part(new THREE.ConeGeometry(0.3, 0.6, 9), 0, 1.68, 0, 0, -0.18);
    part(new THREE.CylinderGeometry(0.025, 0.03, 1.7, 5), 0.38, 0.85, 0.1, 0.05, -0.08);
    this.object.name = 'ghost-inker';
    this.object.visible = false;
    ctx.render.scene.add(this.object);
    try {
      this.disposeOutline = ctx.render.addOutline(this.object, 1.2);
    } catch {
      this.disposeOutline = null;
    }
  }

  setTrack(tr: GhostTrack | null): void {
    this.track = tr;
    this.object.visible = false;
  }

  get active(): boolean {
    return this.track !== null;
  }

  /** Page time t (s). Hides the ghost once its run ended or it's right on top of the player. */
  update(t: number, px: number, pz: number): void {
    const tr = this.track;
    if (!tr) return;
    const live = sampleTrack(tr, t, this.s);
    const near = (this.s.x - px) ** 2 + (this.s.z - pz) ** 2 < 0.5;
    this.object.visible = live && !near;
    if (!this.object.visible) return;
    const y = this.ctx.collision.groundHeight(this.s.x, this.s.z);
    this.object.position.set(this.s.x, y, this.s.z);
    this.object.rotation.y = this.s.yaw;
  }

  dispose(): void {
    this.disposeOutline?.();
    this.object.removeFromParent();
    for (const g of this.geos) g.dispose();
    this.mat.dispose();
  }
}
