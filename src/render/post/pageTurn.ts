/**
 * Page turn (WOW #3): the old composited frame is captured into an RT and drawn on a 64×64 grid
 * that rolls around a moving cylinder in the vertex shader. Front = old page (shaded toward the
 * fold), back = paper with faint show-through. The live new scene renders underneath; the post
 * pass darkens it just past the roll (cast shadow).
 */
import * as THREE from 'three';
import { PAL } from '../../data/palette';
import { NOISE_GLSL } from '../noise';

const CURL_VERT = /* glsl */ `
uniform vec2 uP0, uN;
uniform float uR, uAspect, uLift;
varying vec2 vUv;
varying float vTheta;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  float s = dot(p - uP0, uN);
  vec2 proj = p - uN * s;
  vec2 q = p;
  float z = 0.0;
  float th = 0.0;
  if (s > 0.0) {
    th = s / uR;
    if (th < 3.14159265) {
      q = proj + uN * uR * sin(th);
      z = uR * (1.0 - cos(th));
    } else {
      q = proj - uN * (s - 3.14159265 * uR);
      z = 2.0 * uR;
    }
  }
  vTheta = th;
  vec2 c = vec2(uAspect * 0.5, 0.5);
  q = c + (q - c) * (1.0 + z * uLift);
  gl_Position = vec4(q.x / uAspect * 2.0 - 1.0, q.y * 2.0 - 1.0, 0.5 - z * 0.4, 1.0);
}
`;

const CURL_FRAG = /* glsl */ `
${NOISE_GLSL}
uniform sampler2D tPage;
uniform vec3 uPaper, uInk, uShade1, uShade2;
uniform float uDpr;
varying vec2 vUv;
varying float vTheta;
void main() {
  vec3 col;
  vec2 fc = gl_FragCoord.xy / uDpr;
  if (gl_FrontFacing) {
    col = texture2D(tPage, vUv).rgb;
    // the rising part of the sheet turns away from the light: two printed shade bands
    float sh = smoothstep(0.0, 1.57, vTheta);
    col *= 1.0 - step(0.45, sh) * 0.18 - step(0.8, sh) * 0.16;
  } else {
    // back of the page: paper, faint mirrored show-through, pencil-hatched curvature
    vec3 thru = texture2D(tPage, vUv).rgb;
    col = mix(uPaper, thru, 0.07);
    float curv = abs(sin(vTheta));
    float h = abs(fract(dot(fc, vec2(0.7071, 0.7071)) / 4.0) - 0.5) * 2.0;
    float hatch = step(h, curv * 0.5) * step(0.25, curv);
    col = mix(col, uShade1, hatch * 0.8);
    col = mix(col, uShade2, step(0.92, curv) * step(h, 0.3));
  }
  // ink line along the fold crest and around the sheet's cut edges
  float crest = abs(vTheta - 1.5708);
  col = mix(col, uInk, step(crest, 0.05) * step(0.01, vTheta));
  vec2 eu = min(vUv, 1.0 - vUv);
  col = mix(col, uInk, step(min(eu.x, eu.y), 0.004) * step(0.01, vTheta));
  gl_FragColor = vec4(col, 1.0);
}
`;

export class PageTurnFx {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  active = false;
  t = 0;
  duration = 0.9;
  /** Animation clock starts after `swap` resolves. */
  running = false;
  /** Debug/screenshot: pin the curl at this progress (0..1) instead of animating. */
  hold: number | null = null;
  private readonly p0 = new THREE.Vector2();
  private readonly n = new THREE.Vector2();

  constructor() {
    this.material = new THREE.ShaderMaterial({
      name: 'PageCurl',
      uniforms: {
        tPage: { value: null },
        uNoise: { value: null },
        uP0: { value: this.p0 },
        uN: { value: this.n },
        uR: { value: 0.08 },
        uAspect: { value: 1 },
        uLift: { value: 0.55 },
        uDpr: { value: 1 },
        uPaper: { value: new THREE.Color(PAL.paper) },
        uInk: { value: new THREE.Color(PAL.ink) },
        uShade1: { value: new THREE.Color(PAL.ghost[1]) },
        uShade2: { value: new THREE.Color(PAL.staff[3]) },
      },
      vertexShader: CURL_VERT,
      fragmentShader: CURL_FRAG,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 64, 64), this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  /** Curl state for progress u ∈ 0..1 on a page of the given aspect. Exposed for the post shadow. */
  pose(u: number, aspect: number): { p0: THREE.Vector2; n: THREE.Vector2; r: number } {
    this.n.set(1, -0.32).normalize();
    // anticipation: the corner lifts slowly, then the sheet whips over and settles
    const e = u < 0.18 ? (u / 0.18) ** 2 * 0.08 : 0.08 + 0.92 * (1 - (1 - (u - 0.18) / 0.82) ** 2.2);
    const r = 0.07 + 0.17 * Math.sin(Math.min(1, u * 1.4) * Math.PI * 0.5);
    const a = aspect * this.n.x;
    const b = this.n.y;
    const dmax = Math.max(0, a, b, a + b);
    const dmin = Math.min(0, a, b, a + b);
    const start = dmax + 0.01;
    const end = dmin - Math.PI * r - 0.06;
    const d = start + (end - start) * e;
    this.p0.copy(this.n).multiplyScalar(d);
    return { p0: this.p0, n: this.n, r };
  }

  apply(u: number, aspect: number, dpr: number): number {
    const { r } = this.pose(u, aspect);
    const U = this.material.uniforms;
    U.uR!.value = r;
    U.uAspect!.value = aspect;
    U.uDpr!.value = dpr;
    return r;
  }
}
