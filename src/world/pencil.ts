import * as THREE from 'three';
import { PAL } from '../data/palette';
import { makeRng, type Rng } from './rng';

/**
 * Hand-drawn pencil strokes as screen-space ribbons (WebGL lines are 1 px). Every segment is
 * drawn twice with a little overshoot and wobble, like a quick construction sketch, and dashed.
 * `uProgress` 0→1 closes the dashes and warms the graphite toward wet ink.
 */

const vert = /* glsl */ `
  attribute vec3 aOther;
  attribute float aSide;
  attribute float aDist;
  attribute float aSeed;
  uniform vec2 uRes;
  uniform float uWidth;
  uniform float uBoil;
  varying float vDist;
  varying float vSeed;
  varying float vSide;
  float h1(float n){ return fract(sin(n) * 43758.5453); }
  void main(){
    vDist = aDist; vSeed = aSeed; vSide = aSide;
    // 12 Hz line boil: each stroke re-rolls a tiny offset
    vec3 j = (vec3(h1(aSeed + uBoil), h1(aSeed * 1.7 + uBoil), h1(aSeed * 2.3 - uBoil)) - 0.5) * 0.035;
    vec4 a = projectionMatrix * modelViewMatrix * vec4(position + j, 1.0);
    vec4 b = projectionMatrix * modelViewMatrix * vec4(aOther + j, 1.0);
    vec2 sa = a.xy / max(a.w, 1e-4) * uRes;
    vec2 sb = b.xy / max(b.w, 1e-4) * uRes;
    vec2 d = normalize(sb - sa + vec2(1e-5));
    vec2 n = vec2(-d.y, d.x);
    float w = uWidth * (0.75 + 0.5 * h1(aSeed * 3.1));
    a.xy += n * aSide * w / uRes * a.w;
    gl_Position = a;
  }`;

const frag = /* glsl */ `
  uniform vec3 uLead, uWet, uInk;
  uniform float uProgress, uDash, uFade;
  varying float vDist;
  varying float vSeed;
  varying float vSide;
  float h1(float n){ return fract(sin(n) * 43758.5453); }
  void main(){
    float duty = mix(0.55, 1.01, smoothstep(0.0, 0.9, uProgress));
    float ph = fract(vDist * uDash + h1(vSeed) );
    if (ph > duty) discard;
    // grain: pencil drag skips on paper tooth
    float tooth = h1(floor(vDist * 40.0) + vSeed * 13.0);
    if (tooth < 0.12 * (1.0 - uProgress)) discard;
    // dither-out fade after stamping (no transparency sorting)
    float bayer = fract(dot(floor(gl_FragCoord.xy), vec2(0.5, 0.25)) + 0.125 * mod(floor(gl_FragCoord.y), 2.0));
    if (bayer < uFade) discard;
    vec3 c = mix(uLead, uWet, smoothstep(0.05, 0.6, uProgress));
    c = mix(c, uInk, smoothstep(0.85, 1.0, uProgress));
    gl_FragColor = vec4(c, 1.0);
  }`;

export interface PencilUniforms {
  [k: string]: THREE.IUniform;
  uRes: { value: THREE.Vector2 };
  uWidth: { value: number };
  uBoil: { value: number };
  uProgress: { value: number };
  uDash: { value: number };
  uFade: { value: number };
}

export function createPencilMaterial(res: THREE.Vector2, opts: { lead?: string; width?: number } = {}) {
  const uniforms: PencilUniforms = {
    uRes: { value: res },
    uWidth: { value: opts.width ?? 1.6 },
    uBoil: { value: 0 },
    uProgress: { value: 0 },
    uDash: { value: 2.2 },
    uFade: { value: 0 },
    uLead: { value: new THREE.Color(opts.lead ?? PAL.ghost[2]) },
    uWet: { value: new THREE.Color(PAL.glowCore) },
    uInk: { value: new THREE.Color(PAL.glowEdge) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    side: THREE.DoubleSide,
  });
  return { mat, uniforms };
}

/** Accumulates stroke segments then bakes one ribbon geometry. */
export class StrokeBuilder {
  private readonly segs: number[] = [];
  private readonly rnd: Rng;

  constructor(seed: number) {
    this.rnd = makeRng(seed);
  }

  line(ax: number, ay: number, az: number, bx: number, by: number, bz: number, passes = 2): this {
    const r = this.rnd;
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    for (let p = 0; p < passes; p++) {
      const over = 0.04 + r() * 0.1;
      const w = 0.015 + len * 0.012;
      const o = () => (r() - 0.5) * 2 * w;
      const dx = (bx - ax) / (len || 1);
      const dy = (by - ay) / (len || 1);
      const dz = (bz - az) / (len || 1);
      const e0 = over * (0.3 + r());
      const e1 = over * (0.3 + r());
      this.segs.push(ax - dx * e0 + o(), ay - dy * e0 + o(), az - dz * e0 + o());
      this.segs.push(bx + dx * e1 + o(), by + dy * e1 + o(), bz + dz * e1 + o());
    }
    return this;
  }

  /** Polyline through points (flat xyz array). */
  poly(pts: number[], closed = false, passes = 2): this {
    const n = pts.length / 3;
    for (let i = 0; i < n - (closed ? 0 : 1); i++) {
      const j = (i + 1) % n;
      this.line(
        pts[i * 3]!,
        pts[i * 3 + 1]!,
        pts[i * 3 + 2]!,
        pts[j * 3]!,
        pts[j * 3 + 1]!,
        pts[j * 3 + 2]!,
        passes,
      );
    }
    return this;
  }

  /** Box wireframe (12 edges) — construction-sketch boxes. */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, rotY = 0, passes = 1): this {
    const c = Math.cos(rotY);
    const s = Math.sin(rotY);
    const P = (x: number, y: number, z: number): [number, number, number] => [
      cx + x * c + z * s,
      cy + y,
      cz - x * s + z * c,
    ];
    const hx = sx / 2;
    const hz = sz / 2;
    const v = [
      P(-hx, 0, -hz),
      P(hx, 0, -hz),
      P(hx, 0, hz),
      P(-hx, 0, hz),
      P(-hx, sy, -hz),
      P(hx, sy, -hz),
      P(hx, sy, hz),
      P(-hx, sy, hz),
    ];
    const E = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
    for (let i = 0; i < E.length; i += 2) {
      const a = v[E[i]!]!;
      const b = v[E[i + 1]!]!;
      this.line(a[0], a[1], a[2], b[0], b[1], b[2], passes);
    }
    return this;
  }

  /** Bake into a ribbon geometry: 4 verts / 6 indices per segment. */
  build(): THREE.BufferGeometry {
    const n = this.segs.length / 6;
    const pos = new Float32Array(n * 12);
    const oth = new Float32Array(n * 12);
    const side = new Float32Array(n * 4);
    const dist = new Float32Array(n * 4);
    const seed = new Float32Array(n * 4);
    const idx = new Uint32Array(n * 6);
    let along = 0;
    for (let i = 0; i < n; i++) {
      const a = this.segs.slice(i * 6, i * 6 + 3);
      const b = this.segs.slice(i * 6 + 3, i * 6 + 6);
      const len = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
      const sd = this.rnd() * 100;
      // verts: a(+), a(-), b(+), b(-). For b verts the "other" is a, and side flips to stay consistent.
      const vs: [number[], number[], number, number][] = [
        [a, b, 1, along],
        [a, b, -1, along],
        [b, a, -1, along + len],
        [b, a, 1, along + len],
      ];
      vs.forEach(([p, o, sgn, d], k) => {
        const v = i * 4 + k;
        pos.set(p, v * 3);
        oth.set(o, v * 3);
        side[v] = sgn;
        dist[v] = d;
        seed[v] = sd;
      });
      along += len + 0.37;
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aOther', new THREE.BufferAttribute(oth, 3));
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setAttribute('aDist', new THREE.BufferAttribute(dist, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }

  get segmentCount(): number {
    return this.segs.length / 6;
  }
}
