/**
 * DEV HARNESS ONLY — a compact stand-in for the render workstream: POC toon/ink material with the
 * reveal mask, POC composite post (depth/normal ink edges, line screen, paper), shake.
 * Layer 1 = "no edge pass" (POC smoke convention), drawn in the colour pass only.
 */
import * as THREE from 'three';
import type { InkMaterialOptions, QualityLevel, RenderAPI } from '../../core/types';
import { PAL } from '../../data/palette';
import type { StubReveal } from './reveal';

const hex = (h: string) => new THREE.Color(h);

const NOISE = /* glsl */ `
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
  float fbm(vec2 p){ float a=.5,s=0.; for(int i=0;i<5;i++){ s+=a*noise(p); p*=2.03; a*=.5;} return s; }
`;

const TOON_VERT = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>
  varying vec3 vWN; varying vec3 vWPos; varying float vViewZ;
  void main(){
    #include <beginnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    #include <project_vertex>
    vWN = normalize(mat3(modelMatrix) * objectNormal);
    vWPos = (modelMatrix * vec4(transformed,1.0)).xyz;
    vViewZ = -mvPosition.z;
  }
`;

const TOON_FRAG = /* glsl */ `
  uniform vec3 ramp0, ramp1, ramp2, ramp3, uPaper, uGraphite, uGlowEdge, uEraser;
  uniform vec3 uKeyDir, uCrystalPos; uniform float uShadow, uTime, uFogNear, uFogFar, keyAmt, glowAmt, procGround, useReveal;
  uniform sampler2D uHist; uniform vec4 uHistRect; uniform vec3 uRevealCenter; uniform float uRevealRadius, uBlank, uBoilSeed;
  uniform vec4 uSources[8];
  varying vec3 vWN; varying vec3 vWPos; varying float vViewZ;
  ${NOISE}
  float revealMask(vec3 wp, out float edge, out float erased){
    vec2 huv = (wp.xz - uHistRect.xy) / uHistRect.zw;
    float h = texture2D(uHist, huv).r;   // 1 = printed, 0 = erased
    float hn = h + (fbm(wp.xz*2.5) - 0.5)*0.5;
    float rim = 1.0 - smoothstep(0.0, 0.07, abs(hn - 0.5));   // torn rubbed edge
    h = smoothstep(0.46, 0.54, hn);
    edge = 0.0;
    float inside = step(0.0, huv.x) * step(huv.x, 1.0) * step(0.0, huv.y) * step(huv.y, 1.0);
    float base = mix(1.0, h, inside) * (1.0 - uBlank);
    erased = (1.0 - h) * inside;
    float d = length(wp.xz - uRevealCenter.xz) + (fbm(wp.xz*3.0) - 0.5)*0.6;
    float c = smoothstep(uRevealRadius, uRevealRadius - 0.9, d);
    edge = max(rim * inside * (1.0 - uBlank) * 0.9, (1.0 - smoothstep(0.0, 0.12, abs(d - uRevealRadius + 0.2))));
    for (int i = 0; i < 8; i++) {
      vec4 s = uSources[i];
      if (s.z > 0.0) c = max(c, smoothstep(s.z, s.z - 0.6, length(wp.xz - s.xy) + (fbm(wp.xz*3.0+s.xy) - 0.5)*0.5) * s.w);
    }
    return max(base, c);
  }
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
    float pl = max(dot(N, normalize(L)), 0.) * glowAmt / (1.0 + d2*1.6);
    float tone = alb * (0.18 + max(key, 0.) + pl);
    tone *= 1.0 - smoothstep(uFogNear, uFogFar, vViewZ);
    tone += (fbm(vWPos.xy*5.0 + vWPos.z*3.0) - 0.5) * 0.07;
    vec3 col = ramp0;
    if (tone > uShadow)        col = ramp1;
    if (tone > uShadow + 0.20) col = ramp2;
    if (tone > uShadow + 0.48) col = ramp3;
    if (useReveal > 0.5) {
      float edge, erased;
      float m = revealMask(vWPos, edge, erased);
      // paper sketch: graphite strokes where it would be dark
      float wob = (noise(vWPos.xz*1.3 + uBoilSeed) - 0.5)*0.3;
      float h1 = abs(fract(dot(vWPos.xz, vec2(0.7, 0.7))*3.2 + wob) - 0.5)*2.0;
      float dark = 1.0 - smoothstep(0.1, 0.6, tone);
      float sk = (1.0 - smoothstep(0.1, 0.25, h1)) * step(0.35, dark) * (0.4 + 0.6*noise(vWPos.xz*7.0));
      if (procGround > 0.5) {
        float grass = smoothstep(.6,.8, noise(vWPos.xz*vec2(22.,5.))) * step(0.5, noise(vWPos.xz*1.5));
        sk = max(sk*0.5, grass*0.5);
      }
      vec3 paper = mix(uPaper, uGraphite, sk * 0.6);
      // eraser rub marks inside erased strips
      if (erased > 0.5) {
        float rub = smoothstep(0.55, 0.8, noise(vWPos.xz*vec2(3.0, 9.0)));
        paper = mix(paper, uEraser, rub * 0.22);
      }
      col = mix(paper, col, m);
      col = mix(col, uGlowEdge, edge * step(0.02, m) * step(m, 0.98) * 0.8);
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class StubRender implements RenderAPI {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly shared: Record<string, THREE.IUniform>;
  readonly stats = { drawCalls: 0, triangles: 0, frameMs: 0, pixelRatio: 1 };
  private rtColor: THREE.WebGLRenderTarget;
  private rtNormal: THREE.WebGLRenderTarget;
  private normalMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
  private post: THREE.ShaderMaterial;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  shake = 0;
  shakeT = 0;
  private dpr = 1;

  constructor(
    canvas: HTMLCanvasElement,
    private reveal: StubReveal,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.dpr = Math.min(devicePixelRatio, 2);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.stats.pixelRatio = this.dpr;
    this.camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 90);
    this.shared = {
      uKeyDir: { value: new THREE.Vector3(-0.5, 0.75, 0.45).normalize() },
      uCrystalPos: { value: new THREE.Vector3(0, 2, 0) },
      uShadow: { value: 0.3 },
      uTime: { value: 0 },
      uFogNear: { value: 14 },
      uFogFar: { value: 46 },
      uBoilSeed: { value: 0 },
    };
    const W = Math.floor(innerWidth * this.dpr);
    const H = Math.floor(innerHeight * this.dpr);
    this.rtColor = new THREE.WebGLRenderTarget(W, H, { samples: 4 });
    this.rtNormal = new THREE.WebGLRenderTarget(W, H, { depthTexture: new THREE.DepthTexture(W, H) });
    this.post = this.makePost(W, H);
    this.quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.post));
    addEventListener('resize', () => this.resize());
  }

  createInkMaterial(opts: InkMaterialOptions): THREE.ShaderMaterial {
    const ramp = PAL[opts.ramp].map(hex);
    return new THREE.ShaderMaterial({
      uniforms: {
        ...this.shared,
        ...this.reveal.uniforms,
        ramp0: { value: ramp[0] },
        ramp1: { value: ramp[1] },
        ramp2: { value: ramp[2] },
        ramp3: { value: ramp[3] },
        uPaper: { value: hex(PAL.paper) },
        uGraphite: { value: hex(PAL.staff[2]) },
        uGlowEdge: { value: hex(PAL.glowEdge) },
        uEraser: { value: hex(PAL.red[3]) },
        keyAmt: { value: opts.keyAmt ?? 0.55 },
        glowAmt: { value: opts.glowAmt ?? 1.3 },
        procGround: { value: opts.ground ? 1 : 0 },
        useReveal: { value: opts.reveal === false ? 0 : 1 },
      },
      vertexShader: TOON_VERT,
      fragmentShader: TOON_FRAG,
      side: opts.side ?? THREE.FrontSide,
    });
  }

  addOutline(): () => void {
    return () => {};
  }

  private makePost(W: number, H: number): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: this.rtColor.texture },
        tNormal: { value: this.rtNormal.texture },
        tDepth: { value: this.rtNormal.depthTexture },
        res: { value: new THREE.Vector2(W, H) },
        dpr: { value: this.dpr },
        near: { value: this.camera.near },
        far: { value: this.camera.far },
        uTime: this.shared.uTime!,
        boilT: { value: 0 },
        ink: { value: hex(PAL.ink) },
        paper: { value: hex(PAL.paper) },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor, tNormal, tDepth; uniform vec2 res; uniform float dpr, near, far, uTime, boilT;
        uniform vec3 ink, paper; varying vec2 vUv;
        ${NOISE}
        float linZ(float d){ float z = d*2.-1.; return (2.*near*far)/(far+near - z*(far-near)); }
        float edgeAt(vec2 uv, float w){
          vec2 px = w*dpr/res; vec3 n0 = texture2D(tNormal, uv).xyz; float z0 = linZ(texture2D(tDepth, uv).x);
          float e = 0.;
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
          float g = hash(floor(frag/(1.5*dpr)) + floor(uTime*12.0)) - 0.5;
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
  }

  render(frameDt: number): void {
    const t0 = performance.now();
    this.shared.uTime!.value += frameDt;
    this.post.uniforms.boilT!.value = Math.floor(this.shared.uTime!.value * 6) * 0.37;
    this.shared.uBoilSeed!.value = this.post.uniforms.boilT!.value;
    const r = this.renderer;
    const cam = this.camera;
    // shake (camera-space offset)
    if (this.shakeT > 0) {
      this.shakeT -= frameDt;
      const s = this.shake * Math.max(0, this.shakeT) * 0.6;
      const tt = this.shared.uTime!.value;
      cam.position.x += Math.sin(tt * 61) * s;
      cam.position.y += Math.sin(tt * 47 + 1) * s;
    }
    cam.updateMatrixWorld();
    cam.layers.enableAll();
    r.setClearColor(PAL.void, 1);
    r.setRenderTarget(this.rtColor);
    r.clear();
    r.render(this.scene, cam);
    const calls = r.info.render.calls;
    const tris = r.info.render.triangles;
    cam.layers.set(0);
    this.scene.overrideMaterial = this.normalMat;
    r.setClearColor(0x000000, 1);
    r.setRenderTarget(this.rtNormal);
    r.clear();
    r.render(this.scene, cam);
    this.scene.overrideMaterial = null;
    cam.layers.enableAll();
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);
    this.stats.drawCalls = calls;
    this.stats.triangles = tris;
    this.stats.frameMs = performance.now() - t0;
  }

  beginPanelCut(): void {}
  async pageTurn(swap: () => void | Promise<void>): Promise<void> {
    await swap();
  }
  snapshot(): string {
    return this.renderer.domElement.toDataURL('image/png');
  }
  setQuality(_l: QualityLevel): void {}
  setMisregistration(_on: boolean): void {}
  setReduceMotion(_on: boolean): void {}

  resize(): void {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.fov = innerWidth > innerHeight ? 34 : 42;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight, false);
    const W = Math.floor(innerWidth * this.dpr);
    const H = Math.floor(innerHeight * this.dpr);
    this.rtColor.setSize(W, H);
    this.rtNormal.setSize(W, H);
    (this.post.uniforms.res!.value as THREE.Vector2).set(W, H);
  }
}
