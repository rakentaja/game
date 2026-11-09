/**
 * Ink Rain storm (page 3): every drop that hits the page is a tiny short-lived reveal source
 * (pooled in RevealSystem's fixed slots, ~20/s × 0.4 s, only spent while plenty are free), the
 * falling streaks are ONE instanced mesh animated entirely in the vertex shader (zero CPU per
 * frame), and lightning prints the frame in two tones for 2–3 frames while a wide short reveal
 * flash exposes hidden ghosts. One pulse per strike, strikes ≥ 7 s apart (≪ 3 Hz); the post
 * flash is skipped under reduce motion (the reveal still happens — it's gameplay).
 */
import * as THREE from 'three';
import { PAL } from '../../data/palette';
import { TUNING } from '../../data/tuning';

export interface RainReveal {
  readonly center: THREE.Vector3;
  addSource(x: number, z: number, radius: number, life: number): number;
  freeSources?(): number;
}

export interface RainRender {
  readonly scene: THREE.Scene;
  readonly shared: Record<string, THREE.IUniform>;
  flash?: number;
  reduceMotion?: boolean;
  onFrame?(fn: (dt: number) => void): () => void;
  qualityProfile?: { fxScale: number };
}

const STREAK_VERT = /* glsl */ `
attribute vec3 aSeed; // x, z in 0..1, phase
uniform vec3 uCenter;
uniform float uTime, uBox, uHeight, uSpeed;
varying float vFade;
void main() {
  float fall = fract(aSeed.z - uTime * uSpeed / uHeight);
  vec3 c = uCenter + vec3((aSeed.x - 0.5) * uBox, fall * uHeight, (aSeed.y - 0.5) * uBox);
  // slanted streak, widened sideways toward the camera
  vec3 view = normalize(cameraPosition - c);
  vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), view));
  vec3 dir = normalize(vec3(0.18, -1.0, 0.06));
  vec3 p = c + dir * position.y * 0.7 + side * position.x * 0.016;
  vFade = smoothstep(0.0, 0.12, fall) * (1.0 - smoothstep(0.85, 1.0, fall));
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const STREAK_FRAG = /* glsl */ `
uniform vec3 uInk;
varying float vFade;
void main() {
  if (vFade < 0.35) discard;
  gl_FragColor = vec4(uInk, 1.0);
}
`;

export class InkRain {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private dropAcc = 0;
  private strikeIn: number;
  private flashLeft = 0;
  private readonly offFrame: (() => void) | null;
  /** Lightning strikes so far (tests / debug). */
  strikes = 0;

  constructor(
    private readonly render: RainRender,
    private readonly reveal: RainReveal,
    private readonly rng: () => number = Math.random,
  ) {
    const R = TUNING.worldMeta.inkRain;
    const count = Math.max(16, Math.round(R.streaks * (render.qualityProfile?.fxScale ?? 1)));
    const base = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = base.index;
    this.geo.setAttribute('position', base.getAttribute('position'));
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < seeds.length; i++) seeds[i] = this.rng();
    this.geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
    this.geo.instanceCount = count;
    this.mat = new THREE.ShaderMaterial({
      name: 'InkRain',
      uniforms: {
        uCenter: { value: new THREE.Vector3() },
        uTime: render.shared.uTime ?? { value: 0 },
        uBox: { value: R.streakBox },
        uHeight: { value: R.streakHeight },
        uSpeed: { value: R.streakSpeed },
        uInk: { value: new THREE.Color(PAL.ink) },
      },
      vertexShader: STREAK_VERT,
      fragmentShader: STREAK_FRAG,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'ink-rain';
    this.mesh.userData.noOutline = true;
    render.scene.add(this.mesh);
    this.strikeIn = this.nextStrike();
    this.offFrame = render.onFrame ? render.onFrame(() => this.frame()) : null;
  }

  private nextStrike(): number {
    const R = TUNING.worldMeta.inkRain;
    return R.lightningMin + this.rng() * Math.max(0, R.lightningMax - R.lightningMin);
  }

  /** Per sim step. */
  update(dt: number): void {
    const R = TUNING.worldMeta.inkRain;
    const c = this.reveal.center;
    (this.mat.uniforms.uCenter!.value as THREE.Vector3).set(c.x, c.y - 1, c.z);
    this.dropAcc += dt * R.dropsPerSec;
    while (this.dropAcc >= 1) {
      this.dropAcc -= 1;
      const free = this.reveal.freeSources ? this.reveal.freeSources() : 0;
      if (free < R.minFreeSources) continue;
      const a = this.rng() * Math.PI * 2;
      const r = Math.sqrt(this.rng()) * R.dropSpread;
      this.reveal.addSource(
        c.x + Math.cos(a) * r,
        c.z + Math.sin(a) * r,
        R.dropRadius * (0.7 + this.rng() * 0.6),
        R.dropLife,
      );
    }
    this.strikeIn -= dt;
    if (this.strikeIn <= 0) this.strike();
  }

  /** Lightning: a wide brief reveal (gameplay) + a 2–3 frame two-tone print (visual). */
  strike(): void {
    const R = TUNING.worldMeta.inkRain;
    this.strikeIn = this.nextStrike();
    this.strikes++;
    const c = this.reveal.center;
    this.reveal.addSource(c.x, c.z, R.flashRevealRadius, R.flashRevealLife);
    if (!this.render.reduceMotion) this.flashLeft = Math.max(2, Math.min(3, R.flashFrames));
  }

  /** Per rendered frame: count the flash down in frames, not seconds. */
  private frame(): void {
    if (this.flashLeft > 0) {
      this.render.flash = 1;
      this.flashLeft--;
    } else if (this.render.flash) this.render.flash = 0;
  }

  dispose(): void {
    this.offFrame?.();
    if (this.render.flash) this.render.flash = 0;
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}
