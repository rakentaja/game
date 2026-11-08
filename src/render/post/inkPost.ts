/**
 * The single hand-written post pass (PLAN §2.2.4): 1 colour RT (+ depth texture) → one fullscreen
 * triangle. Does Sobel ink/pencil edges (outline B), line screen, misregistration, paper grain +
 * fibres, ink vignette — and composes panel-cut frames, the onomatopoeia stamp and the page-curl
 * cast shadow, so the comic layers cost no extra passes.
 */
import * as THREE from 'three';
import { PAL } from '../../data/palette';
import { NOISE_GLSL } from '../noise';

export const MAX_PANELS = 3;

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** One triangle covering the viewport ([-1,-1], [3,-1], [-1,3]). */
export function fullscreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
}

const EDGE_GLSL = /* glsl */ `
uniform sampler2D tColor, tDepth;
uniform float uNear, uFar, uCrease, uCreaseLo;
uniform vec2 uTan;
float linZ(float d) { float z = d * 2.0 - 1.0; return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear)); }
/** x: silhouette/crease strength, y: max ink class in the neighbourhood. */
vec2 inkEdge(vec2 uv, vec2 px) {
  float d0 = texture2D(tDepth, uv).x;
  float z0 = linZ(d0);
  float a0 = texture2D(tColor, uv).a;
  float e = 0.0, cm = a0;
  float dl = texture2D(tDepth, uv - vec2(px.x, 0.0)).x;
  float dr = texture2D(tDepth, uv + vec2(px.x, 0.0)).x;
  float dd = texture2D(tDepth, uv - vec2(0.0, px.y)).x;
  float du = texture2D(tDepth, uv + vec2(0.0, px.y)).x;
  float zl = linZ(dl), zr = linZ(dr), zd = linZ(dd), zu = linZ(du);
  e = max(e, smoothstep(0.035, 0.08, max(max(abs(zl - z0), abs(zr - z0)), max(abs(zd - z0), abs(zu - z0))) / z0));
  // crease: second difference in 1/z (affine in screen space for planes → no false lines on the ground)
  // crease: bend angle between the one-sided view-space tangents (normal-edge stand-in, no G-buffer)
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 P0 = vec3(ndc * uTan * z0, -z0);
  vec3 PL = vec3((ndc - vec2(px.x * 2.0, 0.0)) * uTan * zl, -zl);
  vec3 PR = vec3((ndc + vec2(px.x * 2.0, 0.0)) * uTan * zr, -zr);
  vec3 PD = vec3((ndc - vec2(0.0, px.y * 2.0)) * uTan * zd, -zd);
  vec3 PU = vec3((ndc + vec2(0.0, px.y * 2.0)) * uTan * zu, -zu);
  float bh = 1.0 - dot(normalize(PR - P0), normalize(P0 - PL));
  float bv = 1.0 - dot(normalize(PU - P0), normalize(P0 - PD));
  float crease = smoothstep(uCreaseLo, uCreaseLo * 2.2, max(bh, bv));
  e = max(e, crease * uCrease * (1.0 - smoothstep(uFar * 0.15, uFar * 0.3, z0)));
  #ifdef INK_EDGE_HQ
    float d1 = linZ(texture2D(tDepth, uv + px).x), d2 = linZ(texture2D(tDepth, uv - px).x);
    float d3 = linZ(texture2D(tDepth, uv + vec2(px.x, -px.y)).x), d4 = linZ(texture2D(tDepth, uv + vec2(-px.x, px.y)).x);
    e = max(e, smoothstep(0.045, 0.1, max(max(abs(d1 - z0), abs(d2 - z0)), max(abs(d3 - z0), abs(d4 - z0))) / z0));
  #endif
  cm = max(cm, max(max(texture2D(tColor, uv + vec2(px.x, 0.0)).a, texture2D(tColor, uv - vec2(px.x, 0.0)).a),
                   max(texture2D(tColor, uv + vec2(0.0, px.y)).a, texture2D(tColor, uv - vec2(0.0, px.y)).a)));
  return vec2(e, cm);
}
`;

/** Half-res edge prepass (Low quality / mobile). Writes inkEdge() into RG. */
export function createEdgeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'InkEdgeHalf',
    uniforms: {
      tColor: { value: null },
      tDepth: { value: null },
      uNear: { value: 0.1 },
      uFar: { value: 80 },
      uCrease: { value: 1 },
      uCreaseLo: { value: 0.09 },
      uTan: { value: new THREE.Vector2(1, 1) },
      uPx: { value: new THREE.Vector2(1, 1) },
      uEdgeScale: { value: 1 },
    },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: /* glsl */ `
      ${EDGE_GLSL}
      uniform vec2 uPx;
      varying vec2 vUv;
      void main() { gl_FragColor = vec4(inkEdge(vUv, uPx), 0.0, 1.0); }
    `,
    depthTest: false,
    depthWrite: false,
  });
}

const POST_FRAG = /* glsl */ `
${EDGE_GLSL}
${NOISE_GLSL}
uniform sampler2D tEdge, tStamp;
uniform vec2 uRes;
uniform float uDpr, uTime, uBoilSeed;
uniform float uPeriod, uAngle, uScreenAmt, uEdgeW, uGrain, uMisreg, uVignette;
uniform float uUseEdges, uUseScreen, uUsePaper;
uniform vec3 uInk, uPaper, uPencilDark, uGlowCore, uRed1, uRed2;
// panels
uniform int uPanelCount;
uniform vec4 uPanelA[${MAX_PANELS}], uPanelB[${MAX_PANELS}]; // quad corners (bl, br) (tr, tl) in uv
uniform vec4 uPanelRect[${MAX_PANELS}];
uniform float uPanelShow[${MAX_PANELS}];
uniform vec2 uFocusUv;
uniform float uSpeedLines;
// stamp: centre uv, half size (uv, aspect-corrected), rotation; alpha
uniform vec4 uStamp;
uniform float uStampRot, uStampOn;
// page curl cast shadow (page space: x * aspect)
uniform vec2 uCurlP0, uCurlN;
uniform float uCurlR, uCurlOn;
varying vec2 vUv;

float cross2(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }
/** Signed pixel distance inside a convex quad (positive inside). */
float quadDist(vec2 p, vec2 a, vec2 b, vec2 c, vec2 d) {
  vec2 s = uRes;
  vec2 P = p * s, A = a * s, B = b * s, C = c * s, D = d * s;
  float e0 = cross2(B - A, P - A) / length(B - A);
  float e1 = cross2(C - B, P - B) / length(C - B);
  float e2 = cross2(D - C, P - C) / length(D - C);
  float e3 = cross2(A - D, P - D) / length(A - D);
  return min(min(e0, e1), min(e2, e3));
}

vec3 paperTex(vec2 frag, vec3 base) {
  float fib = 0.0;
  vec2 f = frag / uDpr;
  fib += smoothstep(0.86, 0.98, inkNoiseB(mat2(0.94, 0.34, -0.34, 0.94) * f * vec2(0.012, 0.55)));
  fib += smoothstep(0.88, 0.99, inkNoiseA(mat2(0.5, -0.87, 0.87, 0.5) * f * vec2(0.015, 0.5) + 7.0));
  float blot = inkFbmG(f * 0.0045) - 0.5;
  return base * (1.0 - fib * 0.05 + blot * 0.06);
}

void main() {
  vec2 frag = vUv * uRes;
  vec2 uv = vUv;
  float boilT = uBoilSeed;
  vec2 jit = (vec2(inkNoiseG(frag / (28.0 * uDpr) + boilT * 7.1), inkNoiseG(frag / (28.0 * uDpr) - boilT * 3.7)) - 0.5)
             * 1.6 * uDpr / uRes;

  // ── panel cut layout ──
  int panel = -1;
  float pd = 1e5;
  if (uPanelCount > 0) {
    for (int i = 0; i < ${MAX_PANELS}; i++) {
      if (i >= uPanelCount) break;
      float di = quadDist(uv, uPanelA[i].xy, uPanelA[i].zw, uPanelB[i].xy, uPanelB[i].zw);
      if (di > 0.0 && uPanelShow[i] > 0.0) { panel = i; pd = di; }
    }
    if (panel < 0) {
      // gutter
      vec3 g = paperTex(frag, uPaper);
      float gr = inkHash(floor(frag / (1.5 * uDpr)) + floor(uTime * 12.0)) - 0.5;
      gl_FragColor = vec4(g + gr * 0.035 * uGrain, 1.0);
      return;
    }
  }

  vec2 off = vec2(uMisreg * uDpr, -uMisreg * 0.6 * uDpr) / uRes;
  vec4 base = texture2D(tColor, uv + jit * 0.6);
  vec3 col = base.rgb;
  if (uMisreg > 0.0) {
    col.r = texture2D(tColor, uv + jit * 0.6 + off).r;
    col.b = texture2D(tColor, uv + jit * 0.6 - off * 0.7).b;
  }
  float cls = base.a;

  // ── outline B: depth Sobel. ink where inked, broken doubled graphite where paper ──
  if (uUseEdges > 0.5) {
    float w = uEdgeW * (0.75 + 0.6 * inkNoiseG(frag / (60.0 * uDpr) + boilT));
    vec2 px = w * uDpr / uRes;
    #ifdef INK_EDGE_TEX
      vec2 ed = texture2D(tEdge, uv + jit).rg;
    #else
      vec2 ed = inkEdge(uv + jit, px);
    #endif
    float e = ed.x;
    if (ed.y > 0.25) {
      col = mix(col, uInk, e);
    } else {
      #ifdef INK_EDGE_TEX
        vec2 ed2 = texture2D(tEdge, uv - jit * 2.5).rg;
      #else
        vec2 ed2 = inkEdge(uv - jit * 2.5, px);
      #endif
      float brk = step(0.4, inkNoiseB(frag / (14.0 * uDpr) + boilT * 1.3));
      float pe = max(e * brk, ed2.x * 0.6 * step(0.55, inkNoiseB(frag / (9.0 * uDpr) - boilT)));
      col = mix(col, uPencilDark, step(0.45, pe) * 0.85);
    }
  }

  // ── line screen on inked tones ──
  if (uUseScreen > 0.5 && cls > 0.75) {
    float lum = dot(col, vec3(0.3, 0.59, 0.11));
    float a = radians(uAngle);
    vec2 dir = vec2(cos(a), sin(a));
    float wob = (inkNoiseG(frag / (90.0 * uDpr)) - 0.5) * 1.2 + (inkNoiseB(frag / (9.0 * uDpr)) - 0.5) * 0.25;
    float c1 = dot(frag / uDpr, dir) / uPeriod + wob;
    float f1 = abs(fract(c1) - 0.5) * 2.0;
    float thick = mix(0.22, 0.75, 1.0 - smoothstep(0.03, 0.55, lum));
    float line1 = 1.0 - smoothstep(thick - 0.18, thick + 0.18, f1);
    vec2 dir2 = vec2(-dir.y, dir.x);
    float f2 = abs(fract(dot(frag / uDpr, dir2) / (uPeriod * 1.9) + wob * 0.5) - 0.5) * 2.0;
    float line2 = 1.0 - smoothstep(0.15, 0.35, f2);
    vec3 dark = col * 0.58;
    vec3 lite = min(col * 1.18 + 0.02, 1.0);
    col = mix(col, lite, (1.0 - line1) * 0.35 * uScreenAmt);
    col = mix(col, dark, line1 * uScreenAmt);
    col = mix(col, dark, line2 * 0.25 * uScreenAmt);
  }

  // ── speed lines in the focus panel ──
  if (panel == 1 && uSpeedLines > 0.0) {
    vec2 d = (uv - uFocusUv) * uRes / uRes.y;
    float ang = atan(d.y, d.x);
    float rays = step(0.74, inkNoiseB(vec2(ang * 38.0, boilT * 3.0)));
    float r = length(d);
    float fall = smoothstep(0.16, 0.42, r) * step(inkNoiseA(vec2(ang * 61.0, 3.0)) * 0.25 + 0.2, r);
    col = mix(col, uInk, rays * fall * uSpeedLines);
  }

  // ── paper: warm multiply, lifted blacks, grain, fibres, blotches ──
  if (uUsePaper > 0.5) {
    float g = inkHash(floor(frag / (1.5 * uDpr)) + floor(uTime * 12.0)) - 0.5;
    col = mix(col, col * uPaper * 1.06, 0.6);
    col = max(col, vec3(0.075, 0.055, 0.05));
    col = paperTex(frag, col);
    col += g * 0.07 * uGrain;
  }

  // ── page curl: shadow cast onto the new page just past the roll ──
  if (uCurlOn > 0.5) {
    vec2 pp = vec2(uv.x * uRes.x / uRes.y, uv.y);
    float s = dot(pp - uCurlP0, uCurlN);
    float sh = 1.0 - smoothstep(uCurlR, uCurlR * 2.6, s);
    sh *= step(0.0, s);
    float band = step(0.35, sh) * 0.22 + step(0.75, sh) * 0.2;
    col *= 1.0 - band;
  }

  // ── panel frames (ink, boiling width) ──
  if (panel >= 0) {
    float fw = (3.2 + inkNoiseG(frag / (40.0 * uDpr) + boilT) * 1.6) * uDpr;
    col = mix(col, uInk, 1.0 - step(fw, pd));
  }

  // ── vignette: soft darkening + ragged ink plate edge ──
  vec2 q = vUv - 0.5;
  float vg = dot(q, q);
  col *= 1.0 - vg * 0.9 * uVignette;
  // printing-plate edge: a hair of ragged ink hugging the frame
  vec2 ed = min(frag, uRes - frag) / uDpr;
  float rag = (inkFbmG(frag / (14.0 * uDpr)) - 0.5) * 7.0;
  col = mix(col, uInk, step(min(ed.x, ed.y), 2.5 + rag) * uVignette * step(float(uPanelCount), 0.0));

  // ── onomatopoeia stamp (R ink, G letter fill, B burst, A drop shadow) ──
  if (uStampOn > 0.0) {
    vec2 ap = vec2((uv.x - uStamp.x) * uRes.x / uRes.y, uv.y - uStamp.y);
    float cs = cos(uStampRot), sn = sin(uStampRot);
    ap = mat2(cs, -sn, sn, cs) * ap;
    vec2 su = ap / uStamp.zw * 0.5 + 0.5;
    if (su.x > 0.0 && su.x < 1.0 && su.y > 0.0 && su.y < 1.0) {
      vec4 st = texture2D(tStamp, su);
      if (st.b > 0.5) {
        // halftone dots inside the burst
        vec2 hc = fract(frag / (5.0 * uDpr)) - 0.5;
        col = mix(uRed2, uGlowCore, step(length(hc), 0.18));
      }
      if (st.a > 0.5) col = uRed1;
      if (st.g > 0.5) col = uGlowCore;
      if (st.r > 0.5) col = uInk;
    }
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createPostMaterial(halfResEdges: boolean, hq: boolean): THREE.ShaderMaterial {
  const defines: Record<string, string> = {};
  if (halfResEdges) defines.INK_EDGE_TEX = '';
  if (hq) defines.INK_EDGE_HQ = '';
  const v4 = () => Array.from({ length: MAX_PANELS }, () => new THREE.Vector4());
  return new THREE.ShaderMaterial({
    name: 'InkPost',
    defines,
    uniforms: {
      tColor: { value: null },
      tDepth: { value: null },
      tEdge: { value: null },
      tStamp: { value: null },
      uNoise: { value: null },
      uNear: { value: 0.1 },
      uFar: { value: 80 },
      uCrease: { value: 1 },
      uCreaseLo: { value: 0.09 },
      uTan: { value: new THREE.Vector2(1, 1) },
      uRes: { value: new THREE.Vector2(1, 1) },
      uDpr: { value: 1 },
      uTime: { value: 0 },
      uBoilSeed: { value: 0 },
      uPeriod: { value: 3.4 },
      uAngle: { value: 62 },
      uScreenAmt: { value: 0.55 },
      uEdgeW: { value: 1.4 },
      uGrain: { value: 0.5 },
      uMisreg: { value: 0.6 },
      uVignette: { value: 0.9 },
      uUseEdges: { value: 1 },
      uUseScreen: { value: 1 },
      uUsePaper: { value: 1 },
      uInk: { value: new THREE.Color(PAL.ink) },
      uPaper: { value: new THREE.Color(PAL.paper) },
      uPencilDark: { value: new THREE.Color(PAL.staff[3]) },
      uGlowCore: { value: new THREE.Color(PAL.glowCore) },
      uRed1: { value: new THREE.Color(PAL.red[1]) },
      uRed2: { value: new THREE.Color(PAL.red[2]) },
      uPanelCount: { value: 0 },
      uPanelA: { value: v4() },
      uPanelB: { value: v4() },
      uPanelRect: { value: v4() },
      uPanelShow: { value: new Array(MAX_PANELS).fill(0) },
      uFocusUv: { value: new THREE.Vector2(0.5, 0.5) },
      uSpeedLines: { value: 0 },
      uStamp: { value: new THREE.Vector4(0.5, 0.5, 0.3, 0.15) },
      uStampRot: { value: 0 },
      uStampOn: { value: 0 },
      uCurlP0: { value: new THREE.Vector2() },
      uCurlN: { value: new THREE.Vector2(1, 0) },
      uCurlR: { value: 0.1 },
      uCurlOn: { value: 0 },
    },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: POST_FRAG,
    depthTest: false,
    depthWrite: false,
  });
}
