/**
 * Wizard: the POC "Wizard" (Quaternius RPG Character Pack, CC0) on its own 32-bone rig, with its
 * native clips plus Universal Animation Library clips retargeted onto that same skeleton, and
 * bespoke clips authored from both (cast_hold_loop, victory, look_around).
 *
 * Output: assets/build/wizard.glb — all clips named `wizard@<clip>`, in place, one skeleton.
 */
import type { Animation, Document, NodeIO } from '@gltf-transform/core';
import { Box3, Quaternion, Vector3 } from 'three';
import { addEuler, bake, blendPose, ClipSampler, chain, type LocalPose, restMap, smooth } from '../lib/clips';
import { type BoneMap, poseAt, retarget, skeletonOf, tracksOf } from '../retarget';
import { buildPath, sourcePath } from './paths';

/** Quaternius RPG rig ← UAL (UE-mannequin naming). Fingers stay on the staff grip. */
export const UAL_TO_RPG: BoneMap = {
  Body: 'pelvis',
  Hips: 'spine_01',
  Abdomen: 'spine_02',
  Torso: 'spine_03',
  Neck: 'neck_01',
  Head: 'Head',
  'Shoulder.L': 'clavicle_l',
  'UpperArm.L': 'upperarm_l',
  'LowerArm.L': 'lowerarm_l',
  'Fist.L': 'hand_l',
  'Shoulder.R': 'clavicle_r',
  'UpperArm.R': 'upperarm_r',
  'LowerArm.R': 'lowerarm_r',
  'Fist.R': 'hand_r',
  'UpperLeg.L': 'thigh_l',
  'LowerLeg.L': 'calf_l',
  'Foot.L': 'foot_l',
  'UpperLeg.R': 'thigh_r',
  'LowerLeg.R': 'calf_r',
  'Foot.R': 'foot_r',
};
const ALIGN_CHILD = {
  'Shoulder.L': 'UpperArm.L',
  'UpperArm.L': 'LowerArm.L',
  'LowerArm.L': 'Fist.L',
  'Shoulder.R': 'UpperArm.R',
  'UpperArm.R': 'LowerArm.R',
  'LowerArm.R': 'Fist.R',
  'UpperLeg.L': 'LowerLeg.L',
  'LowerLeg.L': 'Foot.L',
  'UpperLeg.R': 'LowerLeg.R',
  'LowerLeg.R': 'Foot.R',
};

/** Height the wizard is normalised to (metres), as in the POC. */
export const WIZARD_HEIGHT = 1.85;

export const WIZARD_CLIPS = [
  'idle',
  'walk',
  'run',
  'dash',
  'roll',
  'cast_tap',
  'cast_hold_loop',
  'hit_react',
  'death',
  'victory',
  'look_around',
  'kneel',
  'pickup',
  'staff_attack',
] as const;

function find(doc: Document, name: string): Animation {
  const a = doc
    .getRoot()
    .listAnimations()
    .find((x) => x.getName() === name);
  if (!a) throw new Error(`clip ${name} not found`);
  return a;
}

/** Staff long axis (staff-node local, pointing to the crystal cage end) + both end points. */
function staffAxis(doc: Document): {
  dir: Vector3;
  top: Vector3;
  bottom: Vector3;
  center: Vector3;
  ax: 'x' | 'y' | 'z';
} {
  const staffNode = doc
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === 'Wizard_Staff' || n.getName() === 'staff')!;
  const sp = staffNode.getMesh()!.listPrimitives()[0]!.getAttribute('POSITION')!;
  const box = new Box3(new Vector3(...sp.getMin([0, 0, 0])), new Vector3(...sp.getMax([0, 0, 0])));
  const size = box.getSize(new Vector3());
  const ax = size.x > size.y ? (size.x > size.z ? 'x' : 'z') : size.y > size.z ? 'y' : 'z';
  const c = box.getCenter(new Vector3());
  const lo = c.clone();
  const hi = c.clone();
  lo[ax] = box.min[ax];
  hi[ax] = box.max[ax];
  // The cage end is the wider one: compare max radius near each end.
  const arr = sp.getArray()!;
  let rLo = 0;
  let rHi = 0;
  const v = new Vector3();
  for (let i = 0; i < arr.length; i += 3) {
    v.fromArray(arr, i);
    const rad = Math.hypot(...(['x', 'y', 'z'] as const).filter((k) => k !== ax).map((k) => v[k] - c[k]));
    if (v[ax] > hi[ax] - size[ax] * 0.15) rHi = Math.max(rHi, rad);
    if (v[ax] < lo[ax] + size[ax] * 0.15) rLo = Math.max(rLo, rad);
  }
  const top = rHi >= rLo ? hi : lo;
  const bottom = rHi >= rLo ? lo : hi;
  return { dir: top.clone().sub(bottom).normalize(), top, bottom, center: c, ax };
}

/**
 * Local rotation for `Fist.R` that makes the staff point along `target` (world) for a pose sampled
 * from `tracks` at time t (arm chain frozen at that pose).
 */
function uprightFist(
  doc: Document,
  tracks: ReturnType<typeof tracksOf>,
  t: number,
  target: Vector3,
): Quaternion {
  const bones = skeletonOf(doc);
  const pose = poseAt(bones, tracks, t);
  const axis = staffAxis(doc).dir.clone().applyQuaternion(pose.rot.get('Wizard_Staff')!).normalize();
  const fix = new Quaternion().setFromUnitVectors(axis, target.clone().normalize());
  const fistWorld = fix.multiply(pose.rot.get('Fist.R')!);
  return pose.rot.get('LowerArm.R')!.clone().invert().multiply(fistWorld);
}

export async function buildWizard(io: NodeIO): Promise<string> {
  const doc = await io.read(sourcePath('poc-wizard', 'poc-wizard.glb'));
  const ual1 = await io.read(
    sourcePath('quaternius-ual1', 'Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb'),
  );
  const ual2 = await io.read(
    sourcePath('quaternius-ual2', 'Universal Animation Library 2[Standard]/Unreal-Godot/UAL2_Standard.glb'),
  );
  const ref = tracksOf(find(ual1, 'A_TPose'));
  const rt = (src: Document, name: string) =>
    retarget(src, find(src, name), doc, `_rt_${name}`, {
      map: UAL_TO_RPG,
      alignChild: ALIGN_CHILD,
      hips: { target: 'Body', source: 'pelvis' },
      kinematicParent: { 'Foot.L': 'LowerLeg.L', 'Foot.R': 'LowerLeg.R' },
      sourceRefClip: ref,
      inPlace: true,
    });
  const rtRoll = rt(ual1, 'Roll');
  const rtDash = rt(ual2, 'Sword_Dash');
  const rtKneel = rt(ual1, 'Fixing_Kneeling');

  const rest = restMap(doc);
  const S = (a: Animation) => new ClipSampler(a, rest);
  const idle = S(find(doc, 'Idle'));
  const walk = S(find(doc, 'Walk'));
  const run = S(find(doc, 'Run'));
  const spell = S(find(doc, 'Spell1'));
  const staffAtk = S(find(doc, 'Staff_Attack'));
  const hit = S(find(doc, 'RecieveHit'));
  const death = S(find(doc, 'Death'));
  const pickup = S(find(doc, 'PickUp'));
  const roll = S(rtRoll);
  const dash = S(rtDash);
  const kneel = S(rtKneel);
  const TR = { translate: ['Body', 'Foot.L', 'Foot.R'] };
  const copy = (name: string, s: ClipSampler, t0 = 0, t1 = s.duration) =>
    bake(doc, `wizard@${name}`, t1 - t0, (b, t) => s.at(b, t0 + t), TR);

  copy('idle', idle);
  copy('walk', walk);
  copy('run', run);
  copy('hit_react', hit);
  copy('death', death);
  copy('pickup', pickup);
  copy('staff_attack', staffAtk);
  copy('roll', roll);
  copy('dash', dash);
  // Kneel (cinematic hold): kneeling legs from UAL Fixing_Kneeling, upright bowed torso and the
  // staff planted from idle, breathing from idle so the hold is alive.
  const legs = new Set(['Body', 'UpperLeg.L', 'LowerLeg.L', 'Foot.L', 'UpperLeg.R', 'LowerLeg.R', 'Foot.R']);
  const kneelT = kneel.duration * 0.45;
  bake(
    doc,
    'wizard@kneel',
    idle.duration,
    (b, t) => {
      const base = idle.at(b, t);
      if (legs.has(b)) {
        const k = kneel.at(b, kneelT);
        if (b === 'Body') return { t: k.t.clone().add(base.t).sub(idle.at(b, 0).t), r: k.r };
        return k;
      }
      if (b === 'Hips') return addEuler(base, 0.18, 0, 0);
      if (b === 'Neck') return addEuler(base, 0.2, 0, 0);
      if (b === 'Head') return addEuler(base, 0.25, 0, 0);
      return base;
    },
    TR,
  );
  // Tap cast: the forward thrust of Spell1, from the end of the wind-up to the recovery.
  copy('cast_tap', spell, spell.duration * 0.32, spell.duration);

  // Hold: right arm + staff raised overhead (Spell1 wind-up apex) over the idle body, with a slow
  // straining sway on the forearm so the crystal never looks frozen.
  const armR = new Set(chain(doc, 'Shoulder.R'));
  const apex = spell.duration * 0.22;
  // Staff straight up, leaning slightly forward and out, crystal well above the hat.
  const fistUp = uprightFist(doc, spell.tracks, apex, new Vector3(0.12, 1, 0.18));
  const holdBone = (b: string, t: number): LocalPose => {
    const base = idle.at(b, t);
    if (armR.has(b)) {
      const p0 = spell.at(b, apex);
      const p = b === 'Fist.R' ? { t: p0.t, r: fistUp.clone() } : p0;
      const w = (2 * Math.PI * t) / idle.duration;
      if (b === 'LowerArm.R') return addEuler(p, 0.05 * Math.sin(w * 2), 0, 0.04 * Math.sin(w * 3));
      if (b === 'Fist.R') return addEuler(p, 0.03 * Math.sin(w * 4 + 1), 0, 0);
      return p;
    }
    if (b === 'Torso') return blendPose(base, spell.at(b, apex), 0.5);
    return base;
  };
  bake(doc, 'wizard@cast_hold_loop', idle.duration, holdBone, TR);

  // Victory: thrust the staff up (0.35 s), then bounce on the beat with a proud head tilt.
  const vDur = 2.4;
  bake(
    doc,
    'wizard@victory',
    vDur,
    (b, t) => {
      const raise = smooth(t / 0.35);
      const beat = Math.max(0, Math.sin(((t - 0.35) / 0.6) * Math.PI * 2)) * smooth((t - 0.35) / 0.2);
      let p = holdBone(b, t % idle.duration);
      if (armR.has(b) || b === 'Torso') p = blendPose(idle.at(b, t % idle.duration), p, raise);
      if (b === 'Body') return { t: p.t.clone().add(new Vector3(0, 0.06 * beat, 0)), r: p.r };
      if (b === 'Head') return addEuler(p, -0.25 * raise, 0, 0.08 * beat);
      if (b === 'Shoulder.L') return addEuler(p, 0, 0, 0.35 * raise);
      return p;
    },
    TR,
  );

  // Look around: head/neck sweep left → right → centre over two idle cycles (seamless loop).
  const lDur = idle.duration * 2;
  const yawAt = (t: number) => {
    const k = [0, 0.15, 0.32, 0.5, 0.68, 0.85, 1].map((x) => x * lDur);
    const v = [0, 0.9, 0.9, -0.9, -0.9, 0, 0];
    for (let i = 0; i < k.length - 1; i++)
      if (t <= k[i + 1]!) return v[i]! + (v[i + 1]! - v[i]!) * smooth((t - k[i]!) / (k[i + 1]! - k[i]!));
    return 0;
  };
  bake(
    doc,
    'wizard@look_around',
    lDur,
    (b, t) => {
      const p = idle.at(b, t % idle.duration);
      const y = yawAt(t);
      if (b === 'Neck') return addEuler(p, 0, y * 0.45, 0);
      if (b === 'Head') return addEuler(p, -0.08 * Math.abs(y), y * 0.4, 0);
      if (b === 'Torso') return addEuler(p, 0, y * 0.18, 0);
      return p;
    },
    TR,
  );

  // Drop source clips, keep only the baked wizard@ set.
  for (const a of doc.getRoot().listAnimations()) if (!a.getName().startsWith('wizard@')) a.dispose();

  finishWizardNodes(doc);
  const out = buildPath('wizard.glb');
  await io.write(out, doc);
  return out;
}

/**
 * Normalise height, name materials for the ink renderer, stretch the chibi staff so the crystal
 * clears the head (POC behaviour), and add sockets for gameplay/FX.
 */
function finishWizardNodes(doc: Document): void {
  const root = doc.getRoot();
  const scene = root.listScenes()[0]!;
  const armature = scene.listChildren().find((n) => n.getName() === 'CharacterArmature')!;
  const body = root.listMeshes().find((m) => m.listPrimitives()[0]!.getAttribute('JOINTS_0'))!;
  const pos = body.listPrimitives()[0]!.getAttribute('POSITION')!;
  const h = pos.getMax([0, 0, 0])[1]! - pos.getMin([0, 0, 0])[1]!;
  armature.setScale([WIZARD_HEIGHT / h, WIZARD_HEIGHT / h, WIZARD_HEIGHT / h]);
  armature.setName('wizard');

  for (const m of root.listMaterials()) m.setName(/staff/i.test(m.getName()) ? 'staff' : 'robe');
  for (const n of root.listNodes()) {
    const nm = n.getName();
    if (nm === 'Wizard.001') n.setName('wizard_body');
    if (nm === 'Wizard') n.dispose();
    if (nm.startsWith('PoleTarget')) {
      // IK helpers are not skin joints: harmless, but drop them unless a skin uses them.
      const used = root.listSkins().some((s) => s.listJoints().includes(n));
      if (!used) n.dispose();
    }
  }

  // Staff: lengthen like the POC (top +38 %, bottom −25 % of its length along the long axis).
  const staffNode = root.listNodes().find((n) => n.getName() === 'Wizard_Staff')!;
  const sp = staffNode.getMesh()!.listPrimitives()[0]!.getAttribute('POSITION')!;
  const { top, bottom, center: c } = staffAxis(doc);
  const arr = sp.getArray()!;
  const v = new Vector3();
  const dir = top.clone().sub(bottom).normalize();
  const len = top.distanceTo(bottom);
  for (let i = 0; i < arr.length; i += 3) {
    v.fromArray(arr, i);
    const s = v.clone().sub(c).dot(dir);
    v.addScaledVector(dir, s > 0 ? len * 0.38 : -len * 0.25);
    v.toArray(arr, i);
  }
  sp.setArray(arr);
  top.addScaledVector(dir, len * 0.38);
  bottom.addScaledVector(dir, -len * 0.25);
  staffNode.setName('staff');

  // Sockets (empty nodes). socket_crystal: +Y points along the staff, origin just above the cage.
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir);
  const crystal = doc
    .createNode('socket_crystal')
    .setTranslation(top.clone().addScaledVector(dir, 0.14).toArray() as [number, number, number])
    .setRotation(q.toArray() as [number, number, number, number]);
  staffNode.addChild(crystal);
  const staffBottom = doc
    .createNode('socket_staff_foot')
    .setTranslation(bottom.toArray() as [number, number, number]);
  staffNode.addChild(staffBottom);
  const head = root.listNodes().find((n) => n.getName() === 'Head')!;
  head.addChild(doc.createNode('socket_head').setTranslation([0, 0.45, 0]));
  const handL = root.listNodes().find((n) => n.getName() === 'Fist.L')!;
  handL.addChild(doc.createNode('socket_hand_l').setTranslation([0, 0.12, 0]));
}
