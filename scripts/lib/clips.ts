/**
 * Clip authoring on a single skeleton: sample local poses from existing clips and bake new ones
 * (trim, layer per bone set, additive procedural motion, loop blending, in-place).
 */
import type { Animation, Document, Node } from '@gltf-transform/core';
import { Euler, Quaternion, Vector3 } from 'three';
import { type ClipTracks, clipDuration, sample, tracksOf } from '../retarget';

export interface LocalPose {
  t: Vector3;
  r: Quaternion;
}
export type Pose = Map<string, LocalPose>;

export class ClipSampler {
  readonly tracks: ClipTracks;
  readonly duration: number;
  constructor(
    readonly anim: Animation,
    private readonly rest: Map<string, Node>,
  ) {
    this.tracks = tracksOf(anim);
    this.duration = clipDuration(anim);
  }
  /** Local pose of `bone` at time t (clamped). Bones without tracks return rest. */
  at(bone: string, t: number): LocalPose {
    const n = this.rest.get(bone)!;
    const tk = this.tracks.get(bone);
    const tmp = [0, 0, 0, 0];
    const tt = Math.min(Math.max(t, 0), this.duration);
    const pos = new Vector3(...n.getTranslation());
    const rot = new Quaternion(...n.getRotation());
    if (tk?.t) {
      sample(tk.t, tt, 3, tmp);
      pos.set(tmp[0]!, tmp[1]!, tmp[2]!);
    }
    if (tk?.r) {
      sample(tk.r, tt, 4, tmp);
      rot.set(tmp[0]!, tmp[1]!, tmp[2]!, tmp[3]!).normalize();
    }
    return { t: pos, r: rot };
  }
}

/** Names of all joints of the (single) skin. */
export function jointsOf(doc: Document): Node[] {
  const skin = doc.getRoot().listSkins()[0];
  if (!skin) throw new Error('document has no skin');
  return skin.listJoints();
}

export function restMap(doc: Document): Map<string, Node> {
  return new Map(jointsOf(doc).map((n) => [n.getName(), n]));
}

/** Descendant bone names of `root` (inclusive). */
export function chain(doc: Document, root: string): string[] {
  const n = restMap(doc).get(root);
  if (!n) throw new Error(`no bone ${root}`);
  const out: string[] = [];
  const visit = (x: Node) => {
    out.push(x.getName());
    for (const c of x.listChildren()) if (!c.getMesh()) visit(c);
  };
  visit(n);
  return out;
}

export interface BakeOptions {
  fps?: number;
  /** Bones that get translation channels (default: those whose source clips animate translation). */
  translate?: string[];
}

/**
 * Bake a clip of `duration` seconds by evaluating `fn(t)` → local pose per bone for every joint.
 * Quaternion hemispheres are kept continuous so LINEAR interpolation never takes the long way.
 */
export function bake(
  doc: Document,
  name: string,
  duration: number,
  fn: (bone: string, t: number) => LocalPose,
  opt: BakeOptions = {},
): Animation {
  const fps = opt.fps ?? 30;
  const frames = Math.max(2, Math.round(duration * fps) + 1);
  const joints = jointsOf(doc);
  const translate = new Set(opt.translate ?? []);
  const times = new Float32Array(frames);
  for (let f = 0; f < frames; f++) times[f] = (f / (frames - 1)) * duration;
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  const anim = doc.createAnimation(name);
  const input = doc.createAccessor().setType('SCALAR').setArray(times).setBuffer(buffer);
  for (const j of joints) {
    const bone = j.getName();
    const r = new Float32Array(frames * 4);
    const p = translate.has(bone) ? new Float32Array(frames * 3) : null;
    for (let f = 0; f < frames; f++) {
      const lp = fn(bone, times[f]!);
      const q = lp.r;
      if (
        f > 0 &&
        r[(f - 1) * 4]! * q.x +
          r[(f - 1) * 4 + 1]! * q.y +
          r[(f - 1) * 4 + 2]! * q.z +
          r[(f - 1) * 4 + 3]! * q.w <
          0
      )
        q.set(-q.x, -q.y, -q.z, -q.w);
      r.set([q.x, q.y, q.z, q.w], f * 4);
      p?.set([lp.t.x, lp.t.y, lp.t.z], f * 3);
    }
    const add = (path: 'rotation' | 'translation', arr: Float32Array<ArrayBuffer>) => {
      const out = doc
        .createAccessor()
        .setType(path === 'rotation' ? 'VEC4' : 'VEC3')
        .setArray(arr)
        .setBuffer(buffer);
      const s = doc.createAnimationSampler().setInput(input).setOutput(out).setInterpolation('LINEAR');
      anim
        .addSampler(s)
        .addChannel(doc.createAnimationChannel().setTargetNode(j).setTargetPath(path).setSampler(s));
    };
    add('rotation', r);
    if (p) add('translation', p);
  }
  return anim;
}

/** Smoothstep 0..1. */
export const smooth = (x: number) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

export function blendPose(a: LocalPose, b: LocalPose, w: number): LocalPose {
  return { t: a.t.clone().lerp(b.t, w), r: a.r.clone().slerp(b.r, w) };
}

/** Rotation about local axes (radians), applied after the base rotation. */
export function addEuler(p: LocalPose, x: number, y: number, z: number): LocalPose {
  return { t: p.t, r: p.r.clone().multiply(new Quaternion().setFromEuler(new Euler(x, y, z))) };
}

/**
 * Make a loop seamless by cross-fading the last `fade` seconds towards the first frame.
 */
export function loopFix(s: ClipSampler, bone: string, t: number, fade: number): LocalPose {
  const d = s.duration;
  const p = s.at(bone, t);
  if (t < d - fade) return p;
  const w = smooth((t - (d - fade)) / fade);
  return blendPose(p, s.at(bone, 0), w);
}
