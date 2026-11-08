import * as THREE from 'three';
import { PAL } from '../data/palette';

/**
 * Level-owned special surfaces (ink pools, glows, mist). They read render's shared uniforms
 * (uTime, uCrystalPos) when given, so they boil and react to the crystal like everything else.
 */
export interface SharedLike {
  uTime: THREE.IUniform<number>;
  uCrystalPos: THREE.IUniform<THREE.Vector3>;
}

export function makeShared(src?: Record<string, THREE.IUniform>): SharedLike {
  return {
    uTime: (src?.uTime as THREE.IUniform<number>) ?? { value: 0 },
    uCrystalPos: (src?.uCrystalPos as THREE.IUniform<THREE.Vector3>) ?? {
      value: new THREE.Vector3(0, -100, 0),
    },
  };
}

const NOISE = /* glsl */ `
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
  float fbm(vec2 p){ float a=.5,s=0.; for(int i=0;i<4;i++){ s+=a*noise(p); p*=2.03; a*=.5;} return s; }
  float bayer(vec2 fc){ vec2 p = mod(floor(fc), 4.0);
    float b = mod(p.x + p.y * 2.0, 4.0) * 4.0 + mod(p.x * 2.0 + p.y, 4.0);
    return (b + 0.5) / 16.0; }
`;

const VERT = /* glsl */ `
  varying vec3 vW;
  void main(){
    vec4 w = modelMatrix * vec4(position, 1.0);
    #ifdef USE_INSTANCING
      w = modelMatrix * instanceMatrix * vec4(position, 1.0);
    #endif
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

/** Still or flowing ink: near-black with drifting teal sheen streaks and crystal glints. */
export function createInkSurfaceMaterial(shared: SharedLike, flow = 0): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: shared.uTime,
      uCrystalPos: shared.uCrystalPos,
      uFlow: { value: flow },
      uInk: { value: new THREE.Color(PAL.ink) },
      uSheen: { value: new THREE.Color(PAL.teal[1]) },
      uGlint: { value: new THREE.Color(PAL.glowEdge) },
    },
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      uniform float uTime, uFlow; uniform vec3 uCrystalPos, uInk, uSheen, uGlint;
      varying vec3 vW;
      ${NOISE}
      void main(){
        vec2 p = vW.xz;
        float t = uTime * (0.15 + uFlow * 0.6);
        float n = fbm(p * vec2(0.6, 1.4) + vec2(t * 0.6, -t));
        float streak = smoothstep(0.62, 0.7, n) * (1.0 - smoothstep(0.7, 0.78, n));
        vec3 c = mix(uInk, uSheen, streak * 0.85);
        float d = length(uCrystalPos.xz - p);
        float glint = step(0.93, noise(p * 7.0 + t * 3.0)) * (1.0 - smoothstep(1.0, 5.0, d)) * step(0.01, uFlow);
        c = mix(c, uGlint, glint);
        gl_FragColor = vec4(c, 1.0);
      }`,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

/** Flat emissive glow (lantern cores, well rims): two palette steps, flickering terminator. */
export function createGlowMaterial(shared: SharedLike): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: shared.uTime,
      core: { value: new THREE.Color(PAL.glowCore) },
      edge: { value: new THREE.Color(PAL.glowEdge) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vVP; varying vec3 vW;
      void main(){ vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; vec4 mv = viewMatrix * w; vVP = mv.xyz; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 core, edge; varying vec3 vVP; varying vec3 vW;
      void main(){
        vec3 n = normalize(cross(dFdx(vVP), dFdy(vVP)));
        float facing = abs(dot(n, normalize(-vVP)));
        float flick = 0.06 * sin(uTime * 9.0 + vW.x * 3.0) + 0.04 * sin(uTime * 17.0 + vW.z * 5.0);
        gl_FragColor = vec4(mix(edge, core, step(0.55 + flick, facing)), 1.0);
      }`,
  });
}

/**
 * Low ground mist: posterized fbm wisps, dithered (no blending → no sorting), brightening into
 * crystal-lit salmon near the light and ghost-pale elsewhere.
 */
export function createMistMaterial(shared: SharedLike): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: shared.uTime,
      uCrystalPos: shared.uCrystalPos,
      uPale: { value: new THREE.Color(PAL.teal[3]) },
      uMid: { value: new THREE.Color(PAL.teal[2]) },
      uWarm: { value: new THREE.Color(PAL.smoke) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vW; varying vec2 vUv;
      void main(){
        vUv = uv;
        vec3 c = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
        float sx = length(instanceMatrix[0].xyz);
        float sy = length(instanceMatrix[1].xyz);
        vec3 right = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
        vec3 up = normalize(vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]));
        vec3 w = c + right * position.x * sx + up * position.y * sy;
        vW = w;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uCrystalPos, uPale, uMid, uWarm;
      varying vec3 vW; varying vec2 vUv;
      ${NOISE}
      void main(){
        // a cartoon fog puff: lumpy round silhouette, pale core, darker rim band, dithered
        vec2 q = (vUv - 0.5) * 2.0;
        float ang = atan(q.y, q.x);
        float lump = 0.78 + 0.12 * sin(ang * 5.0 + vW.x * 1.3 + uTime * 0.3) + 0.08 * sin(ang * 9.0 - vW.z);
        float r = length(q) / lump;
        if (r > 1.0) discard;
        float d = length(uCrystalPos - vW);
        float lit = 1.0 - smoothstep(2.5, 9.0, d);
        float core = 1.0 - smoothstep(0.55, 0.8, r);
        float cover = mix(0.16, 0.4, core);
        if (bayer(gl_FragCoord.xy) > cover) discard;
        vec3 c = mix(uMid, uPale, core);
        c = mix(c, uWarm, lit * 0.45 * core);
        gl_FragColor = vec4(c, 1.0);
      }`,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}
