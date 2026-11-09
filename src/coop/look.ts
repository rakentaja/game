/**
 * Co-op looks on a wizard model (ink materials expose ramp0..3): the partner wears the teal
 * ramp, a downed wizard is a pale pencil sketch ("UNFINISHED"). Palette-only colours.
 */
import * as THREE from 'three';
import { PAL, type Ramp } from '../data/palette';

type RampMat = THREE.ShaderMaterial & { userData: { coopRamp?: THREE.Color[] } };

function forEachRampMat(root: THREE.Object3D, fn: (m: RampMat) => void): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const u = (m as THREE.ShaderMaterial).uniforms;
      if (u?.ramp0 && u.ramp1 && u.ramp2 && u.ramp3) fn(m as RampMat);
    }
  });
}

/** Remember the current ramps as the wizard's "own" colours (call once after setModel). */
export function captureRamps(root: THREE.Object3D, tint: Ramp | null = null): void {
  forEachRampMat(root, (m) => {
    const u = m.uniforms;
    if (
      tint &&
      (u.ramp1!.value as THREE.Color).getHexString() !== new THREE.Color(PAL.staff[1]).getHexString()
    ) {
      for (let i = 0; i < 4; i++) (u[`ramp${i}`]!.value as THREE.Color).set(tint[i]!);
    }
    m.userData.coopRamp = [0, 1, 2, 3].map((i) => (u[`ramp${i}`]!.value as THREE.Color).clone());
  });
}

/** Pencil-sketch look on/off (restores the captured ramps when off). */
export function setSketchLook(root: THREE.Object3D, on: boolean): void {
  forEachRampMat(root, (m) => {
    const u = m.uniforms;
    const own = m.userData.coopRamp;
    for (let i = 0; i < 4; i++) {
      const c = u[`ramp${i}`]!.value as THREE.Color;
      if (on) c.set(i === 0 ? PAL.staff[2] : PAL.ghost[Math.min(3, i + 0)]!);
      else if (own?.[i]) c.copy(own[i]!);
    }
  });
}
