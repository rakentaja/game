/**
 * One-frame paper-white impact flash: a camera-facing comic starburst (paper fill, ink rim) drawn
 * over the hit for a single rendered frame. Rate-limited by the caller (< 3 Hz) and skipped under
 * reduce-motion. One mesh, no allocations.
 */
import * as THREE from 'three';
import { PAL } from '../data/palette';

const VERT = /* glsl */ `
uniform float uSize, uRot;
varying vec2 vP;
void main() {
  vP = position.xy * 2.0;
  float c = cos(uRot), s = sin(uRot);
  vec2 q = vec2(c * position.x - s * position.y, s * position.x + c * position.y);
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += q * uSize;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uPaper, uInk;
varying vec2 vP;
void main() {
  float r = length(vP);
  float a = atan(vP.y, vP.x);
  // 9-point burst with uneven spikes
  float spikes = 0.62 + 0.3 * abs(sin(a * 4.5)) + 0.08 * sin(a * 13.0 + 0.7);
  if (r > spikes) discard;
  gl_FragColor = vec4(r > spikes - 0.07 ? uInk : uPaper, 1.0);
}
`;

export class ImpactFlash {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;
  private frames = 0;
  private rot = 0;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      name: 'ImpactFlash',
      uniforms: {
        uPaper: { value: new THREE.Color(PAL.paper) },
        uInk: { value: new THREE.Color(PAL.ink) },
        uSize: { value: 1 },
        uRot: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.userData.noOutline = true;
    this.mesh.visible = false;
    this.mesh.name = 'fx:impactFlash';
  }

  fire(x: number, y: number, z: number, size: number): void {
    this.mesh.position.set(x, y, z);
    this.rot = (this.rot + 2.39996) % (Math.PI * 2); // golden-angle spin: never the same burst twice
    this.mat.uniforms.uRot!.value = this.rot;
    this.mat.uniforms.uSize!.value = size;
    this.mesh.visible = true;
    this.frames = 2; // shown on the next draw, hidden on the one after
  }

  /** Call once per rendered frame, before drawing. */
  update(): void {
    if (this.frames <= 0) return;
    this.frames--;
    if (this.frames === 0) this.mesh.visible = false;
  }
}
