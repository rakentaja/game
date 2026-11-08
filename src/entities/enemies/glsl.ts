/**
 * Shared GLSL for enemy materials. The reveal mask here is a deliberately small stand-in for
 * render's RevealSystem (center + radius + fbm edge); swap to `createInkMaterial({crumple})`
 * once it lands. Keep `inkMask` in sync with `stubRevealAt` on the CPU side.
 */
export const NOISE_GLSL = /* glsl */ `
float eh(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float eh3(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7)))*43758.5453); }
float en(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(eh(i),eh(i+vec2(1,0)),f.x), mix(eh(i+vec2(0,1)),eh(i+vec2(1,1)),f.x), f.y); }
float en3(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  float a=mix(mix(eh3(i),eh3(i+vec3(1,0,0)),f.x), mix(eh3(i+vec3(0,1,0)),eh3(i+vec3(1,1,0)),f.x), f.y);
  float b=mix(mix(eh3(i+vec3(0,0,1)),eh3(i+vec3(1,0,1)),f.x), mix(eh3(i+vec3(0,1,1)),eh3(i+vec3(1,1,1)),f.x), f.y);
  return mix(a,b,f.z); }
float efbm(vec2 p){ float a=.5,s=0.; for(int i=0;i<4;i++){ s+=a*en(p); p*=2.03; a*=.5;} return s; }
`;

export const MASK_GLSL = /* glsl */ `
uniform vec3 uRevealCenter;
uniform float uRevealRadius;
uniform float uRevealEdge;
uniform float uBlankPage;
/** 1 inside the inked circle, 0 on blank paper, with a ragged fbm brush edge. */
float inkMask(vec2 xz){
  float d = distance(xz, uRevealCenter.xz);
  float n = (efbm(xz * 0.9 + vec2(3.1, 7.7)) - 0.5) * uRevealEdge * 1.6;
  float m = 1.0 - smoothstep(uRevealRadius - uRevealEdge * 0.5, uRevealRadius + uRevealEdge * 0.5, d + n);
  return m * (1.0 - uBlankPage);
}
`;
