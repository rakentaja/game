/**
 * Panel cuts (WOW #2): the frozen frame is re-shot by 2–3 cameras rendered into scissored
 * regions of the one colour RT; the post pass draws slanted ink frames, paper gutters, speed lines
 * and the onomatopoeia stamp. Timing runs on real time (the sim is frozen by the caller).
 */
import * as THREE from 'three';
import { MAX_PANELS } from './inkPost';

export interface PanelDef {
  /** Scissor rect in uv (x, y, w, h). */
  rect: THREE.Vector4;
  /** Convex quad inside rect, uv: bl, br, tr, tl. */
  quad: [THREE.Vector2, THREE.Vector2, THREE.Vector2, THREE.Vector2];
  camera: THREE.PerspectiveCamera;
  appearAt: number;
}

const easeOutBack = (t: number) => {
  const c1 = 1.9;
  const c3 = c1 + 1;
  const x = Math.min(1, Math.max(0, t));
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
};

function v2(x: number, y: number): THREE.Vector2 {
  return new THREE.Vector2(x, y);
}

type PanelSpec = { rect: readonly number[]; quad: readonly number[] };
const P_TOP: PanelSpec = {
  rect: [0.03, 0.47, 0.94, 0.5],
  quad: [0.03, 0.47, 0.97, 0.5, 0.97, 0.97, 0.03, 0.965],
};
const L_LEFT: PanelSpec = {
  rect: [0.02, 0.04, 0.58, 0.92],
  quad: [0.02, 0.04, 0.57, 0.04, 0.6, 0.96, 0.02, 0.95],
};
const LAYOUTS = {
  portrait2: [
    P_TOP,
    { rect: [0.03, 0.03, 0.94, 0.41], quad: [0.03, 0.03, 0.97, 0.035, 0.97, 0.44, 0.03, 0.41] },
  ],
  portrait3: [
    P_TOP,
    { rect: [0.03, 0.03, 0.55, 0.41], quad: [0.03, 0.03, 0.55, 0.03, 0.58, 0.425, 0.03, 0.41] },
    { rect: [0.58, 0.03, 0.39, 0.41], quad: [0.6, 0.03, 0.97, 0.035, 0.97, 0.44, 0.63, 0.426] },
  ],
  landscape2: [
    L_LEFT,
    { rect: [0.6, 0.04, 0.38, 0.92], quad: [0.6, 0.04, 0.98, 0.05, 0.98, 0.96, 0.63, 0.96] },
  ],
  landscape3: [
    L_LEFT,
    { rect: [0.6, 0.52, 0.38, 0.44], quad: [0.62, 0.53, 0.98, 0.51, 0.98, 0.96, 0.63, 0.96] },
    { rect: [0.59, 0.04, 0.39, 0.46], quad: [0.59, 0.04, 0.98, 0.05, 0.98, 0.48, 0.61, 0.5] },
  ],
} satisfies Record<string, PanelSpec[]>;

/** Portrait (primary) and landscape layouts. Rects never overlap → plain scissor is enough. */
export function panelLayout(aspect: number, count: number): readonly PanelSpec[] {
  if (aspect <= 1) return count === 2 ? LAYOUTS.portrait2 : LAYOUTS.portrait3;
  return count === 2 ? LAYOUTS.landscape2 : LAYOUTS.landscape3;
}

export class PanelCut {
  active = false;
  word = '';
  readonly focus = new THREE.Vector3();
  readonly panels: PanelDef[] = [];
  t = 0;
  duration = 0.6;
  count = 3;
  private readonly base = new THREE.PerspectiveCamera();
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();

  constructor() {
    for (let i = 0; i < MAX_PANELS; i++) {
      this.panels.push({
        rect: new THREE.Vector4(),
        quad: [v2(0, 0), v2(1, 0), v2(1, 1), v2(0, 1)],
        camera: new THREE.PerspectiveCamera(40, 1, 0.1, 80),
        appearAt: i * 0.07,
      });
    }
  }

  begin(
    word: string,
    focus: THREE.Vector3,
    durationS: number,
    main: THREE.PerspectiveCamera,
    count: number,
  ): void {
    this.active = true;
    this.word = word;
    this.focus.copy(focus);
    this.duration = durationS;
    this.count = Math.max(2, Math.min(MAX_PANELS, count));
    this.t = 0;
    this.base.copy(main);
    this.base.updateMatrixWorld();
  }

  /** Advance real time. Returns false when the cut has finished. */
  update(dt: number, aspect: number): boolean {
    if (!this.active) return false;
    this.t += dt;
    if (this.t >= this.duration) {
      this.active = false;
      return false;
    }
    const L = panelLayout(aspect, this.count);
    for (let i = 0; i < this.count; i++) {
      const p = this.panels[i]!;
      const l = L[i]!;
      p.rect.set(l.rect[0]!, l.rect[1]!, l.rect[2]!, l.rect[3]!);
      // slam-in: quad starts inset toward its centre and pops out with overshoot
      const k = easeOutBack((this.t - p.appearAt) / 0.13);
      const s = 0.82 + 0.18 * k;
      const cx = (l.quad[0]! + l.quad[2]! + l.quad[4]! + l.quad[6]!) / 4;
      const cy = (l.quad[1]! + l.quad[3]! + l.quad[5]! + l.quad[7]!) / 4;
      for (let c = 0; c < 4; c++) {
        const qx = l.quad[c * 2]!;
        const qy = l.quad[c * 2 + 1]!;
        p.quad[c]!.set(cx + (qx - cx) * s, cy + (qy - cy) * s);
      }
      this.aim(i, (l.rect[2]! / l.rect[3]!) * aspect);
    }
    return true;
  }

  shown(i: number): number {
    return this.active && i < this.count && this.t >= this.panels[i]!.appearAt ? 1 : 0;
  }

  /** Camera choreography: wide hold → low close-up → dutch extreme close-up. */
  private aim(i: number, aspect: number): void {
    const cam = this.panels[i]!.camera;
    const u = this.t / this.duration;
    const push = 1 - (1 - u) * (1 - u);
    const f = this.focus;
    cam.aspect = aspect;
    cam.near = this.base.near;
    cam.far = this.base.far;
    cam.up.set(0, 1, 0);
    if (i === 0) {
      cam.position.copy(this.base.position);
      cam.quaternion.copy(this.base.quaternion);
      // dolly toward focus
      this.tmp
        .copy(f)
        .sub(cam.position)
        .multiplyScalar(0.06 + 0.06 * push);
      cam.position.add(this.tmp);
      cam.fov = this.base.fov * (aspect < 1 ? 1.12 : 1);
    } else {
      this.fwd.copy(f).sub(this.base.position).setY(0);
      if (this.fwd.lengthSq() < 1e-6) this.fwd.set(0, 0, -1);
      this.fwd.normalize();
      const side = i === 1 ? 1 : -1;
      const ang = side * (i === 1 ? 0.7 : 1.9);
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const dx = this.fwd.x * ca - this.fwd.z * sa;
      const dz = this.fwd.x * sa + this.fwd.z * ca;
      const dist = (i === 1 ? 3.6 : 2.2) - push * (i === 1 ? 0.7 : 0.45);
      const h = i === 1 ? 0.45 : 1.6;
      cam.position.set(f.x - dx * dist, f.y + h, f.z - dz * dist);
      this.tmp2.set(f.x, f.y + (i === 1 ? 0.95 : 1.15), f.z);
      cam.lookAt(this.tmp2);
      if (i === 2) cam.rotateZ(0.2 + push * 0.05);
      cam.fov = i === 1 ? 38 : 30;
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }
}
