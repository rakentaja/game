import { NOISE_GLSL } from './glsl';

/**
 * One lathe grid drives all three enemy bodies: the vertex shader evaluates a per-kind surface
 * f(u,v) (u = angle 0..1, v = height 0..1) so every enemy is one instance of one draw call.
 *
 * Instance attributes (see EnemyRenderer):
 *   aA = (kind, seed, revealVis, spawn)
 *   aB = (hit, death, windup, recoil)
 *   aC = (lunge, drain, lagX, lagZ)        lag = local velocity for cloth trailing
 *   aD = (speed01, hp01, drainDirX, drainDirZ)  drain dir is local-space, unit
 *   aE = (variant, eliteTint, aux0, aux1)
 *        variant: misprint plate 0..2 (C/M/Y, see-through halftone) or 3 = in register
 *        eliteTint: 0 none, 1 First Edition (gold), 2 Inked In (teal), 3 Bleed-Through (red)
 *        aux0: crane fold / redactor exposure / margin-man hittable glow
 *        aux1: redactor shield
 *
 * Kinds (KIND_INDEX): 0 smudge, 1 scribbler, 2 blot, 3 margin man, 4 redactor, 5 panel warden,
 * 6 misprint, 7 crane. "Ink" kinds (blot, redactor) use the inverse palette and the splat death.
 */
export const BODY_VERT = /* glsl */ `
${NOISE_GLSL}
attribute vec4 aA;
attribute vec4 aB;
attribute vec4 aC;
attribute vec4 aD;
attribute vec4 aE;
attribute vec2 aCell;
uniform float uTime;
uniform float uOutline;
uniform float uOutlineW;
uniform float uEliteW;
varying vec4 vE;
varying vec3 vWPos;
varying vec3 vN;
varying vec2 vGrid;
varying vec4 vA;
varying vec4 vB;
varying vec4 vC;
varying vec3 vLocal;
varying float vHp;
varying float vShard;

const float TAU = 6.2831853;
const float PI = 3.1415927;

float K, SEED, T, HIT, DEATH, WIND, RECOIL, LUNGE, DRAIN, SPEED, AUX0, AUX1;
vec2 LAG, DDIR;

float ang(float th){ return atan(sin(th), cos(th)); }
bool isK(float k){ return abs(K - k) < 0.5; }
/** Ink-bodied kinds: blot, redactor. */
float inkKind(){ return (isK(2.0) || isK(4.0)) ? 1.0 : 0.0; }
float kindHeight(){
  if (isK(0.0) || isK(6.0)) return 1.15;
  if (isK(1.0)) return 2.5;
  if (isK(2.0)) return 0.95;
  if (isK(3.0)) return 2.0;
  if (isK(4.0)) return 1.2;
  if (isK(5.0)) return 1.8;
  return 0.4;
}
float kindCenterY(){
  if (isK(0.0) || isK(6.0)) return 0.6;
  if (isK(1.0)) return 1.2;
  if (isK(2.0)) return 0.3;
  if (isK(3.0)) return 1.0;
  if (isK(4.0)) return 0.86;
  if (isK(5.0)) return 0.9;
  return 0.05;
}
float sgnPow(float x, float e){ return sign(x) * pow(abs(x), e); }

vec3 marginShape(float u, float v, out float hem){
  // trench coat, collar, head, brimmed hat: a pencil-noir silhouette
  float th = u * TAU;
  hem = 0.0;
  float r;
  float y;
  if (v < 0.58){
    float k = v / 0.58;
    hem = pow(1.0 - k, 4.0);
    r = mix(0.30, 0.21, k) + 0.07 * exp(-pow((k - 0.94) / 0.07, 2.0));
    r += hem * 0.03 * sin(th * 6.0 + T * 3.0);
    y = k * 1.36;
  } else if (v < 0.63){
    float k = (v - 0.58) / 0.05;
    r = mix(0.2, 0.075, k);
    y = 1.36 + k * 0.1;
  } else if (v < 0.79){
    float k = (v - 0.63) / 0.16;
    float a = (k - 0.5) * PI;
    r = max(0.075, cos(a) * 0.135);
    y = 1.6 + sin(a) * 0.14;
  } else if (v < 0.84){
    float k = (v - 0.79) / 0.05;
    r = mix(0.1, 0.36, k);
    y = 1.73;
  } else if (v < 0.87){
    float k = (v - 0.84) / 0.03;
    r = mix(0.36, 0.17, k);
    y = 1.73 + 0.025 * k;
  } else {
    float k = (v - 0.87) / 0.13;
    r = 0.17 * (1.0 - smoothstep(0.85, 1.0, k)) * (1.0 - 0.12 * k);
    y = 1.755 + min(k, 0.9) * 0.24;
  }
  vec3 p = vec3(sin(th) * r, y, cos(th) * r * 0.75);
  p.z += pow(max(0.0, y - 0.9), 2.0) * 0.12;
  // windup: hunch forward and tremble (the shutter burst)
  p.z += WIND * 0.2 * smoothstep(0.6, 1.8, y);
  p.x += sin(T * 60.0) * 0.015 * WIND;
  // strike: lean in
  p.z += LUNGE * 0.3 * smoothstep(0.4, 1.6, y);
  return p;
}

vec3 redactorShape(float u, float v, out float hem){
  // a black censorship bar: rounded slab hovering at chest height
  float th = u * TAU;
  hem = 0.0;
  float px = sgnPow(sin(th), 0.25) * 1.15;
  float pz = sgnPow(cos(th), 0.25) * 0.16;
  float y;
  float sc = 1.0;
  if (v < 0.08){ sc = v / 0.08; y = 0.0; }
  else if (v > 0.92){ sc = (1.0 - v) / 0.08; y = 1.0; }
  else y = (v - 0.08) / 0.84;
  sc = sqrt(clamp(sc, 0.0, 1.0));
  vec3 p = vec3(px * sc, 0.55 + y * 0.62, pz * sc);
  p.x += sin(T * 47.0 + v * 9.0) * 0.025 * AUX0 * AUX1;
  p.y += sin(p.x * 3.0 + T * 2.0) * 0.03;
  return p;
}

vec3 wardenShape(float u, float v, out float hem){
  // a stiff standing comic panel (card) with a face
  float th = u * TAU;
  float px = sgnPow(sin(th), 0.3) * 0.48;
  float pz = sgnPow(cos(th), 0.3) * 0.1;
  float y;
  float sc = 1.0;
  if (v > 0.92){ sc = (1.0 - v) / 0.08; y = 1.0; } else y = v / 0.92;
  sc = sqrt(clamp(sc, 0.0, 1.0));
  hem = pow(1.0 - y, 6.0);
  vec3 p = vec3(px * sc, y * 1.8, pz * sc);
  p.z += sin(p.y * 1.4 + T * 1.3) * 0.05;
  p.z -= p.y * 0.18 * WIND;
  p.x += sin(T * 50.0) * 0.012 * WIND * y;
  return p;
}

vec3 craneShape(float u, float v, out float hem){
  // origami crane: flat folded paper; AUX0 = fold into a dart
  float th = u * TAU;
  hem = 0.0;
  float s = sin(th);
  float c = cos(th);
  float fold = AUX0;
  float wing = pow(abs(s), 5.0) * (1.0 - fold * 0.85);
  float neck = pow(max(c, 0.0), 10.0);
  float tail = pow(max(-c, 0.0), 10.0);
  float r = 0.10 + 0.5 * wing + (0.32 + 0.25 * fold) * neck + 0.28 * tail;
  float phi = v * PI;
  float thick = sin(phi);
  vec3 p = vec3(s * r * thick, cos(phi) * 0.05, c * r * thick);
  float flap = sin(T * 11.0 + SEED * 9.0) * (1.0 - fold);
  p.y += abs(p.x) * (0.45 * flap + 0.9 * fold);
  p.y += neck * 0.18 + tail * 0.14;
  return p * 0.72;
}

vec3 smudgeShape(float u, float v, out float hem){
  float th = u * TAU;
  float R = 0.40;
  float sh = 0.52;
  hem = 0.0;
  if (v > sh){
    float phi = (v - sh) / (1.0 - sh) * 1.5707963;
    float r = R * cos(phi);
    // slightly pointed, lopsided crown
    float y = 0.66 + sin(phi) * R * 1.2 + pow(sin(phi), 8.0) * 0.08;
    return vec3(sin(th) * r, y, cos(th) * r + sin(phi) * 0.04);
  }
  float s = 1.0 - v / sh;
  hem = s;
  float r = R * (1.0 + 0.62 * pow(s, 1.5));
  float cell = floor(u * 13.0);
  float tat = 0.11 * sin(th * 5.0 + SEED * 20.0 + T * 2.3)
            + 0.06 * sin(th * 11.0 - T * 3.4 + SEED * 7.0)
            + 0.10 * (eh(vec2(cell, SEED * 31.0)) - 0.5);
  float y = mix(0.66, 0.0, s) + pow(s, 3.0) * tat;
  r += s * s * 0.075 * sin(th * 4.0 + T * 5.5 + v * 9.0 + SEED * 9.0);
  return vec3(sin(th) * r, y, cos(th) * r);
}

vec3 scribblerShape(float u, float v, out float hem){
  float th = u * TAU;
  float R = 0.27;
  vec3 p;
  hem = 0.0;
  if (v < 0.70){
    float k = v / 0.70;
    float r = R * (1.35 - 0.7 * k);
    hem = pow(1.0 - k, 3.0);
    float cell = floor(u * 11.0);
    float y = k * 1.55 + hem * (0.09 * sin(th * 7.0 + SEED * 13.0 + T * 1.7) + 0.08 * (eh(vec2(cell, SEED)) - 0.5));
    r += hem * 0.04 * sin(th * 5.0 + T * 4.0);
    p = vec3(sin(th) * r, y, cos(th) * r);
  } else if (v < 0.76){
    float k = (v - 0.70) / 0.06;
    float r = mix(R * 0.62, 0.09, k);
    p = vec3(sin(th) * r, 1.55 + k * 0.08, cos(th) * r);
  } else {
    float k = (v - 0.76) / 0.24;
    float r = 0.22 * pow(max(sin(PI * min(k * 0.92 + 0.08, 1.0)), 0.0), 0.7) * (1.0 - 0.45 * k);
    float y = 1.63 + k * 0.78 + pow(k, 6.0) * 0.22;
    p = vec3(sin(th) * r, y, cos(th) * r * 1.1 + 0.04);
  }
  // Pencil arm (right, +x) and limp arm (left): gaussian pulls on the lathe surface.
  float vArm = exp(-pow((v - 0.55) / 0.11, 2.0));
  float aR = exp(-pow(ang(th - 1.5707963) / 0.42, 2.0)) * vArm;
  float aL = exp(-pow(ang(th + 1.5707963) / 0.42, 2.0)) * vArm;
  vec3 down = vec3(0.30, -0.40, 0.10);
  vec3 up = vec3(0.32, 0.55, 0.30);
  vec3 throwD = vec3(0.05, 0.15, 0.95);
  vec3 armR = mix(mix(down, up, smoothstep(0.0, 0.35, WIND)), throwD, LUNGE);
  armR.x += sin(T * 40.0) * 0.03 * WIND;
  p += aR * armR * mix(0.95, 0.62, max(WIND, LUNGE));
  p += aL * vec3(-0.30, -0.45, 0.06 + 0.06 * sin(T * 2.0 + SEED)) * 0.8;
  // hunch: upper body leans forward over the player
  p.z += pow(max(0.0, p.y - 0.7), 2.0) * 0.32;
  p.x += sin(T * 2.6 + SEED * 10.0) * 0.05 * v;
  return p;
}

vec3 blotShape(float u, float v, out float puddle){
  float th = u * TAU;
  float R = 0.56;
  float phi = v * PI;
  float r = sin(phi) * R;
  float y = (1.0 - cos(phi)) * 0.5 * 0.95;
  // flatten the base into a puddle lip that spreads over the ground
  puddle = smoothstep(0.0, 0.07, v) * (1.0 - smoothstep(0.07, 0.36, v));
  r += puddle * R * 0.85;
  y *= smoothstep(0.02, 0.5, v) * 0.9 + 0.1;
  float lobes = 1.0 + (0.17 * sin(3.0 * th + T * 1.4 + SEED * 6.0) + 0.10 * sin(5.0 * th - T * 2.2 + v * 5.0 + SEED * 3.0)) * sin(phi);
  r *= lobes;
  // drips/tendrils across the puddle lip
  r += R * 0.65 * pow(max(0.0, sin(7.0 * th + SEED * 11.0 + sin(T * 0.7) * 0.6)), 10.0) * puddle;
  float breathe = 1.0 + 0.09 * sin(T * 3.1 + SEED * 5.0) + DRAIN * 0.14 * sin(T * 11.0);
  y *= breathe;
  // Latch telegraph: rears up into a tall teardrop, narrows and shivers.
  y *= 1.0 + 0.75 * WIND * smoothstep(0.15, 0.9, v);
  r *= 1.0 - 0.22 * WIND * smoothstep(0.3, 1.0, v);
  r += sin(T * 46.0 + v * 9.0) * 0.025 * WIND;
  vec3 p = vec3(sin(th) * r, y, cos(th) * r);
  // drain tendril reaching for the crystal
  vec2 dir = normalize(DDIR + vec2(1e-4));
  float face = pow(max(0.0, dot(normalize(p.xz + vec2(1e-4)), dir)), 5.0) * sin(phi) * smoothstep(0.3, 0.8, v);
  float reach = DRAIN * face * (0.9 + 0.25 * sin(T * 9.0));
  p.xz += dir * reach;
  p.y += reach * 0.55;
  return p;
}

vec3 baseShape(float u, float v, out float hem){
  if (isK(0.0) || isK(6.0)) return smudgeShape(u, v, hem);
  if (isK(1.0)) return scribblerShape(u, v, hem);
  if (isK(2.0)) return blotShape(u, v, hem);
  if (isK(3.0)) return marginShape(u, v, hem);
  if (isK(4.0)) return redactorShape(u, v, hem);
  if (isK(5.0)) return wardenShape(u, v, hem);
  return craneShape(u, v, hem);
}

/** Full animated shape before death shards. */
vec3 shapeAt(float u, float v, out float hem){
  vec3 p = baseShape(u, v, hem);
  float isPaper = 1.0 - inkKind();
  float hgt = kindHeight();
  float yn = clamp(p.y / hgt, 0.0, 1.0);
  // Crumple: ridged folds (static) + stepped flutter near the hem (12 fps paper boil).
  vec3 cn = vec3(p.x, p.y * 0.8, p.z) * 5.5 + SEED * 17.0;
  float folds = abs(en3(cn) - 0.5) * 2.0 - 0.5;
  float flutter = en3(cn * 0.7 + vec3(0.0, floor(T * 12.0) * 0.61, 0.0)) - 0.5;
  vec3 radial = normalize(vec3(p.x, (p.y - hgt * 0.5) * 0.35, p.z) + vec3(1e-4));
  float crAmt = (0.045 + 0.06 * HIT + 0.03 * RECOIL) * isPaper;
  p += radial * (folds * crAmt + flutter * (0.02 + 0.05 * hem) * isPaper);
  // Cloth lag: hem trails motion and lifts with speed.
  p.xz -= LAG * 0.085 * hem * hem;
  p.y += SPEED * 0.16 * hem * hem * isPaper;
  p.z += p.y * 0.10 * SPEED * isPaper;
  // Windup (squash, widen, lean back, shudder)
  float w = WIND * (isK(0.0) ? 1.0 : 0.0);
  p.y *= 1.0 - 0.30 * w;
  p.xz *= 1.0 + 0.24 * w;
  p.z -= p.y * 0.28 * w;
  p.x += sin(T * 70.0 + p.y * 4.0) * 0.03 * w;
  // Scribbler telegraph: rear back, tremble.
  float ws = WIND * (isK(1.0) ? 1.0 : 0.0);
  p.z -= p.y * 0.12 * ws;
  p.x += sin(T * 55.0) * 0.012 * ws * yn;
  // Lunge (smudge dart = stretch into a streak)
  float l = LUNGE * ((isK(0.0) || isK(6.0) || isK(7.0)) ? 1.0 : 0.0);
  p.z = p.z * (1.0 + 0.55 * l) + p.y * 0.35 * l;
  p.x *= 1.0 - 0.22 * l;
  p.y *= 1.0 - 0.12 * l;
  // Recoil: snap back
  p.z -= p.y * 0.42 * RECOIL;
  // Hit: inflate & squash
  p.xz *= 1.0 + 0.2 * HIT;
  p.y *= 1.0 - 0.12 * HIT;
  // Hover
  float bob = (isK(0.0) || isK(6.0)) ? 0.18 + 0.08 * sin(T * 2.1 + SEED * 30.0)
    : (isK(1.0) || isK(5.0)) ? 0.06 + 0.03 * sin(T * 1.7 + SEED * 9.0)
    : isK(4.0) ? 0.06 * sin(T * 1.3 + SEED * 7.0) : 0.0;
  p.y += bob * (1.0 - DEATH);
  // Spawn: smudge/scribbler rise out of the page, blot wells up.
  float sp = aA.w;
  float e = 1.0 - pow(1.0 - sp, 3.0);
  float over = 1.0 + sin(sp * PI) * 0.12;
  if (isPaper > 0.5) { p *= mix(0.2, 1.0, e) * over; p.y -= (1.0 - e) * 0.6; }
  else { p.xz *= mix(1.6, 1.0, e) * over; p.y *= e; }
  return p;
}

vec3 rotAxis(vec3 p, vec3 a, float t){
  float c = cos(t), s = sin(t);
  return p * c + cross(a, p) * s + a * dot(a, p) * (1.0 - c);
}

void main(){
  K = aA.x; SEED = aA.y; HIT = aB.x; DEATH = aB.y; WIND = aB.z; RECOIL = aB.w;
  LUNGE = aC.x; DRAIN = aC.y; LAG = aC.zw; SPEED = aD.x; DDIR = aD.zw;
  AUX0 = aE.z; AUX1 = aE.w;
  T = uTime + SEED * 40.0;
  float u = position.x;
  float v = position.y;
  float hem;
  vec3 p = shapeAt(u, v, hem);
  float h2;
  const float E = 0.004;
  vec3 pu = shapeAt(u + E, v, h2);
  vec3 pv = shapeAt(u, min(v + E, 1.0), h2);
  vec3 n = cross(pv - p, pu - p);
  if (dot(n, n) < 1e-12) n = vec3(0.0, 1.0, 0.0);
  n = normalize(n);
  float cy = kindCenterY();
  if (dot(n, vec3(p.x, (p.y - cy) * 0.6, p.z)) < 0.0) n = -n;

  vShard = 0.0;
  if (DEATH > 0.0){
    if (inkKind() < 0.5){
      // Paper tears into cells that spin out and flutter down.
      float cu = aCell.x, cv = aCell.y;
      vec2 cid = vec2(cu, cv) + SEED * 13.0;
      float r1 = eh(cid), r2 = eh(cid + 3.7), r3 = eh(cid + 9.1);
      vec3 c = shapeAt((cu + 0.5) / 7.0, (cv + 0.5) / 5.0, h2);
      float t = DEATH;
      vec3 out_ = normalize(vec3(c.x, 0.0, c.z) + vec3(r1 - 0.5, 0.0, r3 - 0.5) * 0.8 + vec3(1e-4));
      vec3 vel = out_ * (1.4 + 2.2 * r1) + vec3(0.0, 1.8 + 2.4 * r2, 0.0);
      float tt = t * 0.9;
      vec3 off = vel * tt - vec3(0.0, 5.5 * tt * tt, 0.0);
      vec3 axis = normalize(vec3(r1 - 0.5, r2 - 0.5, r3 - 0.5) + vec3(1e-4));
      float shrink = (1.0 - smoothstep(0.45, 1.0, t)) * (1.0 + 0.25 * smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.08, 0.3, t)));
      vec3 lp = rotAxis(p - c, axis, t * (5.0 + 7.0 * r3)) * shrink;
      vec3 cc = c + off;
      cc.y = max(cc.y, 0.03);
      p = cc + lp;
      n = rotAxis(n, axis, t * (5.0 + 7.0 * r3));
      vShard = r1;
    } else {
      // Ink splat: slump into a puddle with spikes, then soak away (frag dissolve).
      float t = DEATH;
      float th = u * TAU;
      float slump = smoothstep(0.0, 0.35, t);
      p.y *= 1.0 - slump * 0.93;
      p.xz *= 1.0 + 1.5 * slump + 0.7 * pow(abs(sin(th * 6.0 + SEED * 9.0)), 6.0) * slump;
      p.y += 0.02;
    }
  }

  vGrid = vec2(u, v);
  vA = aA; vB = aB; vC = aC; vHp = aD.y; vE = aE;
  vLocal = p;
  if (uOutline > 0.5){
    float w = uOutlineW * smoothstep(0.0, 0.6, aA.z) * (1.0 + 0.6 * HIT) * (1.0 - smoothstep(0.6, 1.0, DEATH));
    if (aE.y > 0.5) w *= uEliteW;
    p += n * w;
  }
  vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vWPos = wp.xyz;
  vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const BODY_FRAG = /* glsl */ `
${NOISE_GLSL}
__INK_MASK__
uniform vec3 uRamp0, uRamp1, uRamp2, uRamp3;
uniform vec3 uKeyDir;
uniform vec3 uCrystalPos;
uniform float uShadow;
uniform float uTime;
uniform float uOutline;
uniform float uFogNear, uFogFar;
uniform vec3 uTintC, uTintM, uTintY, uGold, uEliteTeal, uEliteRed;
varying vec3 vWPos;
varying vec3 vN;
varying vec2 vGrid;
varying vec4 vA;
varying vec4 vB;
varying vec4 vC;
varying vec4 vE;
varying vec3 vLocal;
varying float vHp;
varying float vShard;

const float TAU = 6.2831853;

bool kindIs(float kind, float k){ return abs(kind - k) < 0.5; }

float ell(vec2 p, vec2 c, vec2 r){ vec2 d = (p - c) / r; return dot(d, d); }

/** Returns 1 for ink features (eyes/mouth), 2 for light features. */
float face(float kind, float a, float v, float wind, float lunge, float drain, float seed){
  vec2 q = vec2(a, v);
  if (kindIs(kind, 4.0) || kindIs(kind, 7.0)) return 0.0;
  if (kindIs(kind, 3.0)){
    // two pale eye glints under the hat brim
    if (ell(q, vec2(-0.2, 0.71), vec2(0.09, 0.012)) < 1.0 || ell(q, vec2(0.2, 0.71), vec2(0.09, 0.012)) < 1.0)
      return 2.0;
    return 0.0;
  }
  if (kindIs(kind, 5.0)) q.y -= 0.02;
  if (kind < 0.5 || kindIs(kind, 5.0) || kindIs(kind, 6.0)){
    float tilt = wind * 0.12;
    float eL = ell(q, vec2(-0.42, 0.79 - tilt * 0.4), vec2(0.30, 0.085));
    float eR = ell(q, vec2(0.44, 0.78 + tilt * 0.4), vec2(0.24 - wind * 0.05, 0.07));
    // angry brow cut when winding up
    float brow = step(0.835 - abs(a) * 0.09 * wind, v) * step(abs(a), 0.8) * step(0.4, wind);
    if ((eL < 1.0 || eR < 1.0) && brow < 0.5) return 1.0;
    float open = 0.02 + 0.08 * wind + 0.07 * lunge;
    float my = 0.66 + 0.012 * sin(a * 30.0 + seed * 9.0);
    float mw = 0.42 + 0.14 * wind;
    if (abs(a) < mw && abs(v - my) < open * (1.0 - pow(abs(a) / (mw + 0.01), 2.0))) return 1.0;
    return 0.0;
  }
  if (kindIs(kind, 1.0)){
    float big = ell(q, vec2(0.24, 0.88), vec2(0.36, 0.05));
    float small_ = ell(q, vec2(-0.42, 0.9), vec2(0.17, 0.024));
    if (big < 0.22 && wind > 0.05) return 2.0; // pupil stares during telegraph
    if (big < 1.0 || small_ < 1.0) return 1.0;
    float zig = 0.83 + 0.009 * sin(a * 48.0);
    if (abs(a + 0.05) < 0.4 && abs(v - zig) < 0.005 + 0.012 * lunge + 0.004 * wind) return 1.0;
    return 0.0;
  }
  float eL = ell(q, vec2(-0.36, 0.64), vec2(0.17, 0.06));
  float eR = ell(q, vec2(0.34, 0.66), vec2(0.13, 0.05));
  float pupil = min(ell(q, vec2(-0.33, 0.635), vec2(0.05, 0.02)), ell(q, vec2(0.36, 0.655), vec2(0.04, 0.017)));
  if (pupil < 1.0) return 0.0;
  if (eL < 1.0 || eR < 1.0) return 2.0;
  float open = 0.01 + 0.07 * max(drain, wind);
  if (abs(a) < 0.2 + 0.1 * drain && abs(v - 0.53) < open * (1.0 - pow(abs(a) / (0.21 + 0.1 * drain), 2.0))) return 2.0;
  return 0.0;
}

void main(){
  float kind = vA.x;
  float seed = vA.y;
  float reveal = vA.z;
  float hit = vB.x;
  float death = vB.y;
  float m = inkMask(vWPos.xz);
  if (m < 0.06) discard;
  bool inkK = kindIs(kind, 2.0) || kindIs(kind, 4.0);
  float paper = inkK ? 0.0 : 1.0;
  bool plate = kindIs(kind, 6.0) && vE.x < 2.5;

  if (uOutline > 0.5){
    if (m < 0.5 || reveal < 0.02 || plate) discard;
    vec3 oc = inkK ? uRamp1 : uRamp0;
    if (vE.y > 0.5) oc = vE.y < 1.5 ? uGold : (vE.y < 2.5 ? uEliteTeal : uEliteRed);
    // margin man: the dash-trail window shows as a white chalk outline
    if (kindIs(kind, 3.0) && vE.z > 0.5 && vE.y < 0.5) oc = uRamp3;
    gl_FragColor = vec4(oc, 1.0);
    return;
  }

  vec3 V = normalize(cameraPosition - vWPos);
  vec3 Nf = normalize(cross(dFdx(vWPos), dFdy(vWPos)));
  if (dot(Nf, V) < 0.0) Nf = -Nf;
  vec3 Ns = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 N = inkK ? Ns : normalize(mix(Ns, Nf, 0.75));
  bool crane = kindIs(kind, 7.0);
  // folded paper is lit from whichever side faces us
  if (crane && dot(N, V) < 0.0) N = -N;

  // Partially revealed: draw only as a pencil sketch (hatching + contour), fading out.
  if (m < 0.5){
    float k = (m - 0.06) / 0.44;
    float rim = 1.0 - abs(dot(Ns, V));
    float hatch = abs(fract((gl_FragCoord.x * 0.7 + gl_FragCoord.y) / 5.5 + en(vWPos.xz * 3.0) * 0.6) - 0.5) * 2.0;
    bool line = hatch < 0.28 * k + 0.05 || rim > 0.86 - 0.2 * k;
    if (!line || eh(gl_FragCoord.xy + floor(uTime * 12.0)) > k * 1.3) discard;
    // alpha = ink class for render's post pass: 0 = pencil on paper
    gl_FragColor = vec4(inkK ? uRamp1 : uRamp0, 0.0);
    return;
  }

  // Misprint plates out of register: see-through halftone in one process colour each.
  if (plate){
    float ang = vE.x * 0.52 + 0.26;
    vec2 g = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * gl_FragCoord.xy / 4.5;
    vec2 f = fract(g) - 0.5;
    if (length(f) > 0.34) discard;
    vec3 pc = vE.x < 0.5 ? uTintC : (vE.x < 1.5 ? uTintM : uTintY);
    gl_FragColor = vec4(pc, 1.0);
    return;
  }

  float key = clamp(dot(N, normalize(uKeyDir)) * 0.6 + 0.4, 0.0, 1.0) * 0.55;
  vec3 L = uCrystalPos - vWPos;
  float d2 = dot(L, L);
  float pl = max(dot(N, normalize(L)), 0.0) * 1.6 / (1.0 + d2 * 0.1);
  float tone = 0.78 * ((inkK ? 0.16 : 0.34) + key + pl);
  tone *= 1.0 - smoothstep(uFogNear, uFogFar, distance(cameraPosition, vWPos));
  if (!gl_FrontFacing && !inkK && !crane) tone *= 0.35; // dark inside the sheet
  // crease lines + fibres
  float cr = abs(en3(vLocal * vec3(7.0, 5.0, 7.0) + seed * 21.0) - 0.5);
  float crease = 1.0 - smoothstep(0.0, 0.035, cr);
  tone -= crease * 0.16 * paper;
  tone += (en(vWPos.xy * 9.0 + vWPos.z * 5.0) - 0.5) * 0.08;
  // damage tears: ink cracks spread as hp drops
  float tearAmt = 1.0 - vHp;
  float tearN = abs(en3(vLocal * 4.0 + seed * 5.0) - 0.5);
  bool tear = tearAmt > 0.01 && tearN < 0.03 * tearAmt && !inkK;

  vec3 col;
  if (kindIs(kind, 4.0)){
    // Redactor: flat censor-bar black; scrolling redaction hatch while shielded, paper cracks
    // spreading with exposure (aux0) and wide open once the shield is down.
    col = uRamp0;
    float sh = vE.w;
    float scan = fract((vWPos.y * 9.0) - uTime * 0.7);
    if (sh > 0.5 && scan < 0.06) col = uRamp1;
    float cr = abs(en3(vLocal * vec3(3.5, 6.0, 3.5) + seed * 7.0) - 0.5);
    float open = sh > 0.5 ? vE.z * 0.05 : 0.07;
    if (cr < open) col = uRamp3;
    if (death > 0.35 && en(vWPos.xz * 6.0) < (death - 0.35) * 1.7) discard;
  } else if (inkK){
    // Blot: inverse palette — ink body, wet highlights in paper tones.
    vec3 R = reflect(-V, N);
    float spec = pow(max(dot(R, normalize(L)), 0.0), 18.0) * 1.4 + pow(max(dot(R, normalize(uKeyDir)), 0.0), 24.0) * 0.7;
    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col = uRamp0;
    if (fres > 0.55) col = uRamp1;
    if (spec > 0.5) col = uRamp2;
    if (spec > 0.9) col = uRamp3;
    if (death > 0.35 && en(vWPos.xz * 6.0) < (death - 0.35) * 1.7) discard;
  } else {
    col = uRamp0;
    if (tone > uShadow) col = uRamp1;
    if (tone > uShadow + 0.18) col = uRamp2;
    if (tone > uShadow + 0.42) col = uRamp3;
    if (tear) col = uRamp0;
    if (kindIs(kind, 3.0)){
      // pencil noir: graphite body, hatched light side
      float hatch = abs(fract((gl_FragCoord.x - gl_FragCoord.y) / 4.0 + en(vWPos.xz * 2.0) * 0.4) - 0.5);
      col = uRamp0;
      if (tone > uShadow + 0.2 && hatch < 0.12) col = uRamp1;
      if (tone > uShadow + 0.45) col = uRamp1;
    }
  }

  float a = (fract(vGrid.x + 0.5) - 0.5) * TAU;
  float f = (death > 0.0 || !gl_FrontFacing) ? 0.0 : face(kind, a, vGrid.y, vB.z, vC.x, vC.y, seed);
  if (f > 1.5) col = uRamp3;
  else if (f > 0.5) col = inkK ? uRamp3 : uRamp0;

  // Hit flash: blank-page white with an ink core, readable without colour.
  if (hit > 0.0){
    float fl = step(0.35, hit);
    col = mix(col, inkK ? uRamp2 : uRamp3, fl);
  }
  // Death shard edges get an ink rim
  if (death > 0.0 && !inkK){
    float edge = max(abs(fract(vGrid.x * 7.0) - 0.5), abs(fract(vGrid.y * 5.0) - 0.5));
    if (edge > 0.43) col = uRamp0;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;
