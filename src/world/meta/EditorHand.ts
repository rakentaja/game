/**
 * The Editor's Hand: a giant pencil-sketched hand pinching an eraser descends onto the page,
 * rubs a strip of the panel back to blank paper along a spline (history zeroed, re-inkable) and
 * withdraws — ≈4 s, started by a level trigger (LevelDef.editorHands). Never inked: its material
 * is the unprinted pencil look, so it reads as the artist's hand, not part of the world.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GameContext, Vec2T } from '../../core/types';
import { TUNING } from '../../data/tuning';

interface StripReveal {
  clearStrip(ax: number, az: number, bx: number, bz: number, halfWidth: number): void;
}

function canClear(r: unknown): r is StripReveal {
  return typeof (r as StripReveal).clearStrip === 'function';
}

/** Hand + eraser geometry in hand space (eraser contact point at the origin, palm above). */
function handGeometry(): { hand: THREE.BufferGeometry; eraser: THREE.BufferGeometry } {
  const parts: THREE.BufferGeometry[] = [];
  const put = (g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s = 1) => {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(s, s, s),
    );
    g.applyMatrix4(m);
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  // palm (slightly tilted, back of the hand up)
  put(new THREE.BoxGeometry(0.62, 0.2, 0.7, 2, 1, 2), 0, 0.62, 0.12, -0.35);
  // four fingers curling down toward the eraser
  for (let i = 0; i < 4; i++) {
    const x = -0.24 + i * 0.16;
    const len = i === 0 || i === 3 ? 0.34 : 0.42;
    put(new THREE.CapsuleGeometry(0.06, len, 3, 6), x, 0.42, -0.22, 0.9);
    put(new THREE.CapsuleGeometry(0.055, len * 0.7, 3, 6), x, 0.2, -0.32, 0.2);
  }
  // thumb pinching from the side
  put(new THREE.CapsuleGeometry(0.07, 0.34, 3, 6), 0.36, 0.3, 0.02, 0.2, 0, 0.9);
  // wrist / cuff running up out of frame
  put(new THREE.CylinderGeometry(0.26, 0.3, 1.6, 8, 1, true), 0, 1.35, 0.55, -0.55);
  const hand = mergeGeometries(parts)!;
  for (const p of parts) p.dispose();
  const eraser = new THREE.BoxGeometry(0.7, 0.24, 0.34, 2, 1, 1);
  eraser.translate(0, 0.12, -0.18);
  return { hand, eraser };
}

export class EditorHand {
  readonly object = new THREE.Group();
  private readonly curve: THREE.CatmullRomCurve3;
  private readonly geo: { hand: THREE.BufferGeometry; eraser: THREE.BufferGeometry };
  private readonly mats: THREE.ShaderMaterial[] = [];
  private readonly p = new THREE.Vector3();
  private readonly tan = new THREE.Vector3();
  private disposeOutline: (() => void) | null = null;
  private t = -1;
  private lastX = 0;
  private lastZ = 0;
  private sweeping = false;
  done = false;

  constructor(
    private readonly ctx: GameContext,
    path: readonly Vec2T[],
    private readonly groundY: (x: number, z: number) => number,
  ) {
    this.curve = new THREE.CatmullRomCurve3(
      path.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      false,
      'centripetal',
    );
    this.geo = handGeometry();
    const pencil = ctx.render.createInkMaterial({ ramp: 'staff', reveal: false, printed: 0, sketch: 1 });
    const rubber = ctx.render.createInkMaterial({ ramp: 'red', reveal: false, printed: 0, sketch: 1 });
    this.mats.push(pencil, rubber);
    const inner = new THREE.Group();
    inner.add(new THREE.Mesh(this.geo.hand, pencil), new THREE.Mesh(this.geo.eraser, rubber));
    inner.scale.setScalar(TUNING.worldMeta.editorHand.scale);
    this.object.add(inner);
    this.object.name = 'editor-hand';
    this.object.visible = false;
    ctx.render.scene.add(this.object);
    try {
      this.disposeOutline = ctx.render.addOutline(this.object, 2.2);
    } catch {
      this.disposeOutline = null;
    }
  }

  get active(): boolean {
    return this.t >= 0 && !this.done;
  }

  start(): void {
    if (this.t >= 0) return;
    this.t = 0;
    this.object.visible = true;
    this.curve.getPoint(0, this.p);
    this.lastX = this.p.x;
    this.lastZ = this.p.z;
    this.place(0, 1);
  }

  update(dt: number): void {
    if (!this.active) return;
    const H = TUNING.worldMeta.editorHand;
    this.t += dt;
    const sweepS = Math.max(0.1, H.duration - H.descend - H.withdraw);
    if (this.t < H.descend) {
      const k = this.t / H.descend;
      this.place(0, 1 - k * k * (3 - 2 * k));
    } else if (this.t < H.descend + sweepS) {
      if (!this.sweeping) {
        this.sweeping = true;
        this.ctx.events.emit('sfx:play', { id: 'eraser_sweep', volume: 0.8 });
        this.ctx.events.emit('fx:shake', { intensity: 0.25, duration: 0.25 });
      }
      const u = (this.t - H.descend) / sweepS;
      const e = u * u * (3 - 2 * u);
      this.place(e, Math.abs(Math.sin(u * Math.PI * 6)) * 0.012);
      const reveal = this.ctx.reveal;
      if (canClear(reveal)) reveal.clearStrip(this.lastX, this.lastZ, this.p.x, this.p.z, H.halfWidth);
      this.lastX = this.p.x;
      this.lastZ = this.p.z;
    } else if (this.t < H.duration) {
      const k = (this.t - H.descend - sweepS) / H.withdraw;
      this.place(1, k * k);
    } else {
      this.done = true;
      this.object.visible = false;
    }
  }

  /** u along the spline, lift 0 (touching) … 1 (high above, out of frame). */
  private place(u: number, lift: number): void {
    this.curve.getPoint(u, this.p);
    this.curve.getTangent(Math.min(0.999, Math.max(0.001, u)), this.tan);
    const y = this.groundY(this.p.x, this.p.z);
    this.object.position.set(this.p.x, y + lift * 16, this.p.z);
    // eraser's long side across the stroke, hand leaning back along it
    this.object.rotation.set(0, Math.atan2(this.tan.x, this.tan.z) + Math.PI, 0);
  }

  dispose(): void {
    this.disposeOutline?.();
    this.object.removeFromParent();
    this.geo.hand.dispose();
    this.geo.eraser.dispose();
    for (const m of this.mats) m.dispose();
  }
}
