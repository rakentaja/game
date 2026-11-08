/**
 * THE EDITOR: Quaternius Universal Base Character (male) on the UAL skeleton, so every UAL clip
 * plays natively (no retarget). Dressed procedurally as a newsroom editor: green eyeshade visor and
 * a pencil tucked behind the ear, both rigid-skinned to the head. The eraser is a separate prop
 * (eraser.glb) attached at `socket_eraser`. Exported at human scale; the boss scales it (tuning).
 */
import type { Animation, Document, NodeIO } from '@gltf-transform/core';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { bake, ClipSampler, restMap } from '../lib/clips';
import { addPrimitive } from '../lib/geo';
import { material, pencilGeo, visorGeo } from './originals';
import { buildPath, sourcePath } from './paths';
import { readTolerant } from './props';

const UBC = 'Universal Base Characters[Standard]/Base Characters/Godot - UE/Superhero_Male_FullBody.gltf';

/** editor@<name> ← UAL clip */
export const EDITOR_CLIPS: Record<string, [lib: 'ual1' | 'ual2', clip: string]> = {
  idle: ['ual1', 'Idle_Loop'],
  guard: ['ual1', 'Sword_Idle'],
  walk: ['ual1', 'Walk_Formal_Loop'],
  sweep: ['ual2', 'Sword_Regular_A'],
  sweep_combo: ['ual2', 'Sword_Heavy_Combo'],
  slam: ['ual2', 'TreeChopping_Loop'],
  throw: ['ual2', 'OverhandThrow'],
  redraw: ['ual1', 'Spell_Simple_Idle_Loop'],
  taunt_no: ['ual2', 'Idle_No_Loop'],
  judge: ['ual2', 'Idle_FoldArms_Loop'],
  hit_react: ['ual1', 'Hit_Chest'],
  stagger: ['ual2', 'Hit_Knockback'],
  death: ['ual1', 'Death01'],
};

function find(doc: Document, name: string): Animation {
  const a = doc
    .getRoot()
    .listAnimations()
    .find((x) => x.getName() === name);
  if (!a) throw new Error(`clip ${name} not found`);
  return a;
}

export async function buildBoss(io: NodeIO): Promise<string> {
  const doc = await readTolerant(io, sourcePath('quaternius-ubc', UBC));
  const libs = {
    ual1: await io.read(
      sourcePath('quaternius-ual1', 'Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb'),
    ),
    ual2: await io.read(
      sourcePath('quaternius-ual2', 'Universal Animation Library 2[Standard]/Unreal-Godot/UAL2_Standard.glb'),
    ),
  };
  for (const a of doc.getRoot().listAnimations()) a.dispose();
  const rest = restMap(doc);
  for (const [name, [lib, clip]] of Object.entries(EDITOR_CLIPS)) {
    const s = new ClipSampler(find(libs[lib], clip), rest);
    const translate = [...s.tracks.entries()].filter(([b, t]) => t.t && rest.has(b)).map(([b]) => b);
    bake(doc, `editor@${name}`, s.duration, (b, t) => s.at(b, t), { translate });
  }
  dress(doc);
  const out = buildPath('editor.glb');
  await io.write(out, doc);
  return out;
}

/** Bind-pose world matrix of a joint (inverse of its inverse bind matrix). */
function bindMatrix(doc: Document, joint: string): { m: Matrix4; index: number } {
  const skin = doc.getRoot().listSkins()[0]!;
  const joints = skin.listJoints();
  const index = joints.findIndex((j) => j.getName() === joint);
  const ibm = skin.getInverseBindMatrices()!.getArray()!;
  const m = new Matrix4().fromArray(Array.from(ibm.slice(index * 16, index * 16 + 16))).invert();
  return { m, index };
}

function dress(doc: Document): void {
  const root = doc.getRoot();
  const skin = root.listSkins()[0]!;
  const bodyNode = root.listNodes().find((n) => n.getSkin() && n.getMesh())!;
  const body = bodyNode.getMesh()!;
  const { m: head, index: headJ } = bindMatrix(doc, 'Head');
  const headPos = new Vector3().setFromMatrixPosition(head);

  // Head size from the vertices skinned mostly to the head.
  const prim = body.listPrimitives().find((p) => p.getAttribute('JOINTS_0'))!;
  const P = prim.getAttribute('POSITION')!;
  const J = prim.getAttribute('JOINTS_0')!;
  const W = prim.getAttribute('WEIGHTS_0')!;
  let minY = Infinity;
  let maxY = -Infinity;
  let rad = 0;
  const v = new Vector3();
  const j = [0, 0, 0, 0];
  const w = [0, 0, 0, 0];
  for (let i = 0; i < P.getCount(); i++) {
    J.getElement(i, j);
    W.getElement(i, w);
    const k = j.findIndex((x, n) => x === headJ && w[n]! > 0.6);
    if (k < 0) continue;
    v.fromArray(P.getElement(i, [0, 0, 0]));
    minY = Math.min(minY, v.y);
    maxY = Math.max(maxY, v.y);
    rad = Math.max(rad, Math.hypot(v.x - headPos.x, v.z - headPos.z));
  }
  const headH = maxY - minY;
  const brow = minY + headH * 0.62;
  const r = rad * 0.92;
  // Visor ring sits around the brow, brim facing +Z (character forward).
  const { band, brim } = visorGeo();
  const visorM = new Matrix4()
    .makeTranslation(headPos.x, brow, headPos.z + r * 0.05)
    .multiply(new Matrix4().makeScale(r, r * 0.9, r * 1.05));
  const visor = doc.createMesh('editor_visor');
  addPrimitive(doc, visor, band.apply(visorM), material(doc, 'visor_band', [0.12, 0.2, 0.18]), {
    joint: headJ,
  });
  addPrimitive(doc, visor, brim.apply(visorM), material(doc, 'visor', [0.27, 0.55, 0.45]), { joint: headJ });

  // Pencil behind the right ear, angled back.
  const { wood, paint, lead, ferrule } = pencilGeo();
  const len = headH * 0.9;
  const pm = new Matrix4()
    .makeTranslation(headPos.x - r * 1.0, brow - headH * 0.02, headPos.z - r * 0.1)
    .multiply(
      new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 1.25)),
    )
    .multiply(new Matrix4().makeRotationZ(0.35))
    .multiply(new Matrix4().makeScale(len, len, len));
  const pencil = doc.createMesh('editor_pencil');
  addPrimitive(doc, pencil, paint.apply(pm), material(doc, 'pencil_paint', [0.86, 0.66, 0.2]), {
    joint: headJ,
  });
  addPrimitive(doc, pencil, wood.apply(pm), material(doc, 'pencil_wood', [0.84, 0.68, 0.5]), {
    joint: headJ,
  });
  addPrimitive(doc, pencil, lead.apply(pm), material(doc, 'pencil_lead', [0.1, 0.1, 0.1]), { joint: headJ });
  addPrimitive(doc, pencil, ferrule.apply(pm), material(doc, 'pencil_ferrule', [0.6, 0.6, 0.58]), {
    joint: headJ,
  });

  const parent = bodyNode.getParentNode();
  for (const mesh of [visor, pencil]) {
    const n = doc.createNode(mesh.getName()).setMesh(mesh).setSkin(skin);
    if (parent) parent.addChild(n);
    else root.listScenes()[0]!.addChild(n);
  }

  // Sockets: eraser grip in the right palm, head top.
  const handR = root.listNodes().find((n) => n.getName() === 'hand_r')!;
  handR.addChild(doc.createNode('socket_eraser').setTranslation([0, 0.09, 0.02]));
  const headNode = root.listNodes().find((n) => n.getName() === 'Head')!;
  headNode.addChild(doc.createNode('socket_head').setTranslation([0, headH, 0]));

  for (const m of root.listMaterials()) {
    const nm = m.getName();
    if (/Superhero/i.test(nm)) m.setName('skin');
    else if (/Eyes/i.test(nm)) m.setName('eyes');
    else if (/Hair/i.test(nm)) m.setName('brows');
  }
  const armature = root
    .listScenes()[0]!
    .listChildren()
    .find((n) => !n.getMesh())!;
  armature?.setName('editor');
}
