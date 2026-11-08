/**
 * DEV-ONLY stand-in for the render workstream (POC shader port + reveal circle + POC composite),
 * so the levels harness looks like the game. Not imported by game code.
 */
import * as THREE from 'three';
import type { InkMaterialOptions } from '../core/types';
import { PAL } from '../data/palette';

THREE.ColorManagement.enabled = false; // palette values are used verbatim (before any Color is built)
const hex = (h: string) => new THREE.Color(h);
const RAMPS: Record<string, THREE.Color[]> = {
  red: PAL.red.map(hex),
  teal: PAL.teal.map(hex),
  staff: PAL.staff.map(hex),
  ghost: PAL.ghost.map(hex),
};

export const MAX_SOURCES = 24;

export function createStubRender(canvas: HTMLCanvasElement) {
  THREE.ColorManagement.enabled = false;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 80);

  const shared: Record<string, THREE.IUniform> = {
    uKeyDir: { value: new THREE.Vector3(-0.5, 0.75, 0.45).normalize() },
    uCrystalPos: { value: new THREE.Vector3(0, 2, 0) },
    uShadow: { value: 0.3 },
    uTime: { value: 0 },
    uFogNear: { value: 9 },
    uFogFar: { value: 24 },
    uRevealCenter: { value: new THREE.Vector3() },
    uRevealRadius: { value: 7 },
    uRevealOn: { value: 1 },
    uSources: { value: Array.from({ length: MAX_SOURCES }, () => new THREE.Vector3(0, 0, 0)) },
    uSourceCount: { value: 0 },
    uPaper: { value: hex(PAL.paper) },
    uLead: { value: hex(PAL.staff[2]) },
    uWet: { value: hex(PAL.glowEdge) },
  };

  const vert = /* glsl */ `
    #include <common>
    varying vec3 vWN; varying vec3 vWPos; varying float vViewZ;
    void main(){
      #include <beginnormal_vertex>
      #include <begin_vertex>
      #include <project_vertex>
      vec4 wp = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        wp = instanceMatrix * wp;
        objectNormal = mat3(instanceMatrix) * objectNormal;
      #endif
      vWPos = (modelMatrix * wp).xyz;
      vWN = normalize(mat3(modelMatrix) * objectNormal);
      vViewZ = -mvPosition.z;
    }`;

  const frag = /* glsl */ `
    uniform float procGround;
    uniform vec3 ramp0, ramp1, ramp2, ramp3;
    uniform vec3 uKeyDir, uCrystalPos; uniform float uShadow, uTime, uFogNear, uFogFar, keyAmt, glowAmt;
    uniform vec3 uRevealCenter; uniform float uRevealRadius, uRevealOn;
    uniform vec3 uSources[${MAX_SOURCES}]; uniform int uSourceCount;
    uniform vec3 uPaper, uLead, uWet; uniform float reveal;
    varying vec3 vWN; varying vec3 vWPos; varying float vViewZ;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
    float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
    float fbm(vec2 p){ float a=.5,s=0.; for(int i=0;i<5;i++){ s+=a*noise(p); p*=2.03; a*=.5;} return s; }
    void main(){
      vec3 N = normalize(vWN) * (gl_FrontFacing ? 1.0 : -1.0);
      float alb = 0.75;
      if (procGround > 0.5) {
        float g = fbm(vWPos.xz * vec2(6.0, 2.2));
        float streak = smoothstep(.55,.75, noise(vWPos.xz*vec2(40.,9.)));
        alb = 0.85 - smoothstep(.45,.75,g)*0.55 - streak*0.25;
      }
      float key = clamp(dot(N, normalize(uKeyDir))*0.6+0.4, 0., 1.) * keyAmt;
      vec3 L = uCrystalPos - vWPos; float d2 = dot(L,L);
      float pl = max(dot(N, normalize(L)) * 0.8 + 0.2, 0.) * glowAmt / (1.0 + d2*0.14);
      float tone = alb * (0.24 + max(key, 0.) + pl);
      tone *= 1.0 - smoothstep(uFogNear, uFogFar, vViewZ);
      tone += (fbm(vWPos.xy*5.0 + vWPos.z*3.0) - 0.5) * 0.07;
      vec3 col = ramp0;
      if (tone > uShadow)        col = ramp1;
      if (tone > uShadow + 0.20) col = ramp2;
      if (tone > uShadow + 0.48) col = ramp3;
      if (reveal > 0.5 && uRevealOn > 0.5) {
        float n = (fbm(vWPos.xz * 3.0) - 0.5) * 0.6 * 2.0;
        float dist = length(vWPos.xz - uRevealCenter.xz) + n;
        float m = smoothstep(uRevealRadius, uRevealRadius - 0.9, dist);
        float edge = smoothstep(uRevealRadius + 0.05, uRevealRadius - 0.25, dist) - m;
        for (int i = 0; i < ${MAX_SOURCES}; i++) {
          if (i >= uSourceCount) break;
          vec3 s = uSources[i];
          float ds = length(vWPos.xz - s.xy) + n * 0.6;
          m = max(m, smoothstep(s.z, s.z - 0.6, ds));
        }
        // paper sketch: cream with graphite hatching that follows tone
        float lum = clamp(tone, 0.0, 1.0);
        vec2 fc = gl_FragCoord.xy;
        float h1 = abs(fract((fc.x + fc.y) / 5.0) - 0.5) * 2.0;
        float h2 = abs(fract((fc.x - fc.y) / 7.0) - 0.5) * 2.0;
        float hatch = step(h1, 0.18) * step(lum, uShadow + 0.25) + step(h2, 0.14) * step(lum, uShadow);
        vec3 sketch = mix(uPaper, uLead, clamp(hatch, 0.0, 1.0) * 0.55);
        col = mix(sketch, col, m);
        col = mix(col, uWet, clamp(edge, 0.0, 1.0) * 0.9);
      }
      gl_FragColor = vec4(col, 1.0);
    }`;

  const createInkMaterial = (o: InkMaterialOptions): THREE.ShaderMaterial => {
    const ramp = RAMPS[o.ramp]!;
    return new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        procGround: { value: o.ground ? 1 : 0 },
        ramp0: { value: ramp[0] },
        ramp1: { value: ramp[1] },
        ramp2: { value: ramp[2] },
        ramp3: { value: ramp[3] },
        keyAmt: { value: o.keyAmt ?? 0.55 },
        glowAmt: { value: o.glowAmt ?? 1.3 },
        reveal: { value: o.reveal === false ? 0 : 1 },
      },
      vertexShader: vert,
      fragmentShader: frag,
      side: o.side ?? THREE.DoubleSide,
    });
  };

  // ── POC composite: ink outlines from normal+depth, line screen, paper ──
  const dpr = renderer.getPixelRatio();
  const W = () => Math.floor(innerWidth * dpr);
  const H = () => Math.floor(innerHeight * dpr);
  const rtColor = new THREE.WebGLRenderTarget(W(), H(), { samples: 4 });
  const rtNormal = new THREE.WebGLRenderTarget(W(), H(), { depthTexture: new THREE.DepthTexture(W(), H()) });
  const normalMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
  const post = new THREE.ShaderMaterial({
    uniforms: {
      tColor: { value: rtColor.texture },
      tNormal: { value: rtNormal.texture },
      tDepth: { value: rtNormal.depthTexture },
      res: { value: new THREE.Vector2(W(), H()) },
      dpr: { value: dpr },
      near: { value: camera.near },
      far: { value: camera.far },
      uTime: shared.uTime!,
      boilT: { value: 0 },
      ink: { value: hex(PAL.ink) },
      paper: { value: hex(PAL.paper) },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
    fragmentShader: /* glsl */ `
      uniform sampler2D tColor, tNormal, tDepth; uniform vec2 res; uniform float dpr, near, far, uTime, boilT;
      uniform vec3 ink, paper; varying vec2 vUv;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
      float linZ(float d){ float z = d*2.-1.; return (2.*near*far)/(far+near - z*(far-near)); }
      float edgeAt(vec2 uv, float w){
        vec2 px = w*dpr/res; vec3 n0 = texture2D(tNormal, uv).xyz; float z0 = linZ(texture2D(tDepth, uv).x); float e = 0.;
        for (int i = 0; i < 4; i++){
          vec2 o = i==0 ? vec2(px.x,0.) : i==1 ? vec2(-px.x,0.) : i==2 ? vec2(0.,px.y) : vec2(0.,-px.y);
          vec3 n = texture2D(tNormal, uv+o).xyz; float z = linZ(texture2D(tDepth, uv+o).x);
          e = max(e, smoothstep(0.18, 0.4, length(n-n0)));
          e = max(e, smoothstep(0.04, 0.09, abs(z-z0)/z0));
        }
        return e;
      }
      void main(){
        vec2 frag = vUv * res;
        vec2 jit = (vec2(noise(frag/(28.*dpr) + boilT*7.1), noise(frag/(28.*dpr) - boilT*3.7)) - 0.5) * 1.6 * dpr / res;
        vec3 col = texture2D(tColor, vUv + jit*0.6).rgb;
        float w = 1.4 * (0.75 + 0.6*noise(frag/(60.*dpr) + boilT));
        col = mix(col, ink, edgeAt(vUv + jit, w));
        float lum = dot(col, vec3(.3,.59,.11));
        float a = radians(62.0); vec2 dir = vec2(cos(a), sin(a));
        float wob = (noise(frag/(90.*dpr)) - 0.5) * 1.2 + (noise(frag/(9.*dpr))-.5)*0.25;
        float f1 = abs(fract(dot(frag/dpr, dir)/3.4 + wob) - 0.5) * 2.0;
        float thick = mix(0.22, 0.75, 1.0 - smoothstep(0.03, 0.55, lum));
        float line1 = 1.0 - smoothstep(thick - 0.18, thick + 0.18, f1);
        vec2 dir2 = vec2(-dir.y, dir.x);
        float f2 = abs(fract(dot(frag/dpr, dir2)/(3.4*1.9) + wob*0.5) - 0.5) * 2.0;
        float line2 = 1.0 - smoothstep(0.15, 0.35, f2);
        vec3 dark = col * 0.58; vec3 lite = min(col * 1.18 + 0.02, 1.0);
        col = mix(col, lite, (1.0-line1) * 0.35 * 0.55);
        col = mix(col, dark, line1 * 0.55);
        col = mix(col, dark, line2 * 0.25 * 0.55);
        float g = hash(floor(frag/ (1.5*dpr)) + floor(uTime*12.0)) - 0.5;
        float blot = noise(frag/(220.*dpr)) - 0.5;
        col = mix(col, col * paper * 1.06, 0.6);
        col = max(col, vec3(0.075, 0.055, 0.05));
        col += (g * 0.07 + blot * 0.06) * 0.5;
        vec2 q = vUv - 0.5; col *= 1.0 - dot(q, q) * 0.9;
        gl_FragColor = vec4(col, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const quadScene = new THREE.Scene();
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), post));

  const stats = { drawCalls: 0, triangles: 0, frameMs: 0, pixelRatio: dpr };

  return {
    renderer,
    scene,
    camera,
    shared,
    createInkMaterial,
    stats,
    resize() {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight, false);
      rtColor.setSize(W(), H());
      rtNormal.setSize(W(), H());
      post.uniforms.res!.value.set(W(), H());
    },
    render(clear: string) {
      post.uniforms.boilT!.value = Math.floor((shared.uTime!.value as number) * 6) * 0.37;
      renderer.info.reset();
      renderer.info.autoReset = false;
      camera.layers.enableAll();
      renderer.setClearColor(clear, 1);
      renderer.setRenderTarget(rtColor);
      renderer.clear();
      renderer.render(scene, camera);
      const colorCalls = renderer.info.render.calls;
      stats.triangles = renderer.info.render.triangles;
      camera.layers.set(0);
      scene.overrideMaterial = normalMat;
      renderer.setClearColor(0x000000, 1);
      renderer.setRenderTarget(rtNormal);
      renderer.clear();
      renderer.render(scene, camera);
      scene.overrideMaterial = null;
      renderer.setRenderTarget(null);
      renderer.render(quadScene, quadCam);
      stats.drawCalls = renderer.info.render.calls;
      (stats as { colorCalls?: number }).colorCalls = colorCalls;
    },
  };
}
