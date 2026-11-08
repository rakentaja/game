/**
 * Local stand-ins for other workstreams' modules, used ONLY by the player dev harness:
 * a POC-faithful ink material with a reveal mask, a reveal system, a box-arena collision world,
 * a target registry and paper-ghost practice dummies, plus the POC composite post pass.
 * The real implementations live in render/, world/, systems/targets.ts and entities/enemies/.
 */
import * as THREE from 'three';
import type { EventBus, GameEvents } from '../core/events';
import type { CollisionAPI, Damageable, InkMaterialOptions, RevealAPI, TargetRegistry } from '../core/types';
import { PAL, type RampName } from '../data/palette';

const C = (h: string) => new THREE.Color(h);
const RAMPS: Record<RampName, THREE.Color[]> = {
  red: PAL.red.map(C),
  teal: PAL.teal.map(C),
  staff: PAL.staff.map(C),
  ghost: PAL.ghost.map(C),
};

export const MAX_SOURCES = 24;

// ───────────────────────────── shared uniforms ─────────────────────────────

export const shared = {
  uKeyDir: { value: new THREE.Vector3(-0.5, 0.75, 0.45).normalize() },
  uCrystalPos: { value: new THREE.Vector3(0, 2, 0) },
  uShadow: { value: 0.3 },
  uTime: { value: 0 },
  uFogNear: { value: 10.0 },
  uFogFar: { value: 26.0 },
};

// ───────────────────────────── reveal ─────────────────────────────

export class StubReveal implements RevealAPI {
  readonly center = new THREE.Vector3();
  radius = 3;
  targetRadius = 3;
  blankPage = 0;
  private src = new Float32Array(MAX_SOURCES * 4); // x, z, r, life01
  private life = new Float32Array(MAX_SOURCES);
  private maxLife = new Float32Array(MAX_SOURCES);
  private next = 0;
  readonly uniforms: Record<string, THREE.IUniform> = {
    uRevealCenter: { value: this.center },
    uRevealRadius: { value: 3 },
    uRevealEdge: { value: 0.9 },
    uSources: { value: Array.from({ length: MAX_SOURCES }, () => new THREE.Vector4(0, 0, 0, 0)) },
  };

  addSource(x: number, z: number, radius: number, life: number): number {
    const i = this.next++ % MAX_SOURCES;
    this.src[i * 4] = x;
    this.src[i * 4 + 1] = z;
    this.src[i * 4 + 2] = radius;
    this.life[i] = life;
    this.maxLife[i] = life;
    return i;
  }

  removeSource(h: number): void {
    this.life[h] = 0;
  }

  eraseStrip(): void {}

  update(dt: number): void {
    // critically damped-ish ease toward target (fast grow, slower shrink)
    const k = this.targetRadius > this.radius ? 9 : 5;
    this.radius += (this.targetRadius - this.radius) * (1 - Math.exp(-k * dt));
    this.uniforms.uRevealRadius!.value = this.radius;
    const arr = this.uniforms.uSources!.value as THREE.Vector4[];
    for (let i = 0; i < MAX_SOURCES; i++) {
      if (this.life[i]! > 0) this.life[i] = Math.max(0, this.life[i]! - dt);
      const f = this.maxLife[i]! > 0 ? this.life[i]! / this.maxLife[i]! : 0;
      // grow in quickly, recede over the last 40% of life
      const grow = Math.min(1, (1 - f) * 8);
      const fade = Math.min(1, f / 0.4);
      arr[i]!.set(this.src[i * 4]!, this.src[i * 4 + 1]!, this.src[i * 4 + 2]! * grow * fade, 0);
    }
  }

  revealAt(x: number, z: number): number {
    let best = 0;
    const d = Math.hypot(x - this.center.x, z - this.center.z);
    best = Math.max(best, Math.min(1, Math.max(0, (this.radius - d) / 0.9 + 0.5)));
    const arr = this.uniforms.uSources!.value as THREE.Vector4[];
    for (const s of arr) {
      if (s.z <= 0) continue;
      const ds = Math.hypot(x - s.x, z - s.y);
      best = Math.max(best, Math.min(1, Math.max(0, (s.z - ds) / 0.9 + 0.5)));
    }
    return best;
  }

  isRevealed(x: number, z: number): boolean {
    return this.revealAt(x, z) > 0.5;
  }

  reset(): void {
    this.life.fill(0);
  }
}

// ───────────────────────────── material ─────────────────────────────

const toonVert = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>
  varying vec3 vWN; varying vec3 vWPos; varying vec2 vUv; varying float vViewZ;
  uniform float crumple; uniform float uTime;
  void main(){
    vUv = uv;
    #include <beginnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    if (crumple > 0.0) {
      float t = floor(uTime * 12.0);
      transformed += objectNormal * crumple * (sin(position.y*23.0 + t*1.7) * cos(position.x*19.0 - t) * 0.5);
    }
    #include <project_vertex>
    vWN = normalize(mat3(modelMatrix) * objectNormal);
    vWPos = (modelMatrix * vec4(transformed,1.0)).xyz;
    vViewZ = -mvPosition.z;
  }`;

const MASK_GLSL = /* glsl */ `
  uniform vec3 uRevealCenter; uniform float uRevealRadius, uRevealEdge; uniform vec4 uSources[${MAX_SOURCES}];
  float revealMask(vec3 wp){
    float n = (fbm(wp.xz * 3.0) - 0.5) * 0.6;
    float d = length(wp.xz - uRevealCenter.xz) + n;
    float m = smoothstep(uRevealRadius, uRevealRadius - uRevealEdge, d);
    for (int i = 0; i < ${MAX_SOURCES}; i++){
      vec4 s = uSources[i];
      if (s.z <= 0.0) continue;
      float ds = length(wp.xz - s.xy) + n;
      m = max(m, smoothstep(s.z, s.z - uRevealEdge, ds));
    }
    return m;
  }`;

const toonFrag = /* glsl */ `
  uniform sampler2D map; uniform float useMap; uniform float albedoMix; uniform float procGround;
  uniform vec3 ramp0, ramp1, ramp2, ramp3, paper, ink, wet;
  uniform vec3 uKeyDir, uCrystalPos; uniform float uShadow, uTime, uFogNear, uFogFar, keyAmt, glowAmt, useReveal, flash;
  varying vec3 vWN; varying vec3 vWPos; varying vec2 vUv; varying float vViewZ;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
  float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
  float fbm(vec2 p){ float a=.5,s=0.; for(int i=0;i<4;i++){ s+=a*noise(p); p*=2.03; a*=.5;} return s; }
  ${MASK_GLSL}
  void main(){
    vec3 N = normalize(vWN) * (gl_FrontFacing ? 1.0 : -1.0);
    float alb = 0.75;
    if (useMap > 0.5) { vec3 t = texture2D(map, vUv).rgb; alb = mix(0.75, dot(t, vec3(.3,.59,.11)) * 1.25, albedoMix); }
    if (procGround > 0.5) {
      float g = fbm(vWPos.xz * vec2(6.0, 2.2));
      float streak = smoothstep(.55,.75, noise(vWPos.xz*vec2(40.,9.)));
      alb = 0.85 - smoothstep(.45,.75,g)*0.55 - streak*0.25;
    }
    float key = clamp(dot(N, normalize(uKeyDir))*0.6+0.4, 0., 1.) * keyAmt;
    vec3 L = uCrystalPos - vWPos; float d2 = dot(L,L);
    float pl = max(dot(N, normalize(L)), 0.) * glowAmt / (1.0 + d2*0.35);
    float tone = alb * (0.18 + max(key, 0.) + pl);
    tone *= 1.0 - smoothstep(uFogNear, uFogFar, vViewZ);
    tone += (fbm(vWPos.xy*5.0 + vWPos.z*3.0) - 0.5) * 0.07;
    vec3 col = ramp0;
    if (tone > uShadow)        col = ramp1;
    if (tone > uShadow + 0.20) col = ramp2;
    if (tone > uShadow + 0.48) col = ramp3;
    if (flash > 0.0) col = mix(col, paper, step(0.5, flash));
    if (useReveal > 0.5) {
      float m = revealMask(vWPos);
      // unprinted page: paper with pencil hatching on shadowed faces
      float hatchA = abs(fract((gl_FragCoord.x + gl_FragCoord.y) / 7.0) - 0.5);
      float shade = 1.0 - clamp(dot(N, normalize(uKeyDir))*0.5+0.5, 0., 1.);
      float pencil = step(hatchA, 0.07) * step(0.45, shade + noise(vWPos.xz*4.0)*0.3);
      vec3 sketch = mix(paper, ramp1 * 0.5 + paper * 0.5, pencil * 0.55);
      vec3 inked = col;
      col = mix(sketch, inked, step(0.5, m));
      // wet ink rim just inside the edge
      float rim = step(0.5, m) * (1.0 - step(0.62, m));
      col = mix(col, wet, rim);
      float rim2 = step(0.38, m) * (1.0 - step(0.5, m));
      col = mix(col, ink, rim2);
    }
    gl_FragColor = vec4(col, 1.0);
  }`;

export function createInkMaterial(opts: InkMaterialOptions, reveal: StubReveal): THREE.ShaderMaterial {
  const ramp = RAMPS[opts.ramp];
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      ...reveal.uniforms,
      map: { value: opts.map ?? null },
      useMap: { value: opts.map ? 1 : 0 },
      albedoMix: { value: opts.albedoMix ?? 0.6 },
      procGround: { value: opts.ground ? 1 : 0 },
      ramp0: { value: ramp[0] },
      ramp1: { value: ramp[1] },
      ramp2: { value: ramp[2] },
      ramp3: { value: ramp[3] },
      paper: { value: C(PAL.paper) },
      ink: { value: C(PAL.ink) },
      wet: { value: C(PAL.glowEdge) },
      keyAmt: { value: opts.keyAmt ?? 0.55 },
      glowAmt: { value: opts.glowAmt ?? 1.3 },
      useReveal: { value: opts.reveal === false ? 0 : 1 },
      crumple: { value: opts.crumple ?? 0 },
      flash: { value: 0 },
    },
    vertexShader: toonVert,
    fragmentShader: toonFrag,
    side: opts.side ?? THREE.DoubleSide,
  });
}

// ───────────────────────────── post (POC composite) ─────────────────────────────

export class StubPost {
  private rtColor: THREE.WebGLRenderTarget;
  private rtNormal: THREE.WebGLRenderTarget;
  private normalMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly mat: THREE.ShaderMaterial;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
  ) {
    const s = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.rtColor = new THREE.WebGLRenderTarget(s.x, s.y, { samples: 2 });
    this.rtNormal = new THREE.WebGLRenderTarget(s.x, s.y, { depthTexture: new THREE.DepthTexture(s.x, s.y) });
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: this.rtColor.texture },
        tNormal: { value: this.rtNormal.texture },
        tDepth: { value: this.rtNormal.depthTexture },
        res: { value: new THREE.Vector2(s.x, s.y) },
        dpr: { value: renderer.getPixelRatio() },
        near: { value: camera.near },
        far: { value: camera.far },
        uTime: shared.uTime,
        boilT: { value: 0 },
        period: { value: 3.4 },
        angle: { value: 62 },
        screenAmt: { value: 0.5 },
        edgeW: { value: 1.3 },
        grain: { value: 0.5 },
        ink: { value: C(PAL.ink) },
        paper: { value: C(PAL.paper) },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor, tNormal, tDepth; uniform vec2 res; uniform float dpr, near, far, uTime, boilT;
        uniform float period, angle, screenAmt, edgeW, grain; uniform vec3 ink, paper; varying vec2 vUv;
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
          float w = edgeW * (0.75 + 0.6*noise(frag/(60.*dpr) + boilT));
          col = mix(col, ink, edgeAt(vUv + jit, w));
          float lum = dot(col, vec3(.3,.59,.11)); float a = radians(angle); vec2 dir = vec2(cos(a), sin(a));
          float wob = (noise(frag/(90.*dpr)) - 0.5) * 1.2 + (noise(frag/(9.*dpr))-.5)*0.25;
          float f1 = abs(fract(dot(frag/dpr, dir)/period + wob) - 0.5) * 2.0;
          float thick = mix(0.22, 0.75, 1.0 - smoothstep(0.03, 0.55, lum));
          float line1 = 1.0 - smoothstep(thick - 0.18, thick + 0.18, f1);
          vec2 dir2 = vec2(-dir.y, dir.x);
          float f2 = abs(fract(dot(frag/dpr, dir2)/(period*1.9) + wob*0.5) - 0.5) * 2.0;
          float line2 = 1.0 - smoothstep(0.15, 0.35, f2);
          vec3 dark = col * 0.58; vec3 lite = min(col * 1.18 + 0.02, 1.0);
          col = mix(col, lite, (1.0-line1) * 0.35 * screenAmt);
          col = mix(col, dark, line1 * screenAmt);
          col = mix(col, dark, line2 * 0.25 * screenAmt);
          float g = hash(floor(frag/(1.5*dpr)) + floor(uTime*12.0)) - 0.5;
          float blot = noise(frag/(220.*dpr)) - 0.5;
          col = mix(col, col * paper * 1.06, 0.6);
          col = max(col, vec3(0.075, 0.055, 0.05));
          col += (g * 0.07 + blot * 0.06) * grain;
          vec2 q = vUv - 0.5; col *= 1.0 - dot(q, q) * 0.9;
          gl_FragColor = vec4(col, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat));
  }

  resize(): void {
    const s = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.rtColor.setSize(s.x, s.y);
    this.rtNormal.setSize(s.x, s.y);
    (this.mat.uniforms.res!.value as THREE.Vector2).set(s.x, s.y);
  }

  render(): void {
    const r = this.renderer;
    const cam = this.camera;
    this.mat.uniforms.boilT!.value = Math.floor(shared.uTime.value * 12) * 0.37;
    cam.layers.enableAll();
    r.setClearColor(PAL.void, 1);
    r.setRenderTarget(this.rtColor);
    r.clear();
    r.render(this.scene, cam);
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
  }
}

// ───────────────────────────── collision ─────────────────────────────

export interface Box {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export class BoxWorld implements CollisionAPI {
  constructor(
    readonly boxes: Box[],
    readonly circles: [number, number, number][],
    readonly halfSize: number,
  ) {}

  groundHeight(): number {
    return 0;
  }

  walkable(x: number, z: number): boolean {
    return Math.abs(x) < this.halfSize && Math.abs(z) < this.halfSize;
  }

  resolveCircle(x: number, z: number, r: number, out: THREE.Vector2): boolean {
    let moved = false;
    let px = x;
    let pz = z;
    for (let it = 0; it < 2; it++) {
      for (const b of this.boxes) {
        const cx = Math.max(b.minX, Math.min(px, b.maxX));
        const cz = Math.max(b.minZ, Math.min(pz, b.maxZ));
        const dx = px - cx;
        const dz = pz - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        moved = true;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          px = cx + (dx / d) * r;
          pz = cz + (dz / d) * r;
        } else {
          // centre inside: push out the shortest axis
          const l = px - b.minX;
          const rr = b.maxX - px;
          const t = pz - b.minZ;
          const bt = b.maxZ - pz;
          const m = Math.min(l, rr, t, bt);
          if (m === l) px = b.minX - r;
          else if (m === rr) px = b.maxX + r;
          else if (m === t) pz = b.minZ - r;
          else pz = b.maxZ + r;
        }
      }
      for (const [cx, cz, cr] of this.circles) {
        const dx = px - cx;
        const dz = pz - cz;
        const rr = cr + r;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        px = cx + (dx / d) * rr;
        pz = cz + (dz / d) * rr;
        moved = true;
      }
    }
    out.set(px, pz);
    return moved;
  }

  segmentClear(ax: number, az: number, bx: number, bz: number): boolean {
    for (let i = 1; i < 12; i++) {
      const t = i / 12;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      for (const b of this.boxes) if (x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ) return false;
    }
    return true;
  }
}

// ───────────────────────────── targets + dummies ─────────────────────────────

export class StubTargets implements TargetRegistry {
  private list: Damageable[] = [];
  add(t: Damageable): void {
    this.list.push(t);
  }
  remove(t: Damageable): void {
    const i = this.list.indexOf(t);
    if (i >= 0) this.list.splice(i, 1);
  }
  nearest(p: THREE.Vector3, maxRange: number): Damageable | null {
    let best: Damageable | null = null;
    let bd = maxRange * maxRange;
    for (const t of this.list) {
      if (!t.alive || !t.revealed) continue;
      const dx = t.position.x - p.x;
      const dz = t.position.z - p.z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    return best;
  }
  forEach(fn: (t: Damageable) => void): void {
    for (const t of this.list) fn(t);
  }
}

function ghostGeometry(): THREE.BufferGeometry {
  // a crumpled paper sheet draped over nothing: lathe with a ragged hem
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const y = t * 1.5;
    const r = t < 0.85 ? 0.42 + Math.sin(t * 3.1) * 0.08 - t * 0.12 : (1 - t) * 2.2 * 0.3;
    pts.push(new THREE.Vector2(Math.max(0.01, r), y));
  }
  const g = new THREE.LatheGeometry(pts, 14);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < 0.05) p.setY(i, y + Math.sin(i * 2.7) * 0.08 + 0.04);
    p.setX(i, p.getX(i) + Math.sin(i * 12.9898) * 0.025);
    p.setZ(i, p.getZ(i) + Math.cos(i * 78.233) * 0.025);
  }
  g.computeVertexNormals();
  return g;
}

let nextId = 1;

export class Dummy implements Damageable {
  readonly id = nextId++;
  readonly position = new THREE.Vector3();
  readonly radius = 0.45;
  alive = true;
  revealed = false;
  hp = 3;
  aggressive = false;
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private flash = 0;
  private wob = Math.random() * 6;
  private deadT = 0;
  private kvx = 0;
  private kvz = 0;
  private home = new THREE.Vector2();
  private hitCooldown = 0;

  constructor(
    x: number,
    z: number,
    reveal: StubReveal,
    private events: EventBus<GameEvents>,
    private reveals: StubReveal,
  ) {
    this.mat = createInkMaterial(
      { ramp: 'ghost', reveal: true, crumple: 0.03, keyAmt: 0.9, glowAmt: 1.6 },
      reveal,
    );
    this.mesh = new THREE.Mesh(ghostGeometry(), this.mat);
    this.position.set(x, 0, z);
    this.home.set(x, z);
    this.mesh.position.copy(this.position);
    this.events.emit('enemy:spawn', { id: this.id, kind: 'smudge' });
  }

  hit(amount: number, from: THREE.Vector3): void {
    if (!this.alive) return;
    this.hp -= amount;
    this.flash = 0.12;
    const dx = this.position.x - from.x;
    const dz = this.position.z - from.z;
    const d = Math.hypot(dx, dz) || 1;
    this.kvx = (dx / d) * 5;
    this.kvz = (dz / d) * 5;
    if (this.hp <= 0) {
      this.alive = false;
      this.deadT = 0;
      this.events.emit('enemy:died', {
        id: this.id,
        kind: 'smudge',
        position: [this.position.x, this.position.y, this.position.z],
      });
    }
  }

  step(
    dt: number,
    player: { position: THREE.Vector3; damage(a: number, s: 'smudge', f?: THREE.Vector3): void },
  ): void {
    this.wob += dt;
    this.revealed = this.alive && this.reveals.isRevealed(this.position.x, this.position.z);
    if (this.flash > 0) this.flash -= dt;
    if (this.hitCooldown > 0) this.hitCooldown -= dt;
    if (!this.alive) {
      this.deadT += dt;
      const s = Math.max(0, 1 - this.deadT * 4);
      this.mesh.scale.set(1 + (1 - s) * 0.6, s, 1 + (1 - s) * 0.6);
      if (this.deadT > 3.5) {
        this.alive = true;
        this.hp = 3;
        const a = Math.random() * Math.PI * 2;
        this.position.set(this.home.x + Math.cos(a) * 2, 0, this.home.y + Math.sin(a) * 2);
        this.mesh.scale.set(1, 1, 1);
      }
      return;
    }
    // drift (or stalk the player when aggressive and revealed)
    let vx = Math.sin(this.wob * 0.7 + this.id) * 0.4;
    let vz = Math.cos(this.wob * 0.5 + this.id * 2) * 0.4;
    const dx = player.position.x - this.position.x;
    const dz = player.position.z - this.position.z;
    const d = Math.hypot(dx, dz);
    if (this.aggressive && d < 9) {
      vx = (dx / d) * 2.2;
      vz = (dz / d) * 2.2;
    }
    this.position.x += (vx + this.kvx) * dt;
    this.position.z += (vz + this.kvz) * dt;
    this.kvx *= Math.exp(-6 * dt);
    this.kvz *= Math.exp(-6 * dt);
    if (this.aggressive && d < 0.85 && this.hitCooldown <= 0) {
      this.hitCooldown = 0.6;
      player.damage(1, 'smudge', this.position);
    }
  }

  render(): void {
    const bob = Math.sin(this.wob * 3) * 0.08;
    this.mesh.position.set(this.position.x, 0.05 + bob, this.position.z);
    this.mesh.rotation.y = Math.sin(this.wob) * 0.4;
    this.mat.uniforms.flash!.value = this.flash > 0 ? 1 : 0;
    const k = this.flash > 0 ? 1 + this.flash * 2 : 1;
    if (this.alive) this.mesh.scale.set(k, 2 - k, k);
  }
}

// ───────────────────────────── POC forest (procedural trunks) ─────────────────────────────

export function trunk(
  base: THREE.Vector3,
  height: number,
  r0: number,
  twist: number,
  mat: THREE.Material,
  rnd: () => number,
): THREE.Mesh {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    pts.push(
      new THREE.Vector3(
        base.x + Math.sin(t * 3 + twist) * 0.35 * t + (rnd() - 0.5) * 0.12,
        base.y + t * height,
        base.z + Math.cos(t * 2.3 + twist) * 0.3 * t + (rnd() - 0.5) * 0.12,
      ),
    );
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const seg = 32;
  const rad = 9;
  const g = new THREE.TubeGeometry(curve, seg, 1, rad, false);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const ring = Math.floor(i / (rad + 1));
    const t = ring / seg;
    const c = curve.getPointAt(t);
    const r = r0 * (1.0 - 0.65 * t) * (1.0 + 1.6 * (Math.max(0, 0.12 - t) / 0.12) ** 2);
    v.fromBufferAttribute(pos, i).sub(c).multiplyScalar(r).add(c);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}
