/**
 * Editor-only shaders. The look follows reference/poc (posterised 4-step ramps, wrapped-lambert
 * key, crystal point light, wobbly band edges), plus the boss's own story:
 *   - above `uSplitY` the Editor is finished ink; below it a pencil sketch (paper + world-space
 *     graphite hatching + dashed contour), with wet-ink drips running down over the seam
 *   - per-part erase (`uPart[i]`) eats ragged holes back to pencil (arms after weak points die)
 *   - `uBlank` (Blank Page) turns everything to pencil except inside the crystal light
 *   - `uReversed` (Blank Page, Reversed): the body fades to bare paper except where the player's
 *     ink trail (`uPaint`, see paint.ts) has been
 *   - `uInkOver` floods it with ink from the top (death), `uTear` rips it into paper shreds
 * Palette is used verbatim (ColorManagement disabled by the app).
 */
import * as THREE from 'three';
import { PAL } from '../../data/palette';
import { PAINT_SLOTS } from './paint';

const c = (h: string) => new THREE.Color(h);

/** Ramp table: 0 red (coat), 1 staff (metal/trousers), 2 ghost (paper skin), 3 teal (eyeshade),
 * 4 pencil-yellow, 5 glow (lenses / ferrule shine). */
export const RAMP = { red: 0, staff: 1, ghost: 2, teal: 3, pencil: 4, glow: 5 } as const;

function rampTable(): THREE.Color[] {
  const out: THREE.Color[] = [];
  const push = (r: readonly string[]) => {
    for (const h of r) out.push(c(h));
  };
  push(PAL.red);
  push(PAL.staff);
  push(PAL.ghost);
  push(PAL.teal);
  push([PAL.ink, PAL.glowEdge, PAL.glowCore, PAL.paper]);
  push([PAL.glowEdge, PAL.glowEdge, PAL.glowCore, PAL.paper]);
  return out;
}

/** Body part ids written into the `aPart` attribute; `uPart[id]` = erased amount 0..1. */
export const PART = {
  torso: 0,
  head: 1,
  upperArmR: 2,
  forearmR: 3,
  handR: 4,
  upperArmL: 5,
  forearmL: 6,
  handL: 7,
  coat: 8,
  legs: 9,
  pencil: 10,
  eraser: 11,
  face: 12,
  hipL: 13,
  hipR: 14,
  tail: 15,
} as const;
export const PART_COUNT = 16;

export const NOISE_GLSL = /* glsl */ `
  float ehash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  float enoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
    return mix(mix(ehash(i),ehash(i+vec2(1,0)),f.x), mix(ehash(i+vec2(0,1)),ehash(i+vec2(1,1)),f.x), f.y); }
  float efbm(vec2 p){ float a=.5,s=0.; for(int i=0;i<4;i++){ s+=a*enoise(p); p*=2.03; a*=.5;} return s; }
`;

/** Vertex-animated cloth (coat tails) shared by body + outline shaders. */
const CLOTH_GLSL = /* glsl */ `
  attribute float aCloth;
  uniform vec3 uWind;
  uniform float uTime;
  vec3 clothOffset(vec3 p, float w){
    if (w <= 0.0) return vec3(0.0);
    float ang = atan(p.z, p.x);
    float t = uTime;
    float wav = sin(t*2.1 + p.y*1.7 + ang*2.0)*0.55 + sin(t*3.7 - p.y*2.3 + ang*3.0)*0.3 + sin(t*1.3 + ang)*0.4;
    vec3 o = vec3(cos(ang), 0.0, sin(ang)) * wav * 0.12;
    o += uWind * (0.6 + 0.4*sin(t*2.7 + p.y)) ;
    o.y += abs(wav) * 0.05;
    return o * w;
  }
`;

const BODY_VERT = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>
  attribute float aRamp;
  attribute float aPart;
  ${CLOTH_GLSL}
  varying vec3 vWN; varying vec3 vWPos; varying vec3 vOPos; varying float vViewZ;
  varying float vRamp; varying float vPart; varying vec3 vVDir;
  void main(){
    vRamp = aRamp; vPart = aPart; vOPos = position;
    #include <beginnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    transformed += clothOffset(position, aCloth);
    #include <skinning_vertex>
    #include <project_vertex>
    vWN = normalize(mat3(modelMatrix) * objectNormal);
    vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
    vViewZ = -mvPosition.z;
    vVDir = normalize(cameraPosition - vWPos);
  }
`;

/** Shared fragment logic: decides ink vs pencil for a world point. */
const SPLIT_GLSL = /* glsl */ `
  uniform float uSplitY, uPrintAll, uInkOver, uInkTop, uBlank, uRevealR, uTear, uTime, uBoil;
  uniform float uPart[${PART_COUNT}];
  uniform vec3 uCrystalPos;
  uniform float uReversed;
  uniform vec4 uPaint[${PAINT_SLOTS}];
  // Blank Page, Reversed: 1 = bare paper (body invisible here), written by pencilMask
  float gVanish = 0.0;
  float paintAt(vec2 p){
    float n = (efbm(p*1.7 + 3.1) - 0.5) * 0.6;
    float a = 0.0;
    for (int i = 0; i < ${PAINT_SLOTS}; i++) {
      vec4 s = uPaint[i];
      if (s.z <= 0.0) continue;
      float d = length(p - s.xy) + n;
      a = max(a, smoothstep(s.z, s.z - 0.8, d) * s.w);
    }
    return a;
  }
  // 1 = pencil sketch, 0 = finished ink
  float pencilMask(vec3 wp, vec3 op, float part, out float seam){
    float drip = pow(enoise(vec2((wp.x*1.3 + wp.z*0.9)*2.2, 0.5)), 3.0) * 1.1;
    drip *= smoothstep(0.0, 1.0, 0.6 + 0.4*sin(uTime*0.35 + wp.x));
    float edge = uSplitY - drip + (efbm(wp.xz*2.0 + wp.y)-0.5)*0.35;
    // only the lower body (torso hem, coat, legs, hips) follows the print line; arms, head and
    // the pencil prop are finished ink wherever they swing (erase / Blank Page still apply)
    float prop = (1.0 - max(max(step(part, 0.5), step(7.5, part) * step(part, 9.5)), step(12.5, part))) * (1.0 - uPrintAll);
    float m = smoothstep(edge + 0.05, edge - 0.05, wp.y) * (1.0 - prop);
    seam = (1.0 - smoothstep(0.0, 0.11, abs(wp.y - edge))) * (1.0 - prop);
    // per-part erase: ragged blotches grow with the erased amount
    int pi = int(part + 0.5);
    float er = 0.0;
    for (int i = 0; i < ${PART_COUNT}; i++) if (i == pi) er = uPart[i];
    if (er > 0.0) {
      float n = efbm(op.xy*3.1 + op.z*2.3 + 7.0);
      float e = smoothstep(n - 0.04, n + 0.04, er * 1.15);
      seam = max(seam, (1.0 - smoothstep(0.0, 0.06, abs(er*1.15 - n))) * step(0.01, er) * (1.0 - step(0.999, er)));
      m = max(m, e);
    }
    // Blank Page: only the crystal light keeps ink
    if (uBlank > 0.0) {
      float d = length(wp - uCrystalPos);
      float lit = smoothstep(uRevealR + 0.6, uRevealR - 0.9, d + (efbm(wp.xz*3.0)-0.5)*1.2);
      if (uReversed > 0.0) {
        lit = max(lit, paintAt(wp.xz));
        gVanish = uReversed * (1.0 - lit);
      }
      m = max(m, uBlank * (1.0 - lit));
    }
    return m;
  }
  float inkFlood(vec3 wp){
    if (uInkOver <= 0.0) return 0.0;
    float drip = pow(enoise(vec2(wp.x*2.7 + wp.z*1.9, 3.0)), 2.0) * 1.8;
    float line = uInkTop - uInkOver * (uInkTop + 2.5) - drip;
    return smoothstep(line - 0.08, line + 0.08, wp.y);
  }
`;

const BODY_FRAG = /* glsl */ `
  uniform vec3 uRamp[24];
  uniform vec3 uKeyDir; uniform float uShadow, uFogNear, uFogFar, uHurt, uKeyAmt, uGlowAmt;
  uniform vec3 uInk, uPaper, uGraphite, uGlowEdge, uGlowCore;
  varying vec3 vWN; varying vec3 vWPos; varying vec3 vOPos; varying float vViewZ;
  varying float vRamp; varying float vPart; varying vec3 vVDir;
  ${NOISE_GLSL}
  ${SPLIT_GLSL}
  vec3 rampAt(int r, int k){
    int idx = r*4 + k; vec3 c = uRamp[0];
    for (int i = 0; i < 24; i++) if (i == idx) c = uRamp[i];
    return c;
  }
  void main(){
    vec3 N = normalize(vWN) * (gl_FrontFacing ? 1.0 : -1.0);
    vec3 V = normalize(vVDir);
    float key = clamp(dot(N, normalize(uKeyDir))*0.6 + 0.4, 0.0, 1.0) * uKeyAmt;
    vec3 L = uCrystalPos - vWPos; float d2 = dot(L, L);
    float pl = max(dot(N, normalize(L)), 0.0) * uGlowAmt / (1.0 + d2*0.25);
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.35;
    float tone = 0.75 * (0.18 + key + pl) + rim;
    tone *= 1.0 - smoothstep(uFogNear, uFogFar, vViewZ);
    tone += (efbm(vWPos.xy*5.0 + vWPos.z*3.0 + uBoil) - 0.5) * 0.07;
    int r = int(vRamp + 0.5);
    vec3 inked = rampAt(r, 0);
    if (tone > uShadow)        inked = rampAt(r, 1);
    if (tone > uShadow + 0.20) inked = rampAt(r, 2);
    if (tone > uShadow + 0.48) inked = rampAt(r, 3);

    // ── pencil sketch: paper + graphite hatching by tone + dashed silhouette ──
    float lum = clamp(tone, 0.0, 1.0);
    float wob = (enoise(vWPos.xy*1.7 + uBoil) - 0.5) * 0.35;
    float h1 = abs(fract(dot(vWPos, vec3(0.55, 1.0, 0.35))*5.5 + wob) - 0.5) * 2.0;
    float h2 = abs(fract(dot(vWPos, vec3(-0.7, 0.8, 0.45))*6.5 - wob) - 0.5) * 2.0;
    float dark = 1.0 - smoothstep(0.15, 0.75, lum);
    float hatch = (1.0 - smoothstep(0.12, 0.3, h1)) * step(0.25, dark);
    hatch = max(hatch, (1.0 - smoothstep(0.1, 0.25, h2)) * step(0.6, dark));
    hatch *= 0.55 + 0.45*enoise(vWPos.xy*9.0);            // broken, uneven graphite
    float fres = 1.0 - abs(dot(N, V));
    float contour = smoothstep(0.62, 0.8, fres);
    float dash = step(0.38, fract((vWPos.y*2.2 + vWPos.x*0.7 + vWPos.z*0.5)*1.6 + uBoil*0.13));
    contour *= mix(1.0, dash, 0.85);
    vec3 pencil = uPaper;
    pencil = mix(pencil, uGraphite, hatch * 0.7);
    pencil = mix(pencil, uGraphite, contour * 0.9);
    pencil = mix(pencil, uRamp[9], smoothstep(0.55, 0.75, efbm(vWPos.xz*0.9 + vWPos.y))*0.12); // smudge

    float seam;
    float pm = pencilMask(vWPos, vOPos, vPart, seam);
    vec3 col = mix(inked, pencil, pm);
    // wet-ink seam where the print stops
    col = mix(col, uInk, seam * 0.9);
    col = mix(col, uGlowEdge, seam * smoothstep(0.7, 1.0, seam) * 0.35 * step(0.5, enoise(vWPos.xz*30.0)));

    // death: ink flood (glossy) + paper tears
    float fl = inkFlood(vWPos);
    if (fl > 0.0) {
      float gloss = step(0.86, max(dot(N, normalize(uKeyDir + V)), 0.0));
      vec3 wet = mix(uInk, uRamp[1], gloss * 0.8);
      col = mix(col, wet, fl);
    }
    if (uTear > 0.0) {
      float tl = abs(efbm(vOPos.xy*1.4 + vOPos.z*1.1 + 3.0) - 0.5);
      float w = uTear * 0.16;
      if (tl < w * 0.55) discard;
      col = mix(col, uPaper, 1.0 - smoothstep(w*0.55, w, tl));
    }
    // Blank Page, Reversed: unpainted body is bare paper (a whisper of graphite contour stays)
    col = mix(col, uPaper, gVanish * (1.0 - contour * 0.12));
    // hit flash: paper pop with hot rim
    col = mix(col, uPaper, uHurt * 0.75);
    col = mix(col, uGlowEdge, uHurt * smoothstep(0.4, 0.8, fres));
    gl_FragColor = vec4(col, 1.0);
  }
`;

const OUTLINE_VERT = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>
  attribute float aPart;
  ${CLOTH_GLSL}
  uniform float uWidth; uniform vec2 uRes; uniform float uBoil;
  varying vec3 vWPos; varying vec3 vOPos; varying float vPart;
  ${NOISE_GLSL}
  void main(){
    vPart = aPart; vOPos = position;
    #include <beginnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    transformed += clothOffset(position, aCloth);
    #include <skinning_vertex>
    #include <project_vertex>
    vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
    vec3 nv = normalize(normalMatrix * objectNormal);
    float boil = 0.7 + 0.6*enoise(vWPos.xy*2.3 + vWPos.z + uBoil*7.1);
    vec2 dir = normalize(nv.xy + 1e-5);
    gl_Position.xy += dir * uWidth * boil * gl_Position.w * 2.0 / uRes;
  }
`;

const OUTLINE_FRAG = /* glsl */ `
  uniform vec3 uInk, uGraphite, uPaper;
  uniform float uHurt;
  varying vec3 vWPos; varying vec3 vOPos; varying float vPart;
  ${NOISE_GLSL}
  ${SPLIT_GLSL}
  void main(){
    float seam;
    float pm = pencilMask(vWPos, vOPos, vPart, seam);
    float fl = inkFlood(vWPos);
    pm *= 1.0 - fl;
    if (uTear > 0.0) {
      float tl = abs(efbm(vOPos.xy*1.4 + vOPos.z*1.1 + 3.0) - 0.5);
      if (tl < uTear * 0.09) discard;
    }
    // pencil part of the hull: dashed, sketchy graphite
    float dash = fract((vWPos.y*1.7 + vWPos.x*0.6 - vWPos.z*0.4)*1.9 + uBoil*0.21);
    if (pm > 0.5 && dash > 0.62) discard;
    if (gVanish > 0.85) discard;
    vec3 col = mix(uInk, uGraphite, pm);
    col = mix(col, uPaper, gVanish);
    col = mix(col, uPaper, uHurt * 0.3);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export interface EditorUniforms {
  [k: string]: THREE.IUniform;
  uTime: THREE.IUniform<number>;
  uKeyDir: THREE.IUniform<THREE.Vector3>;
  uCrystalPos: THREE.IUniform<THREE.Vector3>;
  uShadow: THREE.IUniform<number>;
  uInk: THREE.IUniform<THREE.Color>;
  uPaper: THREE.IUniform<THREE.Color>;
  uGraphite: THREE.IUniform<THREE.Color>;
  uGlowEdge: THREE.IUniform<THREE.Color>;
  uGlowCore: THREE.IUniform<THREE.Color>;
  uSplitY: THREE.IUniform<number>;
  uPrintAll: THREE.IUniform<number>;
  uInkOver: THREE.IUniform<number>;
  uInkTop: THREE.IUniform<number>;
  uBlank: THREE.IUniform<number>;
  uRevealR: THREE.IUniform<number>;
  uReversed: THREE.IUniform<number>;
  uPaint: THREE.IUniform<THREE.Vector4[]>;
  uTear: THREE.IUniform<number>;
  uHurt: THREE.IUniform<number>;
  uPart: THREE.IUniform<number[]>;
  uWind: THREE.IUniform<THREE.Vector3>;
  uBoil: THREE.IUniform<number>;
  uRes: THREE.IUniform<THREE.Vector2>;
  uWidth: THREE.IUniform<number>;
}

/**
 * One uniform set shared by every Editor material (body, outline), so a single write per frame
 * drives the whole figure. `shared` = the renderer's shared uniforms (uTime, uKeyDir, uCrystalPos,
 * uShadow); missing ones are created locally so the Editor also works standalone.
 */
export function createEditorUniforms(shared: Record<string, THREE.IUniform>): EditorUniforms {
  const pick = <T>(k: string, v: T): THREE.IUniform<T> => (shared[k] as THREE.IUniform<T>) ?? { value: v };
  return {
    uTime: pick('uTime', 0),
    uKeyDir: pick('uKeyDir', new THREE.Vector3(-0.5, 0.75, 0.45).normalize()),
    uCrystalPos: pick('uCrystalPos', new THREE.Vector3(0, 2, 0)),
    uShadow: pick('uShadow', 0.3),
    uBoil: { value: 0 },
    uRamp: { value: rampTable() },
    uFogNear: { value: 30 },
    uFogFar: { value: 70 },
    uKeyAmt: { value: 0.85 },
    uGlowAmt: { value: 1.4 },
    uInk: { value: c(PAL.ink) },
    uPaper: { value: c(PAL.paper) },
    uGraphite: { value: c(PAL.staff[2]) },
    uGlowEdge: { value: c(PAL.glowEdge) },
    uGlowCore: { value: c(PAL.glowCore) },
    uSplitY: { value: 3.2 },
    uPrintAll: { value: 0 },
    uInkOver: { value: 0 },
    uInkTop: { value: 8 },
    uBlank: { value: 0 },
    uRevealR: { value: 3 },
    uReversed: { value: 0 },
    uPaint: { value: Array.from({ length: PAINT_SLOTS }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uTear: { value: 0 },
    uHurt: { value: 0 },
    uPart: { value: new Array(PART_COUNT).fill(0) },
    uWind: { value: new THREE.Vector3() },
    uRes: { value: new THREE.Vector2(1, 1) },
    uWidth: { value: 2.2 },
  };
}

export function createEditorBodyMaterial(u: EditorUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: BODY_VERT,
    fragmentShader: BODY_FRAG,
    side: THREE.FrontSide,
  });
}

export function createEditorOutlineMaterial(u: EditorUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: OUTLINE_VERT,
    fragmentShader: OUTLINE_FRAG,
    side: THREE.BackSide,
  });
}

// ───────────────────────────── Weak points ─────────────────────────────

const WP_VERT = /* glsl */ `
  uniform float uTime, uWobble, uSeed;
  varying vec3 vN; varying vec3 vWPos; varying vec3 vOPos; varying vec3 vV;
  ${NOISE_GLSL}
  void main(){
    vec3 p = position;
    float n = enoise(normal.xy*2.0 + normal.z + uTime*1.7 + uSeed) - 0.5;
    p += normal * n * uWobble;
    vOPos = position;
    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWPos = wp.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const WP_FRAG = /* glsl */ `
  uniform vec3 uInk, uPaper, uGraphite, uGlowEdge, uGlowCore, uKeyDir;
  uniform float uSketch, uPrint, uExposed, uFlash, uTime, uDraw, uLit;
  varying vec3 vN; varying vec3 vWPos; varying vec3 vOPos; varying vec3 vV;
  ${NOISE_GLSL}
  void main(){
    vec3 N = normalize(vN); vec3 V = normalize(vV);
    float f = 1.0 - max(dot(N, V), 0.0);
    // draw-in: the sketch appears stroke by stroke around the sphere
    float ang = atan(vOPos.z, vOPos.x) / 6.2831853 + 0.5;
    if (ang > uDraw + (vOPos.y*0.15)) discard;
    // printed amount fills from the bottom with a wobbly ink line
    float fillLine = mix(-1.2, 1.2, uPrint) + (enoise(vOPos.xz*4.0 + uTime) - 0.5)*0.25;
    float inked = max(1.0 - uSketch, step(vOPos.y, fillLine));
    // sketch: dashed graphite rings on paper (with a hollow, x-ray look)
    float ring = abs(fract(vOPos.y*3.5 + 0.5) - 0.5)*2.0;
    float dash = step(0.45, fract(ang*14.0 + uTime*0.4));
    float sk = (1.0 - smoothstep(0.08, 0.22, ring)) * dash;
    sk = max(sk, smoothstep(0.55, 0.75, f));
    // ready-to-print sketch: a hot dashed halo calls for the crystal
    float halo = smoothstep(0.7, 0.9, f) * step(0.5, fract(ang*10.0 - uTime*1.2)) * uSketch * step(0.99, uDraw) * (0.6 + 0.4*sin(uTime*6.0));
    if (inked < 0.5 && sk < 0.3 && halo < 0.3) discard;
    vec3 sketch = mix(uPaper, uGraphite, sk);
    sketch = mix(sketch, uGlowEdge, halo);
    // ink blob: glossy black with hot wet rim, pulsing glow when exposed
    float spec = step(0.994, max(dot(N, normalize(normalize(uKeyDir) + V)), 0.0));
    float pulse = 0.5 + 0.5*sin(uTime*9.0);
    vec3 blob = uInk;
    blob = mix(blob, uGlowEdge, smoothstep(0.55, 0.85, f) * (0.35 + 0.65*uExposed*pulse));
    blob = mix(blob, uGlowCore, smoothstep(0.82, 0.95, f) * uExposed);
    blob = mix(blob, uPaper, spec * 0.9);
    // phase-3 core: unlit (outside crystal light) it is only a faint pencil ghost
    blob = mix(mix(uPaper, uGraphite, smoothstep(0.5, 0.8, f)), blob, uLit);
    vec3 col = mix(sketch, blob, inked);
    col = mix(col, uPaper, uFlash);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createWeakPointMaterial(shared: EditorUniforms, seed: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: shared.uTime,
      uKeyDir: shared.uKeyDir,
      uInk: shared.uInk,
      uPaper: shared.uPaper,
      uGraphite: shared.uGraphite,
      uGlowEdge: shared.uGlowEdge,
      uGlowCore: shared.uGlowCore,
      uSeed: { value: seed },
      uWobble: { value: 0.18 },
      uSketch: { value: 0 },
      uPrint: { value: 0 },
      uExposed: { value: 0 },
      uFlash: { value: 0 },
      uDraw: { value: 1 },
      uLit: { value: 1 },
    },
    vertexShader: WP_VERT,
    fragmentShader: WP_FRAG,
    side: THREE.DoubleSide,
  });
}

// ───────────────────────────── Telegraph decals ─────────────────────────────

const TELE_VERT = /* glsl */ `
  varying vec2 vUv; varying vec3 vWPos;
  void main(){ vUv = uv; vec4 wp = modelMatrix * vec4(position, 1.0); vWPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp; }
`;
const TELE_FRAG = /* glsl */ `
  uniform vec3 uInk, uGraphite, uGlowEdge, uGlowCore, uPaper;
  uniform float uKind, uProg, uStrike, uFade, uTime, uBoil, uLen, uWidthM;
  varying vec2 vUv; varying vec3 vWPos;
  ${NOISE_GLSL}
  void main(){
    float a = 0.0; vec3 col = uGraphite;
    if (uKind < 0.5) {
      // lane: inked dashed border, hatch fill sweeping from the slam end, hot chevrons, eraser wake
      vec2 m = vec2(vUv.x * uWidthM, vUv.y * uLen);           // metres
      float wob = (enoise(vec2(m.y*0.8, uBoil)) - 0.5) * 0.12;
      float side = min(vUv.x, 1.0 - vUv.x) * uWidthM + wob;
      float border = 1.0 - smoothstep(0.08, 0.14, abs(side - 0.1));
      float dash = step(0.35, fract(m.y*0.8 - uTime*2.0));
      float hatch = 1.0 - smoothstep(0.12, 0.26, abs(fract((m.x + m.y)*3.2 + wob) - 0.5)*2.0);
      float filled = step(vUv.y, uProg);
      float fill = filled * hatch;
      // chevrons pointing along the push direction
      float cx = abs(vUv.x - 0.5) * uWidthM;
      float chev = fract((m.y - cx*0.9)*0.55 - uTime*1.4);
      float chevron = (1.0 - smoothstep(0.0, 0.08, abs(chev - 0.5))) * step(cx, uWidthM*0.38);
      float head = 1.0 - smoothstep(0.0, 0.6/uLen, abs(vUv.y - uProg));
      float pre = 1.0 - uStrike;
      a = max(border * dash, fill * 0.6);
      a = max(a, chevron * pre * 0.9);
      col = mix(uGraphite, uInk, max(fill, border));
      col = mix(col, uGlowEdge, chevron * pre * (1.0 - fill*0.5));
      col = mix(col, uGlowCore, head * pre * step(0.02, uProg));
      a = max(a, head * 0.9 * pre * step(0.02, uProg));
      a *= 1.0 - uFade;
    } else {
      // circle: shrinking target ring + inner hatch, hot rim right before impact
      vec2 q = vUv*2.0 - 1.0; float r = length(q);
      if (r > 1.0) discard;
      float ang = atan(q.y, q.x);
      float wob = (enoise(vec2(ang*3.0, uBoil)) - 0.5)*0.04;
      float rimR = mix(1.0, 0.94, uProg) + wob;
      float ring = 1.0 - smoothstep(0.02, 0.05, abs(r - rimR));
      float dash = step(0.4, fract(ang*4.0 + uTime*1.5));
      float closing = 1.0 - smoothstep(0.02, 0.06, abs(r - (1.0 - uProg)));
      float hatch = (1.0 - smoothstep(0.08, 0.2, abs(fract((q.x+q.y)*7.0) - 0.5)*2.0)) * step(r, 1.0 - uProg);
      a = max(max(ring*dash, closing), hatch * 0.35 * uProg);
      col = mix(uGraphite, uGlowEdge, closing * smoothstep(0.6, 1.0, uProg));
      a *= 1.0 - uFade;
    }
    if (a < 0.02) discard;
    gl_FragColor = vec4(col, a);
  }
`;

export function createTelegraphMaterial(shared: EditorUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: shared.uTime,
      uBoil: shared.uBoil,
      uInk: shared.uInk,
      uGraphite: shared.uGraphite,
      uGlowEdge: shared.uGlowEdge,
      uGlowCore: shared.uGlowCore,
      uPaper: shared.uPaper,
      uKind: { value: 0 },
      uProg: { value: 0 },
      uStrike: { value: 0 },
      uFade: { value: 0 },
      uLen: { value: 10 },
      uWidthM: { value: 3 },
    },
    vertexShader: TELE_VERT,
    fragmentShader: TELE_FRAG,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
}

// ───────────────────────────── Icon sketch decals (rewrites, summons) ─────────────────────────────

/** Icon ids for `createIconSketchMaterial` (uIcon). */
export const ICON = { bolt: 0, dash: 1, crystal: 2, print: 3, summon: 4 } as const;

const ICON_FRAG = /* glsl */ `
  uniform vec3 uInk, uGraphite, uGlowEdge, uGlowCore, uPaper;
  uniform float uIcon, uDraw, uPrint, uFade, uTime, uBoil;
  varying vec2 vUv; varying vec3 vWPos;
  ${NOISE_GLSL}
  float seg(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba*h); }
  float icon(vec2 p){
    float d = 9.0;
    if (uIcon < 0.5) {            // bolt: zig-zag lightning
      d = min(d, seg(p, vec2(-0.22, 0.78), vec2(0.18, 0.08)));
      d = min(d, seg(p, vec2(0.18, 0.08), vec2(-0.16, 0.02)));
      d = min(d, seg(p, vec2(-0.16, 0.02), vec2(0.24, -0.78)));
    } else if (uIcon < 1.5) {     // dash: arrow + speed lines
      d = min(d, seg(p, vec2(-0.55, 0.0), vec2(0.62, 0.0)));
      d = min(d, seg(p, vec2(0.62, 0.0), vec2(0.32, 0.3)));
      d = min(d, seg(p, vec2(0.62, 0.0), vec2(0.32, -0.3)));
      d = min(d, seg(p, vec2(-0.8, 0.34), vec2(-0.25, 0.34)));
      d = min(d, seg(p, vec2(-0.8, -0.34), vec2(-0.25, -0.34)));
    } else if (uIcon < 2.5) {     // crystal: diamond with a facet
      d = min(d, seg(p, vec2(0.0, 0.8), vec2(0.5, 0.0)));
      d = min(d, seg(p, vec2(0.5, 0.0), vec2(0.0, -0.8)));
      d = min(d, seg(p, vec2(0.0, -0.8), vec2(-0.5, 0.0)));
      d = min(d, seg(p, vec2(-0.5, 0.0), vec2(0.0, 0.8)));
      d = min(d, seg(p, vec2(-0.5, 0.0), vec2(0.5, 0.0)));
    } else if (uIcon < 3.5) {     // print: a rubber stamp over a printed line
      d = min(d, seg(p, vec2(0.0, 0.25), vec2(0.0, 0.7)));
      d = min(d, seg(p, vec2(-0.22, 0.72), vec2(0.22, 0.72)));
      d = min(d, seg(p, vec2(-0.6, 0.22), vec2(0.6, 0.22)));
      d = min(d, seg(p, vec2(0.6, 0.22), vec2(0.6, -0.12)));
      d = min(d, seg(p, vec2(0.6, -0.12), vec2(-0.6, -0.12)));
      d = min(d, seg(p, vec2(-0.6, -0.12), vec2(-0.6, 0.22)));
      d = min(d, seg(p, vec2(-0.72, -0.48), vec2(0.72, -0.48)));
    } else {                      // summon: a loose scribble spiral (an enemy being drawn)
      float r = length(p); float a = atan(p.y, p.x);
      float sp = abs(fract((r * 3.2 - a / 6.2832) + 0.5) - 0.5) / 3.2;
      d = r < 0.8 ? sp : 9.0;
    }
    return d;
  }
  void main(){
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float ang = atan(p.y, p.x);
    // draw-in: sweeps around like a pencil going round the page
    float drawn = step(fract((ang / 6.2832) + 0.25), uDraw * 1.02);
    float wob = (enoise(p * 3.0 + uBoil) - 0.5) * 0.05;
    float d = icon(p + wob);
    float stroke = 1.0 - smoothstep(0.045, 0.075, d);
    // pencil: broken, uneven graphite; ink: solid
    float broken = step(0.32, fract((p.x * 0.7 + p.y) * 5.0 + uBoil * 0.13)) * (0.6 + 0.4 * enoise(p * 9.0));
    float ring = 1.0 - smoothstep(0.015, 0.04, abs(r - 0.93 - wob));
    float ringDash = step(0.45, fract(ang * 3.5 + uTime * 0.4));
    // print progress inks the icon from the centre out, with a hot front
    float inked = step(r, uPrint * 1.05);
    float front = (1.0 - smoothstep(0.0, 0.06, abs(r - uPrint * 1.05))) * step(0.01, uPrint) * step(uPrint, 0.99);
    float a = max(stroke * mix(broken, 1.0, inked), ring * ringDash * 0.7);
    vec3 col = mix(uGraphite, uInk, inked * stroke);
    col = mix(col, uGlowEdge, front);
    a = max(a, front * 0.8);
    a *= drawn * (1.0 - uFade);
    if (a < 0.02) discard;
    gl_FragColor = vec4(col, a);
  }
`;

export function createIconSketchMaterial(shared: EditorUniforms, icon: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: shared.uTime,
      uBoil: shared.uBoil,
      uInk: shared.uInk,
      uGraphite: shared.uGraphite,
      uGlowEdge: shared.uGlowEdge,
      uGlowCore: shared.uGlowCore,
      uPaper: shared.uPaper,
      uIcon: { value: icon },
      uDraw: { value: 0 },
      uPrint: { value: 0 },
      uFade: { value: 0 },
    },
    vertexShader: TELE_VERT,
    fragmentShader: ICON_FRAG,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
}

// ───────────────────────────── Pencil construction strokes ─────────────────────────────

const STROKE_VERT = /* glsl */ `
  attribute vec3 aNext; attribute float aSide; attribute float aAlong; attribute float aSeed;
  uniform float uBoil, uWidthPx, uDrawn; uniform vec2 uRes;
  varying float vAlong; varying float vSide; varying float vSeed;
  ${NOISE_GLSL}
  void main(){
    vAlong = aAlong; vSide = aSide; vSeed = aSeed;
    vec3 jit = (vec3(enoise(vec2(aSeed*13.1, uBoil*7.0)), enoise(vec2(aSeed*5.7, uBoil*3.0)), enoise(vec2(aSeed*2.3, uBoil*5.0))) - 0.5) * 0.06;
    vec4 a = projectionMatrix * modelViewMatrix * vec4(position + jit, 1.0);
    vec4 b = projectionMatrix * modelViewMatrix * vec4(aNext + jit, 1.0);
    vec2 sa = a.xy / a.w; vec2 sb = b.xy / b.w;
    vec2 d = normalize((sb - sa) * uRes + 1e-5);
    vec2 n = vec2(-d.y, d.x);
    float w = uWidthPx * (0.6 + 0.8*enoise(vec2(aAlong*0.7, aSeed)));
    a.xy += n * aSide * w * a.w / uRes;
    gl_Position = a;
  }
`;
const STROKE_FRAG = /* glsl */ `
  uniform vec3 uGraphite, uInk; uniform float uDrawn, uFade, uBoil;
  varying float vAlong; varying float vSide; varying float vSeed;
  void main(){
    if (vAlong > uDrawn * 40.0) discard;
    float dash = fract(vAlong * 1.3 + vSeed * 3.1);
    if (dash > 0.78 && fract(vSeed*7.3) > 0.35) discard;
    if (uFade > 0.0 && fract(vSeed * 17.31) < uFade) discard;
    gl_FragColor = vec4(uGraphite, 1.0);
  }
`;

export function createStrokeMaterial(shared: EditorUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uBoil: shared.uBoil,
      uRes: shared.uRes,
      uGraphite: shared.uGraphite,
      uInk: shared.uInk,
      uWidthPx: { value: 1.3 },
      uDrawn: { value: 1 },
      uFade: { value: 0 },
    },
    vertexShader: STROKE_VERT,
    fragmentShader: STROKE_FRAG,
    side: THREE.DoubleSide,
  });
}

// ───────────────────────────── Particles (crumbs, ink, paper shreds) ─────────────────────────────

const PART_VERT = /* glsl */ `
  attribute vec4 aData; // x: shape (0 blob, 1 crumb, 2 shred), y: rot, z: size, w: life 0..1
  attribute vec3 aColor;
  varying vec2 vUv; varying vec3 vCol; varying float vShape; varying float vLife;
  void main(){
    vUv = uv; vCol = aColor; vShape = aData.x; vLife = aData.w;
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float c = cos(aData.y), s = sin(aData.y);
    vec2 p = position.xy * aData.z;
    if (aData.x > 1.5) p.y *= 0.45;
    mv.xy += vec2(p.x*c - p.y*s, p.x*s + p.y*c);
    gl_Position = projectionMatrix * mv;
  }
`;
const PART_FRAG = /* glsl */ `
  uniform vec3 uInk;
  varying vec2 vUv; varying vec3 vCol; varying float vShape; varying float vLife;
  ${NOISE_GLSL}
  void main(){
    vec2 q = vUv*2.0 - 1.0;
    float n = enoise(q*2.5 + vLife*0.0 + vCol.r*10.0);
    float r = length(q) + (n - 0.5)*0.5;
    vec3 col = vCol;
    if (vShape < 0.5) { if (r > 0.9 * (0.35 + 0.65*vLife)) discard; }
    else if (vShape < 1.5) { if (max(abs(q.x), abs(q.y)) + (n-0.5)*0.4 > 0.8) discard; }
    else {
      if (abs(q.x) + (n-0.5)*0.6 > 0.85 || abs(q.y) > 0.9) discard;
      if (abs(q.y) > 0.72) col = uInk;
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createParticleMaterial(shared: EditorUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uInk: shared.uInk },
    vertexShader: PART_VERT,
    fragmentShader: PART_FRAG,
    side: THREE.DoubleSide,
  });
}

// ───────────────────────────── Ink cover (page goes full ink) ─────────────────────────────

const COVER_VERT = /* glsl */ `
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const COVER_FRAG = /* glsl */ `
  uniform vec3 uInk, uGlowEdge; uniform vec2 uCenter; uniform float uAmt, uAspect, uTime;
  varying vec2 vUv;
  ${NOISE_GLSL}
  void main(){
    vec2 q = vUv - uCenter; q.x *= uAspect;
    float ang = atan(q.y, q.x);
    float r = length(q);
    // splat: lobes + fbm edge + drips running down
    float lobes = efbm(vec2(ang*2.2, 1.7)) * 0.35 + enoise(vec2(ang*7.0, 4.0))*0.12;
    float R = uAmt * (1.9 + lobes) ;
    float drips = pow(enoise(vec2(vUv.x*26.0, 2.0)), 4.0) * 0.9 * smoothstep(0.2, 1.0, uAmt);
    float m = step(r, R);
    m = max(m, step(1.0 - vUv.y, uAmt*0.9 + drips) * step(0.05, uAmt));
    // satellite droplets
    float sp = step(0.86 - uAmt*0.4, enoise(vUv*vec2(uAspect, 1.0)*18.0)) * step(0.02, uAmt) * step(r, R + 0.25);
    m = max(m, sp);
    if (m < 0.5) discard;
    float rimd = abs(r - R);
    vec3 col = mix(uInk, uGlowEdge, (1.0 - smoothstep(0.0, 0.012, rimd)) * 0.5 * (1.0 - step(0.98, uAmt)));
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createInkCoverMaterial(shared: EditorUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uInk: shared.uInk,
      uGlowEdge: shared.uGlowEdge,
      uTime: shared.uTime,
      uCenter: { value: new THREE.Vector2(0.5, 0.6) },
      uAmt: { value: 0 },
      uAspect: { value: 1 },
    },
    vertexShader: COVER_VERT,
    fragmentShader: COVER_FRAG,
    depthTest: false,
    depthWrite: false,
  });
}
