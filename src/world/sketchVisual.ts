import * as THREE from 'three';
import type { SketchObjectDef } from '../core/types';
import { PAL } from '../data/palette';
import { TUNING } from '../data/tuning';
import type { SketchVisual } from '../systems/sketch-objects';
import { box, clean, type MaterialFactory, merge, splat as splatGeo } from './geo';
import { createPencilMaterial, StrokeBuilder } from './pencil';
import { makeRng } from './rng';

export interface SketchVisualDeps {
  parent: THREE.Object3D;
  material: MaterialFactory;
  resolution: THREE.Vector2;
  ground: (x: number, z: number) => number;
  /** Shared ink-stain material for stamp decals. */
  inkMat: THREE.Material;
}

interface Mover {
  pivot: THREE.Object3D;
  axis: 'y';
  open: number;
  /** Progress threshold at which this mover's ink appears. */
  showAt: number;
}

interface Parts {
  /** Ordered pieces: they ink in one by one as progress rises. */
  pieces: THREE.BufferGeometry[];
  ramp: 'staff' | 'red' | 'teal' | 'ghost';
  strokes: StrokeBuilder;
  movers: { geo: THREE.BufferGeometry; hinge: THREE.Vector3; open: number; ramp: 'staff' | 'red' }[];
  /** Where the stamp splat lands, and its radius. */
  splat: [number, number, number, number];
}

const deckY = (ground: (x: number, z: number) => number, r: [number, number, number, number]) => {
  const along = r[3] - r[1] >= r[2] - r[0] ? 'z' : 'x';
  const mid = along === 'z' ? (r[0] + r[2]) / 2 : (r[1] + r[3]) / 2;
  const h0 = along === 'z' ? ground(mid, r[1]) : ground(r[0], mid);
  const h1 = along === 'z' ? ground(mid, r[3]) : ground(r[2], mid);
  return { along, h: (t: number) => h0 + (h1 - h0) * t + Math.sin(t * Math.PI) * 0.25 };
};

function bridgeParts(def: SketchObjectDef, ground: (x: number, z: number) => number): Parts {
  const rnd = makeRng(def.id.length * 977 + 13);
  const r = def.unlocks ?? [def.at[0] - 1.2, def.at[2] - 4, def.at[0] + 1.2, def.at[2] + 4];
  const { h } = deckY(ground, r);
  const sb = new StrokeBuilder(91);
  const pieces: THREE.BufferGeometry[] = [];
  const x0 = r[0] + 0.05;
  const x1 = r[2] - 0.05;
  const w = x1 - x0;
  const cx = (x0 + x1) / 2;
  const len = r[3] - r[1];
  // planks laid from the near (max z) bank outward, the way you'd build it
  const n = Math.floor(len / 0.34);
  for (let i = 0; i < n; i++) {
    const t = 1 - (i + 0.5) / n;
    const z = r[1] + t * len;
    const y = h(t) - 0.08;
    const yaw = (rnd() - 0.5) * 0.08;
    const pw = w * (0.92 + rnd() * 0.1);
    pieces.push(box(cx + (rnd() - 0.5) * 0.08, y, z, pw, 0.09, 0.27, yaw, rnd, 0.015));
    sb.line(cx - pw / 2, y + 0.09, z - 0.13, cx + pw / 2, y + 0.09, z - 0.13, 1);
    if (i % 2 === 0) sb.line(cx - pw / 2, y + 0.09, z + 0.13, cx + pw / 2, y + 0.09, z + 0.13, 1);
  }
  // stringers under the deck
  for (const sx of [x0 + 0.2, x1 - 0.2]) {
    const seg = 8;
    for (let k = 0; k < seg; k++) {
      const ta = k / seg;
      const tb = (k + 1) / seg;
      const za = r[1] + ta * len;
      const zb = r[1] + tb * len;
      const ya = h(ta) - 0.28;
      const yb = h(tb) - 0.28;
      const g = box(sx, 0, 0, 0.14, 0.2, Math.hypot(zb - za, yb - ya) + 0.02);
      g.rotateX(-Math.atan2(yb - ya, zb - za));
      g.translate(0, (ya + yb) / 2, (za + zb) / 2);
      pieces.splice(Math.floor(pieces.length * (1 - (ta + tb) / 2)), 0, g);
    }
    sb.poly(
      Array.from({ length: 9 }, (_, k) => [sx, h(k / 8) - 0.18, r[1] + (k / 8) * len]).flat(),
      false,
      2,
    );
  }
  // posts + rope rails
  const posts = Math.max(3, Math.round(len / 1.7));
  const railPts: number[][] = [[], []];
  for (let i = 0; i <= posts; i++) {
    const t = 1 - i / posts;
    const z = r[1] + t * len;
    const y = h(t);
    for (let s = 0; s < 2; s++) {
      const px = s === 0 ? x0 - 0.05 : x1 + 0.05;
      const ph = 0.95 + rnd() * 0.15;
      pieces.splice(
        Math.floor((i / posts) * pieces.length),
        0,
        box(px, y - 0.3, z, 0.12, ph + 0.3, 0.12, rnd() * 0.3, rnd, 0.02),
      );
      sb.line(px, y - 0.3, z, px, y + ph, z, 2);
      railPts[s]!.push(px, y + ph - 0.08, z);
    }
  }
  for (let s = 0; s < 2; s++) {
    const pts = railPts[s]!;
    for (let i = 0; i < pts.length / 3 - 1; i++) {
      const ax = pts[i * 3]!;
      const ay = pts[i * 3 + 1]!;
      const az = pts[i * 3 + 2]!;
      const bx = pts[i * 3 + 3]!;
      const by = pts[i * 3 + 4]!;
      const bz = pts[i * 3 + 5]!;
      // sagging rope: 3 short pieces
      for (let k = 0; k < 3; k++) {
        const ta = k / 3;
        const tb = (k + 1) / 3;
        const sag = (t: number) => -Math.sin(t * Math.PI) * 0.16;
        const za = az + (bz - az) * ta;
        const zb = az + (bz - az) * tb;
        const ya = ay + (by - ay) * ta + sag(ta);
        const yb = ay + (by - ay) * tb + sag(tb);
        const g = box(0, 0, 0, 0.05, 0.05, Math.hypot(zb - za, yb - ya) + 0.02);
        g.rotateX(-Math.atan2(yb - ya, zb - za));
        g.translate(ax, (ya + yb) / 2 - 0.025, (za + zb) / 2);
        pieces.push(g);
        sb.line(ax, ya, za, bx, yb, zb, 1);
      }
    }
  }
  // construction guidelines overshooting both banks
  sb.line(x0, h(0) + 0.05, r[1] - 1.2, x0, h(1) + 0.05, r[3] + 1.2, 1);
  sb.line(x1, h(0) + 0.05, r[1] - 1.2, x1, h(1) + 0.05, r[3] + 1.2, 1);
  return { pieces, ramp: 'staff', strokes: sb, movers: [], splat: [cx, h(1) + 0.02, r[3] - 0.6, 1.5] };
}

function stairsParts(def: SketchObjectDef, ground: (x: number, z: number) => number): Parts {
  const rnd = makeRng(4242);
  const r = def.unlocks ?? [def.at[0] - 1.2, def.at[2] - 2.5, def.at[0] + 1.2, def.at[2] + 2.5];
  const sb = new StrokeBuilder(77);
  const pieces: THREE.BufferGeometry[] = [];
  const x0 = r[0] + 0.05;
  const x1 = r[2] - 0.05;
  const cx = (x0 + x1) / 2;
  const w = x1 - x0;
  const len = r[3] - r[1];
  const n = Math.max(4, Math.round(len / 0.4));
  const gmax = (z: number) => Math.max(ground(x0, z), ground(cx, z), ground(x1, z));
  const top: number[] = [];
  for (let i = 0; i < n; i++) {
    // bottom (max z) → top (min z)
    const zNear = r[3] - (i / n) * len;
    const zFar = r[3] - ((i + 1) / n) * len;
    const yTop = gmax(zFar) + 0.06;
    const yBase = Math.min(ground(cx, zNear), yTop - 0.25) - 0.35;
    const depth = zNear - zFar + 0.02;
    pieces.push(
      box(
        cx,
        yBase,
        (zNear + zFar) / 2,
        w * (0.96 + rnd() * 0.05),
        yTop - yBase,
        depth,
        (rnd() - 0.5) * 0.04,
        rnd,
        0.02,
      ),
    );
    sb.line(x0, yTop, zNear, x1, yTop, zNear, 2);
    sb.line(x0, yTop, zNear, x0, yTop, zFar, 1);
    sb.line(x1, yTop, zNear, x1, yTop, zFar, 1);
    top.push(yTop);
  }
  // stringer walls on both sides
  for (const sx of [x0 - 0.12, x1 + 0.12]) {
    const pts: number[] = [];
    for (let i = 0; i <= n; i++) {
      const z = r[3] - (i / n) * len;
      pts.push(sx, (top[Math.min(n - 1, i)] ?? 0) + 0.18, z);
    }
    sb.poly(pts, false, 2);
    for (let i = 0; i < n; i++) {
      const zNear = r[3] - (i / n) * len;
      const zFar = r[3] - ((i + 1) / n) * len;
      const yt = top[i]! + 0.18;
      pieces.splice(
        i * 2 + 1,
        0,
        box(
          sx,
          ground(sx, zNear) - 0.4,
          (zNear + zFar) / 2,
          0.16,
          yt - ground(sx, zNear) + 0.4,
          zNear - zFar + 0.03,
          0,
          rnd,
          0.02,
        ),
      );
    }
  }
  return {
    pieces,
    ramp: 'staff',
    strokes: sb,
    movers: [],
    splat: [cx, ground(cx, r[3]) + 0.02, r[3] + 0.4, 1.3],
  };
}

function gateParts(def: SketchObjectDef, ground: (x: number, z: number) => number, big: boolean): Parts {
  const rnd = makeRng(big ? 999 : 555);
  const [gx, , gz] = def.at;
  const open = def.size ?? (big ? 4.2 : 3.2);
  const y0 = ground(gx, gz);
  const sb = new StrokeBuilder(big ? 31 : 37);
  const pieces: THREE.BufferGeometry[] = [];
  const hpost = big ? 4.6 : 2.6;
  const pw = big ? 0.75 : 0.42;
  const half = open / 2;
  // posts
  for (const s of [-1, 1]) {
    const px = gx + s * (half + pw / 2);
    pieces.push(box(px, y0 - 0.3, gz, pw, hpost + 0.3, pw, 0, rnd, 0.03));
    pieces.push(box(px, y0 + hpost, gz, pw * 1.35, 0.22, pw * 1.35, 0.1, rnd, 0.03));
    sb.box(px, y0, gz, pw, hpost, pw, 0, 1);
  }
  if (big) {
    // lintel + keystone arch
    pieces.push(box(gx, y0 + hpost - 0.1, gz, open + pw * 2.4, 0.5, pw * 1.1, 0, rnd, 0.04));
    pieces.push(box(gx, y0 + hpost + 0.4, gz, 0.7, 0.6, pw * 1.15, 0, rnd, 0.04));
    sb.box(gx, y0 + hpost - 0.1, gz, open + pw * 2.4, 0.5, pw * 1.1, 0, 2);
  }
  // door leaves, hinged at the posts, swinging away from the player (−Z)
  const movers: Parts['movers'] = [];
  const leafH = big ? hpost - 0.3 : 1.9;
  for (const s of [-1, 1]) {
    const hinge = new THREE.Vector3(gx + s * half, y0, gz);
    const parts: THREE.BufferGeometry[] = [];
    const lw = half - 0.04;
    const bars = big ? 5 : 4;
    for (let b = 0; b <= bars; b++) {
      const lx = -s * (0.08 + (b / bars) * (lw - 0.16));
      const bh = leafH * (b % 2 ? 0.96 : 1) + (big ? 0 : Math.sin(b * 1.3) * 0.12);
      parts.push(box(lx, 0.05, 0, big ? 0.16 : 0.07, bh, big ? 0.14 : 0.07, 0, rnd, 0.01));
      sb.line(hinge.x + lx, y0 + 0.05, gz, hinge.x + lx, y0 + bh, gz, 1);
    }
    for (const yy of big ? [0.4, leafH * 0.5, leafH - 0.25] : [0.35, 1.45]) {
      parts.push(box(-s * lw * 0.5, yy, 0, lw, big ? 0.22 : 0.1, big ? 0.16 : 0.08, 0, rnd, 0.01));
      sb.line(hinge.x, y0 + yy, gz, hinge.x - s * lw, y0 + yy, gz, 1);
    }
    if (!big) {
      // diagonal brace
      const d = box(0, -0.04, 0, 0.07, Math.hypot(lw, 1.1), 0.07);
      d.rotateZ(s * Math.atan2(lw, 1.1));
      d.translate(-s * lw * 0.5, 0.35, 0);
      parts.push(d);
    }
    const geo = merge(parts)!;
    movers.push({ geo, hinge, open: s * (big ? 1.45 : 1.75), ramp: big ? 'red' : 'staff' });
    // swing arc guide on the ground
    const arc: number[] = [];
    for (let k = 0; k <= 10; k++) {
      const a = (k / 10) * 1.6;
      arc.push(hinge.x - s * Math.cos(a) * lw, y0 + 0.04, gz - Math.sin(a) * lw);
    }
    sb.poly(arc, false, 1);
  }
  return { pieces, ramp: 'staff', strokes: sb, movers, splat: [gx, y0 + 0.02, gz + 0.8, big ? 3.2 : 2.2] };
}

function weakpointParts(def: SketchObjectDef): Parts {
  const [x, y, z] = def.at;
  const sb = new StrokeBuilder(5);
  const s = def.size ?? 0.8;
  const g = new THREE.OctahedronGeometry(s * 0.55, 0);
  g.scale(0.8, 1.3, 0.8);
  g.translate(x, y, z);
  const ring: number[] = [];
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    ring.push(x + Math.cos(a) * s, y + Math.sin(a) * s, z);
  }
  sb.poly(ring, true, 2);
  sb.line(x - s * 1.4, y, z, x + s * 1.4, y, z, 1).line(x, y - s * 1.4, z, x, y + s * 1.4, z, 1);
  sb.poly([x, y + s * 0.72, z, x + s * 0.44, y, z, x, y - s * 0.72, z, x - s * 0.44, y, z], true, 2);
  return { pieces: [g], ramp: 'red', strokes: sb, movers: [], splat: [x, y, z, 0] };
}

/** Pencil ring on the ground showing "hold the crystal wide inside here". */
function reachRing(def: SketchObjectDef, ground: (x: number, z: number) => number): StrokeBuilder {
  const sb = new StrokeBuilder(def.id.length * 7 + 3);
  const R = TUNING.sketch.requiredRadius * 0.62;
  const pts: number[] = [];
  const n = 56;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const x = def.at[0] + Math.cos(a) * R;
    const z = def.at[2] + Math.sin(a) * R;
    pts.push(x, ground(x, z) + 0.06, z);
  }
  sb.poly(pts, true, 1);
  return sb;
}

/**
 * Builds the pencil + ink visual for a sketch. Ink pieces appear in build order as progress
 * rises (drawRange), then the stamp punches the whole object and splats an ink stain beneath.
 */
export function createSketchVisual(def: SketchObjectDef, deps: SketchVisualDeps): SketchVisual {
  const parts =
    def.type === 'bridge'
      ? bridgeParts(def, deps.ground)
      : def.type === 'stairs'
        ? stairsParts(def, deps.ground)
        : def.type === 'gate'
          ? gateParts(def, deps.ground, false)
          : def.type === 'bossDoor'
            ? gateParts(def, deps.ground, true)
            : weakpointParts(def);

  const root = new THREE.Group();
  root.name = `sketch:${def.id}`;
  deps.parent.add(root);

  // ordered fill geometry
  const cleaned = parts.pieces.map(clean);
  const offsets: number[] = [0];
  for (const g of cleaned) offsets.push(offsets[offsets.length - 1]! + g.attributes.position!.count);
  const fillGeo = merge(cleaned)!;
  const fill = new THREE.Mesh(fillGeo, deps.material({ ramp: parts.ramp, keyAmt: 0.8, glowAmt: 1.2 }));
  fill.geometry.setDrawRange(0, 0);
  fill.frustumCulled = false;
  const fillPivot = new THREE.Group();
  const [sx, sy, sz] = [parts.splat[0], parts.splat[1], parts.splat[2]];
  fillPivot.position.set(sx, sy, sz);
  fill.position.set(-sx, -sy, -sz);
  fillPivot.add(fill);
  root.add(fillPivot);

  const movers: (Mover & { mesh: THREE.Mesh })[] = parts.movers.map((m, i) => {
    const pivot = new THREE.Group();
    pivot.position.copy(m.hinge);
    const geo = m.geo;
    geo.translate(0, 0, 0);
    const mesh = new THREE.Mesh(geo, deps.material({ ramp: m.ramp, keyAmt: 0.8, glowAmt: 1.2 }));
    mesh.visible = false;
    pivot.add(mesh);
    root.add(pivot);
    return { pivot, axis: 'y', open: m.open, showAt: 0.55 + i * 0.2, mesh };
  });

  const pencil = createPencilMaterial(deps.resolution, { width: def.type === 'weakpoint' ? 2.2 : 1.7 });
  const lines = new THREE.Mesh(parts.strokes.build(), pencil.mat);
  lines.frustumCulled = false;
  lines.renderOrder = 2;
  lines.userData.noOutline = true;
  root.add(lines);

  let ring: THREE.Mesh | null = null;
  let ringMat: ReturnType<typeof createPencilMaterial> | null = null;
  if (def.type !== 'weakpoint') {
    ringMat = createPencilMaterial(deps.resolution, { width: 1.3, lead: PAL.ghost[1] });
    ringMat.uniforms.uDash.value = 1.1;
    ring = new THREE.Mesh(reachRing(def, deps.ground).build(), ringMat.mat);
    ring.frustumCulled = false;
    ring.userData.noOutline = true;
    root.add(ring);
  }

  let splat: THREE.Mesh | null = null;
  if (parts.splat[3] > 0) {
    const [px, py, pz] = [parts.splat[0], parts.splat[1], parts.splat[2]];
    const g = merge(splatGeo(0, 0, 0, parts.splat[3], makeRng(def.id.length * 3 + 1)))!;
    // drape over the ground (local to the splat centre so the grow animation scales XZ only)
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) p.setY(i, deps.ground(px + p.getX(i), pz + p.getZ(i)) + 0.04 - py);
    splat = new THREE.Mesh(g, deps.inkMat);
    splat.position.set(px, py, pz);
    splat.scale.set(0.001, 1, 0.001);
    splat.visible = false;
    root.add(splat);
  }

  let progress = 0;
  let stampT = -1;
  let fade = 0;
  const S = TUNING.sketch;

  return {
    setProgress(t) {
      progress = t;
      const k = Math.min(cleaned.length, Math.floor(t * 1.04 * cleaned.length));
      fill.geometry.setDrawRange(0, offsets[k]!);
      for (const m of movers) m.mesh.visible = t >= m.showAt;
      pencil.uniforms.uProgress.value = t;
      if (ringMat) ringMat.uniforms.uProgress.value = t * 0.5;
    },
    stamp() {
      stampT = 0;
      fill.geometry.setDrawRange(0, Infinity);
      for (const m of movers) m.mesh.visible = true;
      if (splat) splat.visible = true;
    },
    update(dt, time) {
      const boil = Math.floor(time * TUNING.boil.hz) * 0.37;
      pencil.uniforms.uBoil.value = boil;
      if (ringMat) ringMat.uniforms.uBoil.value = boil;
      if (stampT >= 0) {
        stampT += dt;
        const u = Math.min(1, stampT / S.stampDuration);
        // punch: squash down hard, overshoot up, settle (a rubber-stamp hit)
        const punch =
          u < 0.3 ? 1 - (u / 0.3) * 0.18 : 0.82 + 0.18 * (1 + Math.sin((u - 0.3) * 9) * (1 - u) * 0.9);
        fillPivot.scale.set(1 + (1 - punch) * 0.4, punch, 1 + (1 - punch) * 0.4);
        if (splat) {
          const k = Math.min(1, stampT / (S.stampDuration * 0.6)) ** 0.5 + 0.001;
          splat.scale.set(k, 1, k);
        }
        fade = Math.min(1, stampT / 0.8);
        pencil.uniforms.uFade.value = fade;
        if (ringMat) ringMat.uniforms.uFade.value = fade;
        const g = Math.min(1, Math.max(0, (stampT - S.stampDuration * 0.5) / S.gateOpenTime));
        const e = 1 - (1 - g) ** 3;
        for (const m of movers) m.pivot.rotation.y = m.open * e;
        if (fade >= 1) {
          lines.visible = false;
          if (ring) ring.visible = false;
        }
        if (u >= 1 && fade >= 1 && g >= 1) stampT = -2; // settled
      }
      if (stampT === -2) fillPivot.scale.set(1, 1, 1);
      if (progress > 0 && progress < 1 && stampT < 0) {
        // nervous tremor while ink floods in
        const j = Math.sin(time * 41) * 0.006 * progress;
        fillPivot.position.y = sy + j;
      }
    },
    dispose() {
      root.removeFromParent();
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          if (m.material !== deps.inkMat) (m.material as THREE.Material).dispose();
        }
      });
    },
  };
}
