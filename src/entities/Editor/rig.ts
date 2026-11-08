/**
 * THE EDITOR — procedural figure + animation rig.
 *
 * A gaunt, hunched newspaper editor ~7.4 m tall (TUNING.boss.scale × player height): paper-pale
 * skin, red frock coat, green eyeshade, round spectacles whose lenses burn like the crystal, a
 * pencil tucked behind the ear and a giant yellow pencil whose pink eraser un-inks the world.
 * Upper body finished ink, lower half a pencil sketch with construction strokes (materials.ts).
 *
 * Rig: hips → spine → neck → jaw are a bone hierarchy; arms are two-bone IK chains solved in rig
 * space every frame (with rubber-hose stretch when the pencil has to reach across the arena).
 * Each bone owns one merged mesh + one inverted-hull outline → ~24 draw calls for the whole boss.
 * Everything per-frame works on preallocated temporaries.
 */
import * as THREE from 'three';
import type { Attack, EditorFSM, WeakAnchor } from './fsm';
import { ball, GeoBuilder, lathe, limb, sketchEllipse, sketchLine, strokeGeometry, wobble } from './geometry';
import {
  createEditorBodyMaterial,
  createEditorOutlineMaterial,
  createStrokeMaterial,
  type EditorUniforms,
  PART,
  RAMP,
} from './materials';

// Dimensions (metres, rig space; Editor faces +Z)
const HIP_Y = 3.3;
const SHOULDER = new THREE.Vector3(1.18, 2.05, -0.05); // in spine space (x mirrored for right)
const UPPER = 2.15;
const FORE = 2.05;
const ERASER_REACH = 3.8; // grip → eraser end
const TIP_REACH = 2.6; // grip → graphite tip

// ───────────── temporaries (no per-frame allocation) ─────────────
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _Y = new THREE.Vector3(0, 1, 0);
const _E = new THREE.Euler();

function damp(cur: number, target: number, k: number, dt: number): number {
  return target + (cur - target) * Math.exp(-k * dt);
}
function dampV(cur: THREE.Vector3, target: THREE.Vector3, k: number, dt: number): void {
  const a = 1 - Math.exp(-k * dt);
  cur.x += (target.x - cur.x) * a;
  cur.y += (target.y - cur.y) * a;
  cur.z += (target.z - cur.z) * a;
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface Shard {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  s0: THREE.Vector3;
}

export class EditorRig {
  readonly root = new THREE.Group();
  readonly hips = new THREE.Group();
  readonly spine = new THREE.Group();
  readonly neck = new THREE.Group();
  readonly jaw = new THREE.Group();
  readonly upperR = new THREE.Group();
  readonly foreR = new THREE.Group();
  readonly handR = new THREE.Group();
  readonly upperL = new THREE.Group();
  readonly foreL = new THREE.Group();
  readonly handL = new THREE.Group();
  readonly pencil = new THREE.Group();
  /** Pencil sub-node at the eraser end and the tip (world positions for fx). */
  readonly eraserEnd = new THREE.Object3D();
  readonly tipEnd = new THREE.Object3D();
  readonly anchors: Record<WeakAnchor, THREE.Object3D>;
  /** Camera framing hint: chest/head point (world). */
  readonly focus = new THREE.Vector3();
  readonly headWorld = new THREE.Vector3();
  readonly bodyMat: THREE.ShaderMaterial;
  readonly outlineMat: THREE.ShaderMaterial;
  readonly strokeMat: THREE.ShaderMaterial;
  readonly meshes: THREE.Mesh[] = [];
  private strokes!: THREE.Mesh;
  /** Optional GLB replacement (assets workstream). */
  private model: THREE.Object3D | null = null;

  // animated state
  private yaw = 0;
  private handRPos = new THREE.Vector3(-1.7, 2.9, 1.4);
  private handLPos = new THREE.Vector3(1.7, 2.9, 1.2);
  private pencilDir = new THREE.Vector3(0, -0.6, 0.8).normalize();
  private pencilDirT = new THREE.Vector3();
  private flip = 0; // 0 eraser-down, 1 tip-down
  private roar = 0;
  private lean = 0;
  private twist = 0;
  private hipDrop = 0;
  private stagger = 0;
  private seamRise = 0;
  private jawOpen = 0;
  private time = 0;
  private wipeAngle = 0;
  private lastRSerial = -1;
  private shards: Shard[] = [];
  private torn = false;
  /** Seconds of hit recoil (set by Editor on weak-point hits). */
  hurtKick = 0;
  /** Hint for the Editor: where the right-hand contact (eraser/tip) is, world. */
  readonly contact = new THREE.Vector3();
  contacting = false;

  constructor(private u: EditorUniforms) {
    this.bodyMat = createEditorBodyMaterial(u);
    this.bodyMat.side = THREE.DoubleSide;
    this.outlineMat = createEditorOutlineMaterial(u);
    this.strokeMat = createStrokeMaterial(u);
    this.root.name = 'Editor';
    this.build();
    this.anchors = {
      forearmR: this.anchor(this.foreR, 0.12, 0.52, 0.26),
      wristR: this.anchor(this.foreR, -0.1, 0.9, 0.24),
      handL: this.anchor(this.handL, 0, 0.32, 0.26),
      hipL: this.anchor(this.hips, 0.62, -0.55, 0.9),
      hipR: this.anchor(this.hips, -0.62, -0.55, 0.9),
      coat: this.anchor(this.hips, 0.05, -1.55, 1.2),
      core: this.anchor(this.spine, 0, 1.25, 0.95),
    };
  }

  private anchor(parent: THREE.Object3D, x: number, y: number, z: number): THREE.Object3D {
    const o = new THREE.Object3D();
    o.position.set(x, y, z);
    parent.add(o);
    return o;
  }

  private addMesh(parent: THREE.Object3D, g: THREE.BufferGeometry, name: string): THREE.Mesh {
    const m = new THREE.Mesh(g, this.bodyMat);
    m.name = `Editor.${name}`;
    m.frustumCulled = false;
    const hull = new THREE.Mesh(g, this.outlineMat);
    hull.name = `Editor.${name}.outline`;
    hull.frustumCulled = false;
    m.add(hull);
    parent.add(m);
    this.meshes.push(m);
    return m;
  }

  // ─────────────────────────── modelling ───────────────────────────
  private build(): void {
    const R = this.root;
    R.add(this.hips);
    this.hips.position.set(0, HIP_Y, 0);
    this.hips.add(this.spine);
    this.spine.position.set(0, 0.1, 0);
    this.spine.add(this.neck);
    this.neck.position.set(0, 2.32, 0.12);
    this.neck.add(this.jaw);
    this.jaw.position.set(0, 0.42, 0.2);
    R.add(this.upperR, this.foreR, this.handR, this.upperL, this.foreL, this.handL, this.pencil);

    // ── hips: sketchy legs + frock-coat skirt with split tails (cloth) ──
    const hb = new GeoBuilder();
    for (const sx of [-1, 1]) {
      // thigh, shin (knees bent forward a touch), boots
      hb.add(wobble(limb(0.36, 0.27, 1.75, 10, 4), 0.05, 3, sx), {
        p: [sx * 0.45, -1.7, 0.05],
        r: [-0.12, 0, sx * 0.04],
        ramp: RAMP.staff,
        part: PART.legs,
      });
      hb.add(ball(0.29), { p: [sx * 0.45, -1.72, 0.18], ramp: RAMP.staff, part: PART.legs });
      hb.add(limb(0.24, 0.29, 1.62, 10, 4), {
        p: [sx * 0.47, -3.28, 0.02],
        r: [0.08, 0, 0],
        ramp: RAMP.staff,
        part: PART.legs,
      });
      hb.add(ball(0.3, 12, 8), {
        p: [sx * 0.5, -3.2, 0.35],
        s: [0.95, 0.5, 1.9],
        ramp: RAMP.staff,
        part: PART.legs,
      });
    }
    // coat skirt: open in front, long split tails at the back (cloth weight grows downward)
    const skirt = lathe(
      [
        [0.86, 0.18],
        [0.95, -0.2],
        [1.08, -0.9],
        [1.24, -1.7],
        [1.36, -2.35],
        [1.4, -2.6],
      ],
      26,
      0.62,
      Math.PI * 2 - 1.24,
    );
    {
      const p = skirt.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        const y = p.getY(i);
        const z = p.getZ(i);
        const back = Math.max(0, -z / 1.4); // 0 front .. 1 back
        const tailSplit = Math.abs(x) < 0.12 && back > 0.85 ? 0.6 : 0; // notch between tails
        const drop = y < -0.5 ? (back * 0.95 - tailSplit) * smooth(-0.5, -2.6, y) : 0;
        p.setXYZ(i, x * (1 - back * 0.08), y - drop, z * 0.82);
      }
      skirt.computeVertexNormals();
    }
    hb.add(skirt, { ramp: RAMP.red, part: PART.coat, cloth: (_x, y) => smooth(-0.2, -3.2, y) });
    this.addMesh(this.hips, hb.build(), 'hips');

    // construction strokes (pencil half)
    const L: THREE.Vector3[][] = [];
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    L.push(sketchEllipse(0, 0.05, 0, 1.05, 0.75, 0.3));
    L.push(sketchEllipse(0, -1.0, -0.05, 1.2, 0.88, 1.7, 1.08, 0.06));
    L.push(sketchEllipse(0.46, -1.7, 0.18, 0.36, 0.34, 2.1));
    L.push(sketchEllipse(-0.46, -1.7, 0.18, 0.36, 0.34, 4.2));
    L.push(sketchEllipse(0, -3.27, 0.2, 1.9, 1.4, 0.9, 1.18));
    L.push(sketchEllipse(0, -3.27, 0.2, 2.3, 1.75, 2.9, 1.05));
    L.push(sketchLine(V(0, 1.2, 0.95), V(0.05, -3.3, 0.6), 0.12, 0.31)); // gesture line
    for (const sx of [-1, 1]) {
      L.push(sketchLine(V(sx * 0.95, 0.1, 0.2), V(sx * 1.45, -2.7, 0.35), sx * 0.18, 0.11 + sx));
      L.push(sketchLine(V(sx * 0.8, 0.0, 0.6), V(sx * 0.66, -1.65, 0.55), sx * -0.1, 0.52 + sx));
      L.push(sketchLine(V(sx * 0.68, -1.75, 0.5), V(sx * 0.66, -3.1, 0.55), sx * 0.08, 0.77 + sx));
      L.push(sketchLine(V(sx * 0.2, -0.3, 0.75), V(sx * 0.25, -1.6, 0.65), sx * 0.05, 0.93 + sx));
    }
    // ground hatch shadow
    for (let i = 0; i < 9; i++) {
      const x = -1.8 + i * 0.42;
      L.push(sketchLine(V(x, -3.28, 1.4), V(x + 0.9, -3.28, -0.6), 0.03, 0.1 * i));
    }
    this.strokes = new THREE.Mesh(strokeGeometry(L), this.strokeMat);
    this.strokes.frustumCulled = false;
    this.strokes.name = 'Editor.strokes';
    this.hips.add(this.strokes);

    // ── spine: V-tapered torso, hunch, shirt V, tie, lapels, shoulder pads ──
    const sb = new GeoBuilder();
    const torso = lathe(
      [
        [0.01, -0.05],
        [0.6, -0.02],
        [0.66, 0.4],
        [0.92, 1.1],
        [1.1, 1.7],
        [1.0, 2.06],
        [0.55, 2.32],
        [0.28, 2.42],
        [0.01, 2.44],
      ],
      24,
    );
    sb.add(torso, { s: [1, 1, 0.72], ramp: RAMP.red, part: PART.torso });
    sb.add(ball(0.9, 14, 10), { p: [0, 1.65, -0.42], s: [1.05, 0.8, 0.7], ramp: RAMP.red, part: PART.torso }); // hunch
    sb.add(new THREE.ConeGeometry(0.5, 1.25, 3, 1), {
      p: [0, 1.72, 0.5],
      r: [Math.PI, 0, 0],
      s: [1, 1, 0.3],
      ramp: RAMP.ghost,
      part: PART.torso,
    }); // shirt V
    sb.add(new THREE.ConeGeometry(0.13, 1.15, 4), {
      p: [0, 1.62, 0.6],
      r: [Math.PI + 0.06, 0, 0],
      s: [1, 1, 0.4],
      ramp: RAMP.staff,
      part: PART.torso,
    }); // tie
    sb.add(ball(0.12, 8, 6), { p: [0, 2.18, 0.56], s: [1.2, 0.9, 0.7], ramp: RAMP.staff, part: PART.torso }); // knot
    for (const sx of [-1, 1]) {
      sb.add(new THREE.BoxGeometry(0.16, 1.45, 0.07), {
        p: [sx * 0.3, 1.62, 0.6],
        r: [0.1, sx * 0.3, sx * 0.36],
        ramp: RAMP.red,
        part: PART.torso,
      }); // lapel
      sb.add(ball(0.46, 12, 9), {
        p: [sx * 1.0, 2.0, -0.1],
        s: [1.05, 0.62, 0.95],
        ramp: RAMP.red,
        part: PART.torso,
      }); // shoulder pad
      sb.add(ball(0.075, 8, 6), { p: [sx * 0.2, 0.55, 0.5], ramp: RAMP.staff, part: PART.torso }); // buttons
      sb.add(ball(0.075, 8, 6), { p: [sx * 0.22, 0.85, 0.54], ramp: RAMP.staff, part: PART.torso });
    }
    this.addMesh(this.spine, sb.build(), 'spine');

    // ── head (big, caricatured): skull, brow, nose, moustache, ears, eyeshade, spectacles ──
    this.neck.scale.setScalar(1.32);
    const nb = new GeoBuilder();
    nb.add(limb(0.3, 0.26, 0.45, 10, 2), { p: [0, -0.12, -0.05], ramp: RAMP.ghost, part: PART.head });
    nb.add(wobble(ball(0.55, 18, 14), 0.04, 4, 2), {
      p: [0, 0.84, 0.0],
      s: [0.86, 1.1, 0.95],
      ramp: RAMP.ghost,
      part: PART.head,
    });
    nb.add(ball(0.42, 14, 10), {
      p: [0, 0.6, 0.16],
      s: [0.85, 0.62, 0.8],
      ramp: RAMP.ghost,
      part: PART.head,
    }); // cheeks
    nb.add(new THREE.ConeGeometry(0.1, 0.62, 8), {
      p: [0, 0.74, 0.8],
      r: [Math.PI / 2 + 0.35, 0, 0],
      ramp: RAMP.ghost,
      part: PART.face,
    }); // long hooked nose
    for (const sx of [-1, 1]) {
      nb.add(ball(0.16, 8, 6), {
        p: [sx * 0.49, 0.8, -0.02],
        s: [0.45, 1.15, 0.8],
        ramp: RAMP.ghost,
        part: PART.head,
      }); // ear
      nb.add(new THREE.BoxGeometry(0.34, 0.09, 0.12), {
        p: [sx * 0.19, 1.05, 0.58],
        r: [0.2, 0, sx * -0.42],
        ramp: RAMP.staff,
        part: PART.face,
      }); // angry brow
      nb.add(new THREE.TorusGeometry(0.15, 0.032, 6, 18), {
        p: [sx * 0.2, 0.88, 0.6],
        r: [0, sx * 0.22, 0],
        ramp: RAMP.staff,
        part: PART.face,
      }); // spectacle rim
      nb.add(new THREE.CircleGeometry(0.14, 16), {
        p: [sx * 0.2, 0.88, 0.605],
        r: [0, sx * 0.22, 0],
        ramp: RAMP.glow,
        part: PART.face,
      }); // burning lens
      nb.add(new THREE.ConeGeometry(0.075, 0.55, 6), {
        p: [sx * 0.2, 0.55, 0.56],
        r: [0.3, 0, sx * (Math.PI / 2 + 0.55)],
        ramp: RAMP.staff,
        part: PART.face,
      }); // drooping moustache
      for (let t = 0; t < 3; t++)
        nb.add(new THREE.ConeGeometry(0.09, 0.42, 5), {
          p: [sx * (0.46 + t * 0.03), 1.08 - t * 0.14, -0.08 - t * 0.06],
          r: [0.2, 0, sx * (-1.1 - t * 0.25)],
          ramp: RAMP.staff,
          part: PART.head,
        }); // wild side tufts
    }
    nb.add(ball(0.08, 8, 6), { p: [0, 0.57, 0.62], s: [2.0, 0.7, 0.7], ramp: RAMP.staff, part: PART.face }); // moustache root
    nb.add(new THREE.BoxGeometry(0.1, 0.03, 0.04), { p: [0, 0.88, 0.64], ramp: RAMP.staff, part: PART.face }); // bridge
    // green eyeshade: band + slanted visor (front only)
    nb.add(new THREE.CylinderGeometry(0.5, 0.51, 0.14, 20, 1, true), {
      p: [0, 1.2, 0.02],
      s: [0.9, 1, 0.98],
      ramp: RAMP.teal,
      part: PART.head,
    });
    const brim = new THREE.CylinderGeometry(0.47, 0.74, 0.05, 20, 1, true, -1.0, 2.0);
    nb.add(brim, { p: [0, 1.16, 0.08], r: [0.5, 0, 0], ramp: RAMP.teal, part: PART.head });
    // pencil stub behind the right ear
    nb.add(new THREE.CylinderGeometry(0.035, 0.035, 0.75, 6), {
      p: [-0.5, 1.02, -0.05],
      r: [0.5, 0, 1.25],
      ramp: RAMP.pencil,
      part: PART.head,
    });
    this.addMesh(this.neck, nb.build(), 'head');

    // jaw (roars): lantern chin + lower lip; sits under the moustache
    const jb = new GeoBuilder();
    jb.add(ball(0.3, 12, 9), { p: [0, 0.0, 0.02], s: [0.95, 0.5, 0.85], ramp: RAMP.ghost, part: PART.face });
    jb.add(ball(0.2, 10, 8), { p: [0, -0.1, 0.2], s: [1.1, 0.8, 0.85], ramp: RAMP.ghost, part: PART.face }); // lantern chin
    jb.add(new THREE.BoxGeometry(0.32, 0.04, 0.06), { p: [0, 0.07, 0.26], ramp: RAMP.red, part: PART.face }); // lip
    this.addMesh(this.jaw, jb.build(), 'jaw');

    // ── arms (unit-length segments, scaled to the solved length each frame) ──
    const arm = (mirror: number, up: THREE.Group, fore: THREE.Group, hand: THREE.Group, right: boolean) => {
      const ub = new GeoBuilder();
      ub.add(ball(0.36, 10, 8), {
        s: [1, 0.25, 1],
        ramp: RAMP.red,
        part: right ? PART.upperArmR : PART.upperArmL,
      });
      ub.add(limb(0.34, 0.27, 1, 10, 6), { ramp: RAMP.red, part: right ? PART.upperArmR : PART.upperArmL });
      ub.add(new THREE.CylinderGeometry(0.33, 0.33, 0.08, 10), {
        p: [0, 0.32, 0],
        ramp: RAMP.staff,
        part: right ? PART.upperArmR : PART.upperArmL,
      }); // sleeve garter
      this.addMesh(up, ub.build(), right ? 'upperArmR' : 'upperArmL');
      const fb = new GeoBuilder();
      const fp = right ? PART.forearmR : PART.forearmL;
      fb.add(ball(0.3, 10, 8), { s: [1, 0.3, 1], ramp: RAMP.red, part: fp }); // elbow
      fb.add(limb(0.28, 0.23, 0.78, 10, 5), { ramp: RAMP.red, part: fp });
      fb.add(limb(0.25, 0.2, 0.24, 10, 1), { p: [0, 0.78, 0], ramp: RAMP.ghost, part: fp }); // shirt cuff
      fb.add(new THREE.TorusGeometry(0.255, 0.03, 5, 12), {
        p: [0, 0.79, 0],
        r: [Math.PI / 2, 0, 0],
        ramp: RAMP.staff,
        part: fp,
      }); // cufflink ring
      this.addMesh(fore, fb.build(), right ? 'forearmR' : 'forearmL');
      // hand: fingers along +Y, back of hand toward +Z
      const hb2 = new GeoBuilder();
      const hp = right ? PART.handR : PART.handL;
      hb2.add(ball(0.3, 12, 9), { p: [0, 0.22, 0], s: [1, 1.15, 0.5], ramp: RAMP.ghost, part: hp });
      for (let f = 0; f < 4; f++) {
        const x = (f - 1.5) * 0.14 * mirror;
        const len = [0.6, 0.7, 0.66, 0.5][f]!;
        const c1 = right ? -1.0 : -0.15 - f * 0.05;
        const c2 = right ? -1.3 : -0.35;
        const k = len * 0.5;
        hb2.add(limb(0.085, 0.07, k, 6, 1), { p: [x, 0.45, 0], r: [c1, 0, 0], ramp: RAMP.ghost, part: hp });
        const tipY = 0.45 + Math.cos(c1) * k;
        const tipZ = Math.sin(c1) * k;
        hb2.add(ball(0.075, 6, 5), { p: [x, tipY, tipZ], ramp: RAMP.ghost, part: hp }); // knuckle
        hb2.add(new THREE.ConeGeometry(0.07, len * 0.55, 6), {
          p: [x, tipY + Math.cos(c1 + c2) * len * 0.27, tipZ + Math.sin(c1 + c2) * len * 0.27],
          r: [c1 + c2, 0, 0],
          ramp: RAMP.ghost,
          part: hp,
        }); // pointed claw-like fingertip
      }
      hb2.add(limb(0.08, 0.05, 0.45, 6, 1), {
        p: [mirror * 0.22, 0.12, -0.05],
        r: [right ? 0.9 : 0.3, 0, mirror * -0.9],
        ramp: RAMP.ghost,
        part: hp,
      }); // thumb
      this.addMesh(hand, hb2.build(), right ? 'handR' : 'handL');
    };
    arm(-1, this.upperR, this.foreR, this.handR, true);
    arm(1, this.upperL, this.foreL, this.handL, false);

    // ── the giant pencil: +Y = eraser end, -Y = graphite tip; grip at origin ──
    const pb = new GeoBuilder();
    pb.add(new THREE.CylinderGeometry(0.21, 0.21, 4.7, 6, 6), {
      p: [0, 0.55, 0],
      ramp: RAMP.pencil,
      part: PART.pencil,
    });
    for (let i = 0; i < 6; i++) {
      // painted facet edges read as ink lines thanks to the outline + post edges; add a stamp band
      if (i === 0)
        pb.add(new THREE.CylinderGeometry(0.215, 0.215, 0.12, 6), {
          p: [0, 2.5, 0],
          ramp: RAMP.staff,
          part: PART.pencil,
        });
    }
    pb.add(new THREE.CylinderGeometry(0.235, 0.235, 0.42, 14, 3), {
      p: [0, 3.1, 0],
      ramp: RAMP.staff,
      part: PART.pencil,
    }); // ferrule
    for (let i = 0; i < 3; i++)
      pb.add(new THREE.TorusGeometry(0.235, 0.025, 4, 14), {
        p: [0, 2.95 + i * 0.15, 0],
        r: [Math.PI / 2, 0, 0],
        ramp: RAMP.glow,
        part: PART.pencil,
      });
    const eraser = new THREE.CylinderGeometry(0.215, 0.225, 0.55, 14, 3);
    {
      // worn, slanted eraser end
      const p = eraser.getAttribute('position');
      for (let i = 0; i < p.count; i++) if (p.getY(i) > 0.2) p.setY(i, p.getY(i) - p.getX(i) * 0.25);
      eraser.computeVertexNormals();
    }
    pb.add(eraser, { p: [0, 3.55, 0], ramp: RAMP.red, part: PART.eraser });
    pb.add(new THREE.ConeGeometry(0.21, 0.62, 6, 2), {
      p: [0, -2.11, 0],
      r: [Math.PI, 0, 0],
      ramp: RAMP.ghost,
      part: PART.pencil,
    }); // wood
    pb.add(new THREE.ConeGeometry(0.075, 0.24, 8), {
      p: [0, -2.48, 0],
      r: [Math.PI, 0, 0],
      ramp: RAMP.staff,
      part: PART.pencil,
    }); // graphite
    this.addMesh(this.pencil, pb.build(), 'pencil');
    this.eraserEnd.position.set(0, ERASER_REACH, 0);
    this.tipEnd.position.set(0, -TIP_REACH, 0);
    this.pencil.add(this.eraserEnd, this.tipEnd);
  }

  /**
   * Swap in a GLB body (assets workstream, manifest id `editor`). The procedural meshes are hidden;
   * the model is attached to the spine-less root, scaled to the Editor's height, and given the
   * Editor material so the ink/pencil split, erase and death effects still apply. Weak-point anchors
   * keep following the procedural rig (still solved, just invisible).
   */
  useModel(model: THREE.Object3D, height = 7.4): void {
    this.model = model;
    const box = new THREE.Box3().setFromObject(model);
    const h = box.getSize(new THREE.Vector3()).y || 1;
    model.scale.multiplyScalar(height / h);
    box.setFromObject(model);
    model.position.y -= box.min.y;
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.material = this.bodyMat;
      m.frustumCulled = false;
      const hull = new THREE.Mesh(m.geometry, this.outlineMat);
      if ((m as THREE.SkinnedMesh).isSkinnedMesh) return; // hull needs its own skeleton binding; skip
      m.add(hull);
    });
    for (const m of this.meshes) if (m.parent !== this.pencil) m.visible = false;
    this.root.add(model);
  }

  /** Swap the pencil/eraser prop (manifest id `eraser`): model should point along +Y, eraser up. */
  usePencilModel(model: THREE.Object3D): void {
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = this.bodyMat;
    });
    for (const m of this.meshes) if (m.parent === this.pencil) m.visible = false;
    this.pencil.add(model);
  }

  get hasModel(): boolean {
    return this.model !== null;
  }

  // ─────────────────────────── animation ───────────────────────────
  /** World → rig-local into `out`. */
  private toLocal(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    out.set(x, y, z);
    return this.root.worldToLocal(out);
  }

  update(fsm: EditorFSM, dt: number, playerX: number, playerZ: number): void {
    this.time += dt;
    const t = this.time;
    const st = fsm.state;
    const dying = st === 'dying';
    const dead = st === 'dead';
    const dT = dying ? fsm.t : dead ? 99 : 0;

    // ── roar envelope (intro, transitions) ──
    let roarT = 0;
    if (st === 'intro') roarT = smooth(0.4, 1.4, fsm.t) * (1 - smooth(2.8, 3.4, fsm.t));
    else if (st === 'transition') roarT = smooth(0.0, 0.5, fsm.t) * (1 - smooth(1.9, 2.6, fsm.t));
    this.roar = damp(this.roar, roarT, 8, dt);
    this.jawOpen = damp(this.jawOpen, this.roar * 0.75 + (fsm.staggerT > 0 ? 0.4 : 0), 14, dt);

    // ── yaw toward the player (locked while the eraser is down) ──
    const aR = fsm.visualAttack('R');
    const aL = fsm.visualAttack('L');
    const locked = (aR && aR.stage !== 'telegraph') || (aL && aL.stage !== 'telegraph');
    if (!locked && !dying && !dead) {
      const tgt = Math.atan2(playerX - this.root.position.x, playerZ - this.root.position.z);
      const clamped = Math.max(-0.7, Math.min(0.7, tgt));
      this.yaw = damp(this.yaw, clamped, 2.5, dt);
    }
    this.root.rotation.y = this.yaw;
    this.root.updateMatrixWorld(true);

    // ── torso ──
    this.stagger = damp(this.stagger, fsm.staggerT > 0 ? 1 : 0, 10, dt);
    this.hurtKick = Math.max(0, this.hurtKick - dt * 3);
    let leanT = 0.14 + Math.sin(t * 1.3) * 0.03;
    let twistT = 0;
    if (aR && fsm.phase !== 2) {
      if (aR.stage === 'telegraph') {
        leanT -= 0.12 * smooth(0, 0.8, aR.p);
        twistT = 0.35 * smooth(0, 1, aR.p);
      } else {
        const reach = Math.hypot(aR.headX - this.root.position.x, aR.headZ - this.root.position.z);
        leanT += 0.25 + smooth(5, 15, reach) * 0.45;
        twistT = -0.25;
      }
    } else if (aR && fsm.phase === 2) {
      leanT += aR.stage === 'telegraph' ? -0.1 : 0.35;
    }
    if (aL) leanT += aL.stage === 'telegraph' ? 0.05 : 0.3;
    leanT += fsm.bowAmt * 0.95 - this.roar * 0.42 - this.stagger * 0.35 - this.hurtKick * 0.3;
    if (dying) leanT = 0.25 + Math.sin(t * 23) * 0.06 * (1 - smooth(0, 2.5, dT)) + smooth(1.0, 2.6, dT) * 0.5;
    this.lean = damp(this.lean, leanT, 6, dt);
    this.twist = damp(this.twist, twistT, 5, dt);
    this.hipDrop = damp(this.hipDrop, fsm.bowAmt * 1.15 + (dying ? smooth(0.8, 2.6, dT) * 1.4 : 0), 5, dt);
    this.hips.position.y = HIP_Y - this.hipDrop + Math.sin(t * 1.3) * 0.04;
    this.hips.rotation.x = this.hipDrop * 0.12;
    this.spine.rotation.set(
      this.lean,
      this.twist,
      Math.sin(t * 0.9) * 0.04 + (dying ? Math.sin(t * 17) * 0.05 : 0),
    );
    // head: look at the player (or the lane), roar back
    const headYaw = Math.max(
      -0.5,
      Math.min(0.5, Math.atan2(playerX - this.root.position.x, playerZ - this.root.position.z) - this.yaw),
    );
    this.neck.rotation.set(
      0.02 - this.roar * 0.75 + fsm.bowAmt * -0.6 + this.stagger * 0.2 - this.lean * 0.5,
      headYaw * 0.6 - this.twist * 0.5,
      Math.sin(t * 0.7) * 0.05 + (dying ? Math.sin(t * 29) * 0.15 : 0),
    );
    this.jaw.rotation.x = this.jawOpen * 0.7 + Math.max(0, Math.sin(t * 11)) * 0.04;

    this.root.updateMatrixWorld(true);

    // ── right hand + pencil ──
    const sR = this.shoulderLocal(-1, _v1);
    const hR = _v2;
    let contactLocal = false;
    const flipT = fsm.phase === 2 && st !== 'intro' ? 1 : 0;
    this.flip = damp(this.flip, flipT, 3.5, dt);
    const reach = ERASER_REACH + (TIP_REACH - ERASER_REACH) * this.flip;
    let kR = 6;
    // idle: leaning on the pencil like a cane, eraser down
    this.pencilDirT.set(-0.2, -0.92, 0.35);
    hR.copy(sR).add(_v3.set(-0.45, -2.15, 1.55));
    if (st === 'transition' && fsm.phase === 3 && !dying) {
      // the Blank Page wipe: one huge circular erase around the arena
      this.wipeAngle = -1.4 + smooth(0.3, 2.4, fsm.t) * 2.8;
      const r = 6.5;
      this.toLocal(
        this.root.position.x + Math.sin(this.wipeAngle + this.yaw) * r,
        0,
        this.root.position.z + Math.cos(this.wipeAngle + this.yaw) * r,
        _v4,
      );
      this.placeOnContact(_v4, sR, reach, hR);
      contactLocal = fsm.t > 0.3 && fsm.t < 2.4;
      kR = 12;
    } else if (aR && !dying) {
      kR = this.poseRight(aR, sR, reach, hR);
      contactLocal = aR.stage !== 'telegraph';
    } else if (this.roar > 0.05) {
      hR.copy(sR).add(_v3.set(-2.0, 0.8 + this.roar * 0.6, 0.8));
      this.pencilDirT.set(-0.6, 0.75, 0.2);
    } else if (fsm.bowAmt > 0.05) {
      this.toLocal(this.root.position.x, 0, this.root.position.z, _v4);
      _v4.add(_v3.set(-1.9, 0, 2.8));
      this.placeOnContact(_v4, sR, reach, hR);
      kR = 8;
    }
    if (dying) {
      hR.copy(sR).add(_v3.set(-0.6 - Math.sin(t * 13) * 0.3, -2.2 + Math.sin(t * 9) * 0.4, 1.6));
      this.pencilDirT.set(-0.4, -0.2, 0.9);
      kR = 9;
    }
    // idle drift
    if (!aR && !dying) hR.x += Math.sin(t * 1.1) * 0.12;
    dampV(this.handRPos, hR, kR, dt);
    this.pencilDirT.normalize();
    // pencil direction eases unless pinned
    const pa = 1 - Math.exp(-(kR * 1.3) * dt);
    this.pencilDir.lerp(this.pencilDirT, pa).normalize();
    // flip: the pencil turns tip-down for Redraw (twirl around the hand)
    this.pencil.position.copy(this.handRPos);
    _q1.setFromUnitVectors(_Y, this.pencilDir);
    this.pencil.quaternion.copy(_q1);
    if (this.flip > 0.001) {
      _E.set(Math.PI * this.flip, this.flip * (1 - this.flip) * 6, 0);
      this.pencil.quaternion.multiply(_q1.setFromEuler(_E));
    }
    this.solveArm(sR, this.handRPos, -1, this.upperR, this.foreR);
    this.orientHand(this.handR, this.handRPos, this.pencilDir, this.foreR, true, false);
    this.contacting = contactLocal;
    if (contactLocal) {
      this.pencil.updateMatrixWorld(true);
      (this.flip > 0.5 ? this.tipEnd : this.eraserEnd).getWorldPosition(this.contact);
    }

    // ── left hand ──
    const sL = this.shoulderLocal(1, _v1);
    // idle: a raised, twitching claw
    const hL = _v2.copy(sL).add(_v3.set(0.35, -0.9 + Math.sin(t * 0.8) * 0.2, 2.3 + Math.sin(t * 0.6) * 0.2));
    let kL = 5;
    let flat = false;
    if (aL && !dying) {
      this.toLocal(aL.ax, 0, aL.az, _v4);
      if (aL.stage === 'telegraph') {
        const p = aL.p;
        const hover = 4.2 - smooth(0.0, 1, p) * 1.6 - smooth(0.88, 1, p) * 2.2;
        hL.copy(_v4).add(_v3.set(Math.sin(t * 31) * 0.05 * p, hover, 0));
        kL = 7 + p * 18;
        flat = p > 0.3;
      } else {
        hL.copy(_v4).add(_v3.set(0, 0.22, 0));
        kL = 40;
        flat = true;
      }
    } else if (this.roar > 0.05) {
      hL.copy(sL).add(_v3.set(2.2, 0.6 + this.roar * 0.7, 0.9));
    } else if (fsm.bowAmt > 0.05) {
      this.toLocal(this.root.position.x, 0, this.root.position.z, _v4);
      hL.copy(_v4).add(_v3.set(2.1, 0.25, 2.6));
      flat = true;
      kL = 8;
    }
    if (dying) {
      // clutching at the chest
      hL.copy(sL).add(_v3.set(-0.7, -0.6 + Math.sin(t * 15) * 0.15, 1.3));
      kL = 10;
    }
    dampV(this.handLPos, hL, kL, dt);
    this.solveArm(sL, this.handLPos, 1, this.upperL, this.foreL);
    this.orientHand(this.handL, this.handLPos, null, this.foreL, false, flat);

    // ── derived uniforms / hints ──
    this.hips.getWorldPosition(_v3);
    const destroyedP2 =
      (fsm.wps[3]!.hp <= 0 ? 1 : 0) + (fsm.wps[4]!.hp <= 0 ? 1 : 0) + (fsm.wps[5]!.hp <= 0 ? 1 : 0);
    const rise = fsm.phase >= 2 && st !== 'intro' ? destroyedP2 * 0.55 + (fsm.phase === 3 ? 0.4 : 0) : 0;
    this.seamRise = damp(this.seamRise, dying ? 0 : rise, 2, dt);
    // intro: the whole figure starts as a sketch and prints itself from the head down to the waist
    const intro = st === 'intro' ? 1 - smooth(0.5, 2.9, fsm.t) : 0;
    this.u.uPrintAll.value = intro > 0 ? 1 : 0;
    this.u.uSplitY.value = _v3.y + 0.12 + this.seamRise + intro * 6.5;
    const w = this.u.uWind.value;
    w.set(-this.twist * 0.25, 0, -this.lean * 0.3 + this.roar * 0.2);
    this.neck.getWorldPosition(this.headWorld);
    this.headWorld.y += 0.8;
    this.spine.getWorldPosition(this.focus);
    this.focus.y += 1.2;

    // ── death: shards ──
    if (dying && dT >= 3.0 && !this.torn) this.tear();
    if (this.torn) this.updateShards(dt);
  }

  private shoulderLocal(side: number, out: THREE.Vector3): THREE.Vector3 {
    out.set(SHOULDER.x * side, SHOULDER.y, SHOULDER.z);
    this.spine.localToWorld(out);
    return this.root.worldToLocal(out);
  }

  /** Put the hand so the pencil end touches `contact` (rig-local), pencil on the shoulder line. */
  private placeOnContact(
    contact: THREE.Vector3,
    shoulder: THREE.Vector3,
    reach: number,
    outHand: THREE.Vector3,
  ): void {
    _v3.copy(shoulder).sub(contact);
    const d = _v3.length() || 1;
    _v3.multiplyScalar(1 / d);
    // keep the pencil from lying flat: lift the grip a bit
    _v3.y = Math.max(_v3.y, 0.45);
    _v3.normalize();
    outHand.copy(contact).addScaledVector(_v3, reach);
    this.pencilDirT.copy(_v3).negate();
  }

  private poseRight(a: Attack, sR: THREE.Vector3, reach: number, hR: THREE.Vector3): number {
    const p = a.p;
    if (a.kind === 'stab') {
      this.toLocal(a.ax, 0, a.az, _v4);
      if (a.stage === 'telegraph') {
        const lift = 3.2 + 1.2 * smooth(0, 0.7, p) - smooth(0.85, 1, p) * 3.5;
        hR.copy(_v4).add(_v3.set(Math.sin(this.time * 37) * 0.06 * p, reach + lift, -0.3));
        this.pencilDirT.set(0, -1, 0.08);
        return 6 + p * 14;
      }
      hR.copy(_v4).add(_v3.set(0, reach * 0.97, -0.25));
      this.pencilDirT.set(0, -1, 0.1);
      return 45;
    }
    if (a.stage === 'telegraph') {
      // wind-up: eraser raised high over the shoulder, trembling, then the slam
      if (a.serial !== this.lastRSerial) this.lastRSerial = a.serial;
      this.toLocal(a.ax, 0, a.az, _v4);
      const up = smooth(0, 0.55, p);
      hR.copy(sR).add(_v3.set(-0.9, 1.4 + up * 1.2, -0.9 * up));
      hR.x += Math.sin(this.time * 41) * 0.08 * p;
      this.pencilDirT.set(-0.25, 0.55, -0.8);
      if (p > 0.82) {
        // anticipation → swing down toward the slam point
        const s = smooth(0.82, 1, p);
        _v5.copy(this.pencilDirT);
        this.placeOnContact(_v4, sR, reach, _v6);
        hR.lerp(_v6, s);
        _v6.copy(this.pencilDirT);
        this.pencilDirT.copy(_v5).lerp(_v6, s);
      }
      return 10;
    }
    const hx = a.stage === 'strike' ? a.headX : a.bx;
    const hz = a.stage === 'strike' ? a.headZ : a.bz;
    this.toLocal(hx, 0, hz, _v4);
    if (a.stage === 'recover') {
      // grinding the eraser in
      _v4.x += Math.sin(this.time * 19) * 0.14;
      _v4.z += Math.cos(this.time * 15) * 0.1;
    }
    this.placeOnContact(_v4, sR, reach, hR);
    return a.stage === 'strike' ? 34 : 16;
  }

  /** Two-bone IK with rubber-hose stretch; writes segment transforms (rig-local). */
  private solveArm(
    S: THREE.Vector3,
    T: THREE.Vector3,
    side: number,
    up: THREE.Group,
    fore: THREE.Group,
  ): void {
    _v3.copy(T).sub(S);
    let d = _v3.length();
    const max = (UPPER + FORE) * 0.985;
    let k = 1;
    if (d > max) k = d / max;
    const l1 = UPPER * k;
    const l2 = FORE * k;
    d = Math.max(Math.abs(l1 - l2) + 0.05, Math.min(d, l1 + l2 - 1e-3));
    const dir = _v3.normalize();
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    // pole: elbows out and back
    _v4.set(side * 1.0, -0.35, -0.7);
    _v4.addScaledVector(dir, -_v4.dot(dir)).normalize();
    const E = _v4.multiplyScalar(h).addScaledVector(dir, a).add(S);
    const thin = 1 / Math.sqrt(k);
    this.placeSeg(up, S, E, thin);
    this.placeSeg(fore, E, T, thin);
  }

  private placeSeg(seg: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, thin: number): void {
    seg.position.copy(a);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-3;
    _q1.setFromUnitVectors(_Y, _m1Vec.set(dx / len, dy / len, dz / len));
    seg.quaternion.copy(_q1);
    seg.scale.set(thin, len, thin);
  }

  private orientHand(
    hand: THREE.Object3D,
    pos: THREE.Vector3,
    pencilDir: THREE.Vector3 | null,
    fore: THREE.Object3D,
    right: boolean,
    flat: boolean,
  ): void {
    hand.position.copy(pos);
    // fingers axis
    const y = _hy;
    if (pencilDir) {
      // wrap around the pencil: fingers perpendicular-ish to it
      _m1Vec.set(0, 1, 0).applyQuaternion(fore.quaternion);
      y.copy(_m1Vec).lerp(pencilDir, 0.35).normalize();
    } else if (flat) {
      _m1Vec.set(0, 1, 0).applyQuaternion(fore.quaternion);
      y.set(_m1Vec.x, 0, _m1Vec.z);
      if (y.lengthSq() < 1e-4) y.set(0, 0, 1);
      y.normalize();
    } else {
      y.set(0, 1, 0).applyQuaternion(fore.quaternion);
    }
    const z = _hz.set(0, 1, 0);
    if (!flat) z.set(right ? -0.4 : 0.4, 0.2, 1).normalize();
    z.addScaledVector(y, -z.dot(y)).normalize();
    const x = _hx.crossVectors(y, z);
    _m1.makeBasis(x, y, z);
    hand.quaternion.setFromRotationMatrix(_m1);
    hand.scale.setScalar(1);
  }

  // ─────────────────────────── death ───────────────────────────
  private tear(): void {
    this.torn = true;
    const center = _v3;
    this.spine.getWorldPosition(center);
    const all: THREE.Object3D[] = [...this.meshes, this.strokes];
    for (const m of all) {
      this.root.attach(m);
      const wp = m.getWorldPosition(new THREE.Vector3());
      const out = wp.clone().sub(center);
      out.y = Math.abs(out.y) * 0.4 + 0.6;
      out.normalize();
      const speed = 3 + Math.random() * 5;
      this.shards.push({
        obj: m,
        vel: out.multiplyScalar(speed).add(new THREE.Vector3(0, 4 + Math.random() * 3, 0)),
        spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(
          6,
        ),
        s0: m.scale.clone(),
      });
    }
  }

  private shardT = 0;
  private updateShards(dt: number): void {
    this.shardT += dt;
    const shrink = Math.max(0, 1 - Math.max(0, this.shardT - 0.8) / 1.6);
    for (const s of this.shards) {
      s.vel.y -= 9 * dt;
      s.obj.position.addScaledVector(s.vel, dt);
      if (s.obj.position.y < -2) s.vel.set(0, 0, 0);
      s.obj.rotation.x += s.spin.x * dt;
      s.obj.rotation.y += s.spin.y * dt;
      s.obj.rotation.z += s.spin.z * dt;
      s.obj.scale.copy(s.s0).multiplyScalar(Math.max(0.001, shrink));
      s.obj.visible = shrink > 0.002;
    }
  }

  /** Rebuild after a restart (debug / retry). Cheap enough: only after death. */
  get isTorn(): boolean {
    return this.torn;
  }

  dispose(): void {
    const geos = new Set<THREE.BufferGeometry>();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) geos.add(m.geometry);
    });
    for (const g of geos) g.dispose();
    this.bodyMat.dispose();
    this.outlineMat.dispose();
    this.strokeMat.dispose();
  }
}

const _m1Vec = new THREE.Vector3();
const _hx = new THREE.Vector3();
const _hy = new THREE.Vector3();
const _hz = new THREE.Vector3();
