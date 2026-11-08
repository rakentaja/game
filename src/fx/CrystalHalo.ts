/**
 * Crystal halo: a camera-facing disc of screen-space halftone dots + a flickering core ring and
 * slow rays, all in glowCore / glowEdge. Crisp (discard), so it stays inside the palette.
 */
import * as THREE from 'three';
import { PAL } from '../data/palette';

const VERT = /* glsl */ `
uniform float uSize;
varying vec2 vP;
void main() {
  vP = position.xy * 2.0;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uCore, uEdge;
uniform float uTime, uDpr, uPulse, uBoilSeed;
varying vec2 vP;
void main() {
  float r = length(vP);
  if (r > 1.0) discard;
  float ang = atan(vP.y, vP.x);
  vec2 fc = gl_FragCoord.xy / uDpr;
  vec2 cell = fract(fc / 5.0) - 0.5;
  float dotR = (1.0 - smoothstep(0.15, 1.0, r)) * 0.48 * uPulse;
  bool dotOn = length(cell) < dotR;
  float ring = abs(r - (0.3 + 0.02 * sin(uTime * 9.0)));
  float rays = step(0.93, fract(ang / 6.2832 * 7.0 + uTime * 0.05 + uBoilSeed * 0.01)) * step(r, 0.82) * step(0.36, r);
  vec3 col;
  if (ring < 0.025) col = uCore;
  else if (rays > 0.5) col = uCore;
  else if (dotOn) col = uEdge;
  else discard;
  gl_FragColor = vec4(col, 0.5);
}
`;

export class CrystalHalo {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  /** World position followed each frame (e.g. reveal.center). */
  target: THREE.Vector3 | null = null;
  private pulse = 1;

  constructor(shared: Record<string, THREE.IUniform>) {
    this.material = new THREE.ShaderMaterial({
      name: 'CrystalHalo',
      uniforms: {
        uCore: { value: new THREE.Color(PAL.glowCore) },
        uEdge: { value: new THREE.Color(PAL.glowEdge) },
        uTime: shared.uTime!,
        uDpr: shared.uDpr!,
        uBoilSeed: shared.uBoilSeed!,
        uPulse: { value: 1 },
        uSize: { value: 0.9 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    this.mesh.userData.noOutline = true;
    this.mesh.name = 'fx:crystalHalo';
  }

  /** `strength` 0..1 (e.g. how far the radius is toward held). */
  update(dt: number, strength: number): void {
    if (this.target) this.mesh.position.copy(this.target);
    this.pulse += (0.55 + strength * 0.6 - this.pulse) * (1 - Math.exp(-dt * 6));
    this.material.uniforms.uPulse!.value = this.pulse;
    this.material.uniforms.uSize!.value = 0.55 + strength * 0.7;
  }
}
