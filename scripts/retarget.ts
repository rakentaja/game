/**
 * Headless animation retargeting between two glTF skeletons (gltf-transform documents, three.js
 * math). Rotation-only transfer in world space with per-bone rest alignment, plus scaled pelvis
 * translation. Handles target rigs whose IK feet are parented to the root (Quaternius 2019 rigs).
 *
 * For every mapped bone B (source S → target T):
 *   align_T   = shortest arc taking T's rest bone direction onto S's reference bone direction
 *   R'_T      = align_T · R_T^rest                (target rest re-posed into the source reference pose)
 *   delta_S(t)= R_S(t) · R_S^ref⁻¹               (world-space rotation of S away from its reference)
 *   R_T(t)    = delta_S(t) · R'_T
 * Unmapped target bones keep their (aligned) local rotation. Output is a new glTF Animation on the
 * target document, sampled at a fixed rate with LINEAR interpolation.
 */
import type { Animation, AnimationChannel, Document, Node } from '@gltf-transform/core';
import { Matrix4, Quaternion, Vector3 } from 'three';

export type BoneMap = Record<string, string>; // target bone name → source bone name

interface Pose {
  /** world rotation / position per bone name */
  rot: Map<string, Quaternion>;
  pos: Map<string, Vector3>;
}

interface Bone {
  name: string;
  node: Node;
  parent: string | null;
  t: Vector3;
  r: Quaternion;
  s: Vector3;
}

/** Ordered (parents first) bone list for every node reachable from the scene roots. */
export function skeletonOf(doc: Document): Bone[] {
  const out: Bone[] = [];
  const visit = (n: Node, parent: string | null) => {
    out.push({
      name: n.getName(),
      node: n,
      parent,
      t: new Vector3(...n.getTranslation()),
      r: new Quaternion(...n.getRotation()),
      s: new Vector3(...n.getScale()),
    });
    for (const c of n.listChildren()) visit(c, n.getName());
  };
  for (const scene of doc.getRoot().listScenes()) for (const n of scene.listChildren()) visit(n, null);
  return out;
}

export type Track = { times: Float32Array; values: Float32Array; interp: string };
export type ClipTracks = Map<string, { t?: Track; r?: Track; s?: Track }>;

export function tracksOf(anim: Animation): ClipTracks {
  const m: ClipTracks = new Map();
  for (const ch of anim.listChannels()) {
    const node = ch.getTargetNode();
    const s = ch.getSampler();
    if (!node || !s) continue;
    const path = ch.getTargetPath();
    const e = m.get(node.getName()) ?? {};
    const tr: Track = {
      times: s.getInput()!.getArray() as Float32Array,
      values: s.getOutput()!.getArray() as Float32Array,
      interp: s.getInterpolation(),
    };
    if (path === 'translation') e.t = tr;
    else if (path === 'rotation') e.r = tr;
    else if (path === 'scale') e.s = tr;
    m.set(node.getName(), e);
  }
  return m;
}

export function clipDuration(anim: Animation): number {
  let d = 0;
  for (const s of anim.listSamplers()) d = Math.max(d, s.getInput()!.getMax([0])[0]!);
  return d;
}

const _qa = new Quaternion();
const _qb = new Quaternion();

/** Sample a track at time t. CUBICSPLINE samples are read as their value element only. */
export function sample(tr: Track, t: number, stride: number, out: number[]): void {
  const { times, values, interp } = tr;
  const cubic = interp === 'CUBICSPLINE';
  const elem = cubic ? stride * 3 : stride;
  const off = cubic ? stride : 0;
  const n = times.length;
  if (t <= times[0]! || n === 1) {
    for (let k = 0; k < stride; k++) out[k] = values[off + k]!;
    return;
  }
  if (t >= times[n - 1]!) {
    for (let k = 0; k < stride; k++) out[k] = values[(n - 1) * elem + off + k]!;
    return;
  }
  let i = 0;
  while (i < n - 2 && times[i + 1]! < t) i++;
  const t0 = times[i]!;
  const t1 = times[i + 1]!;
  const u = interp === 'STEP' ? 0 : (t - t0) / (t1 - t0);
  if (stride === 4) {
    _qa.fromArray(values, i * elem + off);
    _qb.fromArray(values, (i + 1) * elem + off);
    _qa.slerp(_qb, u);
    out[0] = _qa.x;
    out[1] = _qa.y;
    out[2] = _qa.z;
    out[3] = _qa.w;
    return;
  }
  for (let k = 0; k < stride; k++) {
    const a = values[i * elem + off + k]!;
    const b = values[(i + 1) * elem + off + k]!;
    out[k] = a + (b - a) * u;
  }
}

const tmp4 = [0, 0, 0, 0];

/** Forward kinematics of a skeleton with optional animation tracks at time t. */
export function poseAt(bones: Bone[], tracks: ClipTracks | null, t: number): Pose {
  const rot = new Map<string, Quaternion>();
  const pos = new Map<string, Vector3>();
  const scl = new Map<string, Vector3>();
  for (const b of bones) {
    const tk = tracks?.get(b.name);
    const lt = b.t.clone();
    const lr = b.r.clone();
    const ls = b.s.clone();
    if (tk?.t) {
      sample(tk.t, t, 3, tmp4);
      lt.set(tmp4[0]!, tmp4[1]!, tmp4[2]!);
    }
    if (tk?.r) {
      sample(tk.r, t, 4, tmp4);
      lr.set(tmp4[0]!, tmp4[1]!, tmp4[2]!, tmp4[3]!).normalize();
    }
    if (tk?.s) {
      sample(tk.s, t, 3, tmp4);
      ls.set(tmp4[0]!, tmp4[1]!, tmp4[2]!);
    }
    if (b.parent === null) {
      rot.set(b.name, lr);
      pos.set(b.name, lt);
      scl.set(b.name, ls);
    } else {
      const pr = rot.get(b.parent)!;
      const pp = pos.get(b.parent)!;
      const ps = scl.get(b.parent)!;
      rot.set(b.name, pr.clone().multiply(lr));
      pos.set(b.name, lt.multiply(ps).applyQuaternion(pr).add(pp));
      scl.set(b.name, ps.clone().multiply(ls));
    }
  }
  return { rot, pos };
}

export interface RetargetOptions {
  map: BoneMap;
  /** Target bone that receives the (scaled) pelvis translation, and its source counterpart. */
  hips: { target: string; source: string };
  /** Bones parented elsewhere for skinning (IK feet) but kinematically children of another bone. */
  kinematicParent?: Record<string, string>;
  /** For rest alignment: target bone → child bone used for its direction (and source equivalents). */
  alignChild?: Record<string, string>;
  /** Source reference pose clip (e.g. 'A_TPose'); defaults to the source bind pose. */
  sourceRefClip?: ClipTracks | null;
  fps?: number;
  /** Remove horizontal hip drift so the clip stays in place. */
  inPlace?: boolean;
  /** Per-bone extra world-space correction applied after transfer (radians, about world X/Y/Z). */
  loop?: boolean;
}

/**
 * Retarget `srcAnim` (in `src` doc) onto the skeleton of `dst` doc. Returns a new Animation in dst.
 */
export function retarget(
  src: Document,
  srcAnim: Animation,
  dst: Document,
  name: string,
  opt: RetargetOptions,
): Animation {
  const fps = opt.fps ?? 30;
  const sBones = skeletonOf(src);
  const tBones = skeletonOf(dst);
  const sTracks = tracksOf(srcAnim);
  const sRef = poseAt(sBones, opt.sourceRefClip ?? null, 0);
  const tRest = poseAt(tBones, null, 0);
  const tByName = new Map(tBones.map((b) => [b.name, b]));

  // Rest alignment per mapped target bone.
  const align = new Map<string, Quaternion>();
  for (const [tName, sName] of Object.entries(opt.map)) {
    const q = new Quaternion();
    const tChild = opt.alignChild?.[tName];
    const sChild = tChild ? opt.map[tChild] : undefined;
    if (tChild && sChild) {
      const dT = tRest.pos.get(tChild)!.clone().sub(tRest.pos.get(tName)!).normalize();
      const dS = sRef.pos.get(sChild)!.clone().sub(sRef.pos.get(sName)!).normalize();
      q.setFromUnitVectors(dT, dS);
    }
    align.set(tName, q);
  }

  // Aligned rest pose of the target (world rotations), and local rotations relative to it.
  const aRot = new Map<string, Quaternion>();
  const aLocal = new Map<string, Quaternion>();
  for (const b of tBones) {
    const restWorld = tRest.rot.get(b.name)!;
    const parentA = b.parent ? aRot.get(b.parent)! : new Quaternion();
    let w: Quaternion;
    if (opt.map[b.name]) w = align.get(b.name)!.clone().multiply(restWorld);
    else w = parentA.clone().multiply(b.r);
    aRot.set(b.name, w);
    aLocal.set(b.name, parentA.clone().invert().multiply(w));
  }

  // Kinematic offsets (e.g. foot relative to lower leg) measured in the original rest pose.
  const kin = new Map<string, { k: string; off: Vector3 }>();
  for (const [bone, k] of Object.entries(opt.kinematicParent ?? {})) {
    const inv = tRest.rot.get(k)!.clone().invert();
    const off = tRest.pos.get(bone)!.clone().sub(tRest.pos.get(k)!).applyQuaternion(inv);
    kin.set(bone, { k, off });
  }

  const sHipRef = sRef.pos.get(opt.hips.source)!;
  const tHipRest = tRest.pos.get(opt.hips.target)!;
  // Height scale: hip height above the lowest bone (feet) in each rest pose.
  const minY = (p: Pose) => Math.min(...[...p.pos.values()].map((v) => v.y));
  const k = (tHipRest.y - minY(tRest)) / Math.max(1e-6, sHipRef.y - minY(sRef));

  const dur = clipDuration(srcAnim);
  const frames = Math.max(2, Math.round(dur * fps) + 1);
  const times = new Float32Array(frames);
  const rotOut = new Map<string, Float32Array<ArrayBuffer>>();
  const posOut = new Map<string, Float32Array<ArrayBuffer>>();
  const writePos = new Set([opt.hips.target, ...kin.keys()]);
  for (const b of tBones) {
    if (b.node.getMesh() || b.node.getSkin()) continue;
    rotOut.set(b.name, new Float32Array(frames * 4));
    if (writePos.has(b.name)) posOut.set(b.name, new Float32Array(frames * 3));
  }

  // Linear drift of the source hips (for in-place).
  const sFirst = poseAt(sBones, sTracks, 0).pos.get(opt.hips.source)!;
  const sLast = poseAt(sBones, sTracks, dur).pos.get(opt.hips.source)!;

  // Kinematic children must be solved after their kinematic parent (they must be leaves).
  const order = [...tBones.filter((b) => !kin.has(b.name)), ...tBones.filter((b) => kin.has(b.name))];
  for (const b of tBones)
    if (kin.has(b.name) && b.node.listChildren().length)
      throw new Error(`kinematic bone ${b.name} must be a leaf`);

  for (let f = 0; f < frames; f++) {
    const t = (f / (frames - 1)) * dur;
    times[f] = t;
    const sp = poseAt(sBones, sTracks, t);
    const wRot = new Map<string, Quaternion>();
    const wPos = new Map<string, Vector3>();
    for (const b of order) {
      const sName = opt.map[b.name];
      const parentRot = b.parent ? wRot.get(b.parent)! : new Quaternion();
      const parentPos = b.parent ? wPos.get(b.parent)! : new Vector3();
      let r: Quaternion;
      if (sName && sp.rot.has(sName)) {
        const delta = sp.rot.get(sName)!.clone().multiply(sRef.rot.get(sName)!.clone().invert());
        r = delta.multiply(aRot.get(b.name)!);
      } else {
        r = parentRot.clone().multiply(aLocal.get(b.name)!);
      }
      wRot.set(b.name, r);
      let p: Vector3;
      if (b.name === opt.hips.target) {
        const d = sp.pos.get(opt.hips.source)!.clone().sub(sHipRef);
        if (opt.inPlace) {
          const u = dur > 0 ? t / dur : 0;
          d.x -= sFirst.x - sHipRef.x + (sLast.x - sFirst.x) * u;
          d.z -= sFirst.z - sHipRef.z + (sLast.z - sFirst.z) * u;
        }
        p = tHipRest.clone().add(d.multiplyScalar(k));
      } else if (kin.has(b.name)) {
        const { k: kp, off } = kin.get(b.name)!;
        // kinematic parent's world rotation, measured relative to its aligned rest, applied to rest offset
        const kr = wRot
          .get(kp)!
          .clone()
          .multiply(aRot.get(kp)!.clone().invert())
          .multiply(tRest.rot.get(kp)!);
        p = off.clone().applyQuaternion(kr).add(wPos.get(kp)!);
      } else {
        p = tByName.get(b.name)!.t.clone().applyQuaternion(parentRot).add(parentPos);
      }
      wPos.set(b.name, p);
      const ro = rotOut.get(b.name);
      if (ro) {
        const local = parentRot.clone().invert().multiply(r);
        // keep quaternion hemisphere continuous
        if (f > 0) {
          const dot =
            ro[(f - 1) * 4]! * local.x +
            ro[(f - 1) * 4 + 1]! * local.y +
            ro[(f - 1) * 4 + 2]! * local.z +
            ro[(f - 1) * 4 + 3]! * local.w;
          if (dot < 0) local.set(-local.x, -local.y, -local.z, -local.w);
        }
        ro.set([local.x, local.y, local.z, local.w], f * 4);
      }
      const po = posOut.get(b.name);
      if (po) {
        const local = p.clone().sub(parentPos).applyQuaternion(parentRot.clone().invert());
        po.set([local.x, local.y, local.z], f * 3);
      }
    }
  }

  const buffer = dst.getRoot().listBuffers()[0] ?? dst.createBuffer();
  const anim = dst.createAnimation(name);
  const input = dst.createAccessor().setType('SCALAR').setArray(times).setBuffer(buffer);
  const add = (node: Node, path: 'rotation' | 'translation', arr: Float32Array<ArrayBuffer>) => {
    const out = dst
      .createAccessor()
      .setType(path === 'rotation' ? 'VEC4' : 'VEC3')
      .setArray(arr)
      .setBuffer(buffer);
    const s = dst.createAnimationSampler().setInput(input).setOutput(out).setInterpolation('LINEAR');
    const c: AnimationChannel = dst
      .createAnimationChannel()
      .setTargetNode(node)
      .setTargetPath(path)
      .setSampler(s);
    anim.addSampler(s).addChannel(c);
  };
  for (const [n, arr] of rotOut) add(tByName.get(n)!.node, 'rotation', arr);
  for (const [n, arr] of posOut) add(tByName.get(n)!.node, 'translation', arr);
  return anim;
}

/** World matrix helper for debugging / tests. */
export function worldMatrix(p: Pose, name: string): Matrix4 {
  return new Matrix4().compose(p.pos.get(name)!, p.rot.get(name)!, new Vector3(1, 1, 1));
}
