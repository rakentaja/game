import { NOISE_GLSL } from './glsl';

/**
 * Instanced ribbons on a unit quad (x 0..1 along, y -0.5..0.5 across):
 *   aP0 = (start.xyz, type)   type 0 telegraph, 1 pencil projectile, 2 ground shadow, 3 drain tendril
 *                             4 comic panel border (Panel Warden; aL.w = 1 dashed preview)
 *   aP1 = (end.xyz, width)
 *   aL  = (progress, seed, vis, extra)
 * Telegraphs and projectiles ignore the reveal mask (pencil marks read on blank paper too, for
 * fairness); shadows and tendrils are masked like the bodies.
 */
export const FX_VERT = /* glsl */ `
attribute vec4 aP0;
attribute vec4 aP1;
attribute vec4 aL;
uniform float uTime;
varying vec2 vQ;
varying vec4 vL;
varying float vType;
varying float vLen;
varying vec3 vWPos;
void main(){
  vec3 a = aP0.xyz;
  vec3 b = aP1.xyz;
  vec3 d = b - a;
  float len = max(length(d), 1e-4);
  vec3 dir = d / len;
  vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), dir) + vec3(1e-5));
  float x = position.x + 0.5;
  float y = position.y;
  vec3 p = a + d * x;
  float t = aP0.w;
  if (t > 2.5) {
    // tendril: sine wiggle + pulled up into an arc
    float w = sin(x * 9.0 - uTime * 7.0 + aL.y * 10.0) * 0.12 * sin(x * 3.14159);
    p += side * w;
    p.y += sin(x * 3.14159) * 0.45;
  }
  p += side * y * aP1.w;
  vQ = vec2(x, y);
  vL = aL;
  vType = t;
  vLen = len;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const FX_FRAG = /* glsl */ `
${NOISE_GLSL}
__INK_MASK__
uniform vec3 uRamp0, uRamp1, uRamp2, uRamp3;
uniform float uTime;
varying vec2 vQ;
varying vec4 vL;
varying float vType;
varying float vLen;
varying vec3 vWPos;
void main(){
  float x = vQ.x;
  float y = vQ.y * 2.0; // -1..1 across
  float seed = vL.y;
  float rag = (en(vec2(x * vLen * 6.0, seed * 50.0)) - 0.5) * 0.35;
  if (vType > 3.5){
    // Panel border: a bold ink rule with a paper inner edge, readable on blank paper (unmasked).
    float ay = abs(y) + rag * 0.25;
    if (ay > 1.0) discard;
    if (vL.w > 0.5 && fract(x * vLen / 0.6 - uTime) > 0.55) discard;
    gl_FragColor = vec4(ay < 0.3 ? uRamp3 : uRamp0, 1.0);
    return;
  }
  if (vType < 0.5){
    // Telegraph: a dashed pencil line scratching itself toward the target. As it charges the
    // dashes close up and the line thickens — readable by shape, not colour.
    float prog = vL.x;
    float drawn = prog * 1.25;
    if (x > drawn) discard;
    float s = x * vLen;
    float duty = mix(0.42, 0.92, prog);
    float dash = fract(s / 0.5 - uTime * 1.5);
    if (dash > duty) discard;
    float w = mix(0.35, 1.0, prog) * (1.0 - smoothstep(0.92, 1.0, x));
    float ay = abs(y) + rag;
    if (ay > w) discard;
    // light halo + ink core
    gl_FragColor = vec4(ay > w * 0.55 ? uRamp3 : uRamp0, 1.0);
    // impact cross at the end once nearly charged
    return;
  }
  if (vType < 1.5){
    // Pencil stroke projectile: sharpened tip at x=1, graphite body, scribbled tail.
    float tip = smoothstep(0.78, 1.0, x);
    float w = (1.0 - tip) * 0.85 + 0.02;
    float tail = smoothstep(0.0, 0.45, x);
    float ay = abs(y + sin(x * 40.0 + uTime * 30.0) * 0.25 * (1.0 - tail));
    if (ay > w * mix(0.25, 1.0, tail)) discard;
    vec3 c = uRamp1;
    if (ay > w * 0.62 || tip > 0.55 || x < 0.45) c = uRamp0;
    if (tip > 0.0 && tip < 0.55 && ay < w * 0.4) c = uRamp2;
    gl_FragColor = vec4(c, 1.0);
    return;
  }
  float m = inkMask(vWPos.xz);
  if (vType < 2.5){
    // Ground shadow: ragged ink disc, only inside the inked circle.
    if (m < 0.5 || vL.z < 0.02) discard;
    vec2 q = vec2(x * 2.0 - 1.0, y);
    float r = length(q) + (en(q * 3.0 + seed * 9.0) - 0.5) * 0.25;
    if (r > 0.95 * vL.z) discard;
    // line-screen shadow so it never becomes a flat blob
    float hatch = fract((gl_FragCoord.x + gl_FragCoord.y) / 4.0);
    if (r > 0.55 && hatch > 0.5) discard;
    gl_FragColor = vec4(uRamp0, 1.0);
    return;
  }
  // Drain tendril: ink rope with beads flowing toward the blot (x=0). While latching (vL.x =
  // windup) it is drawn as a dashed pencil sketch growing toward the crystal.
  if (m < 0.35 || vL.z < 0.02) discard;
  if (vL.x > 0.01 && vL.z < 0.76) {
    if (x > vL.x * 1.1) discard;
    if (fract(x * vLen / 0.35 - uTime * 2.0) > 0.55) discard;
    if (abs(y) > 0.45) discard;
    gl_FragColor = vec4(uRamp0, 1.0);
    return;
  }
  float bead = 0.5 + 0.5 * sin(x * 22.0 + uTime * 14.0);
  float w = (0.35 + 0.65 * bead * 0.6) * vL.z * (1.0 - smoothstep(0.85, 1.0, x));
  float ay = abs(y) + rag * 0.5;
  if (ay > w) discard;
  gl_FragColor = vec4(ay < w * 0.25 && bead > 0.8 ? uRamp1 : uRamp0, 1.0);
}
`;

/**
 * Particles: instanced quads with their own instanceMatrix (CPU sim) plus
 *   aQ = (type, seed, life01, tone)  type 0 paper scrap, 1 ink droplet/splat, 2 pencil shaving
 */
export const PARTICLE_VERT = /* glsl */ `
attribute vec4 aQ;
varying vec2 vUv;
varying vec4 vQ;
varying vec3 vWPos;
void main(){
  vUv = uv;
  vQ = aQ;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const PARTICLE_FRAG = /* glsl */ `
${NOISE_GLSL}
__INK_MASK__
uniform vec3 uRamp0, uRamp1, uRamp2, uRamp3;
varying vec2 vUv;
varying vec4 vQ;
varying vec3 vWPos;
void main(){
  float m = inkMask(vWPos.xz);
  if (m < 0.3) discard;
  vec2 q = vUv * 2.0 - 1.0;
  float seed = vQ.y;
  if (vQ.x < 0.5){
    // torn paper scrap: jagged polygon
    float a = atan(q.y, q.x);
    float r = length(q);
    float edge = 0.62 + 0.3 * en(vec2(a * 2.2, seed * 40.0)) + 0.12 * eh(vec2(floor(a * 4.0), seed));
    if (r > edge) discard;
    vec3 c = vQ.w > 0.5 ? uRamp3 : uRamp2;
    if (r > edge - 0.16) c = uRamp0;
    if (abs(q.x * 0.7 + q.y - (seed - 0.5)) < 0.05) c = uRamp1; // fold line
    gl_FragColor = vec4(c, 1.0);
    return;
  }
  if (vQ.x < 1.5){
    float r = length(q) + (en(q * 2.5 + seed * 20.0) - 0.5) * 0.35;
    if (r > 0.85) discard;
    gl_FragColor = vec4(r < 0.22 && vQ.w > 0.5 ? uRamp1 : uRamp0, 1.0);
    return;
  }
  // pencil shaving curl
  float r = length(q);
  if (r > 0.9 || r < 0.45) discard;
  float a = atan(q.y, q.x);
  if (a > 2.2) discard;
  gl_FragColor = vec4(r < 0.58 ? uRamp0 : uRamp1, 1.0);
}
`;
