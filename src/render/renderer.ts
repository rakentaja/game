/**
 * InkRenderer — RenderAPI implementation (PLAN §2, M2).
 *
 * Frame: scene → colour RT (RGBA8 + depth texture; alpha = ink class) → [half-res edge pass] →
 * post triangle to screen → [page-curl sheet]. Panel cuts re-shoot the scene with 2–3 cameras into
 * scissored regions of the same RT. No per-frame allocations.
 */
import * as THREE from 'three';
import type { InkMaterialOptions, QualityLevel, RenderAPI } from '../core/types';
import { PAL } from '../data/palette';
import { TUNING } from '../data/tuning';
import { ScreenShake } from '../fx/shake';
import { BoilClock } from './boil';
import { createInkMaterial, createSharedUniforms } from './materials/InkMaterial';
import { attachHulls, createHullMaterial } from './outline/hull';
import { createEdgeMaterial, createPostMaterial, fullscreenTriangle, MAX_PANELS } from './post/inkPost';
import { STAMP_H, STAMP_W, stampTexture } from './post/lettering';
import { PageTurnFx } from './post/pageTurn';
import { PanelCut } from './post/panels';
import { AdaptiveQuality, profileFor, type QualityProfile } from './quality';
import { RevealSystem } from './reveal/RevealSystem';

export type OutlineMode = 'A' | 'B' | 'AB';

export interface InkRendererOptions {
  canvas: HTMLCanvasElement;
  reveal?: RevealSystem;
  /** Treat as a phone (half-res edges in auto, no MSAA). Defaults to (pointer: coarse). */
  mobile?: boolean;
  quality?: QualityLevel;
}

const RAMPS: Record<string, readonly string[]> = {
  red: PAL.red,
  teal: PAL.teal,
  staff: PAL.staff,
  ghost: PAL.ghost,
};

export class InkRenderer implements RenderAPI {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly shared: Record<string, THREE.IUniform>;
  readonly reveal: RevealSystem;
  readonly stats = { drawCalls: 0, triangles: 0, frameMs: 0, pixelRatio: 1 };
  readonly boil = new BoilClock();
  readonly shake = new ScreenShake();
  readonly quality: AdaptiveQuality;
  readonly panel = new PanelCut();
  readonly turn = new PageTurnFx();
  outlineMode: OutlineMode = 'AB';
  /** Post feature switches (debug). `view`: 0 normal, 1 reveal mask, 2 palette violations. */
  readonly post = { edges: true, screen: true, paper: true, view: 0 };
  contextLost = false;
  reduceMotion = false;
  /** Misprint zones: multipliers on misregistration offset and line-screen strength/period. */
  readonly misprint = { misreg: 1, halftone: 1 };
  /** Lightning two-tone flash amount 0..1 (forced 0 under reduce motion). */
  flash = 0;

  private readonly canvas: HTMLCanvasElement;
  private readonly mobile: boolean;
  private level: QualityLevel;
  private profile: QualityProfile;
  private rtColor!: THREE.WebGLRenderTarget;
  private rtEdge: THREE.WebGLRenderTarget | null = null;
  private rtCapture: THREE.WebGLRenderTarget | null = null;
  private postMat!: THREE.ShaderMaterial;
  private readonly postMats = new Map<string, THREE.ShaderMaterial>();
  private readonly edgeMat = createEdgeMaterial();
  private readonly postScene = new THREE.Scene();
  private readonly edgeScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly postMesh: THREE.Mesh;
  private readonly edgeMesh: THREE.Mesh;
  private readonly hullMats = new Map<string, THREE.ShaderMaterial>();
  private readonly hulls = new Set<THREE.Object3D>();
  private readonly printedHulls = new WeakMap<THREE.IUniform, THREE.ShaderMaterial>();
  private readonly hooks: ((dt: number) => void)[] = [];
  private readonly clear = new THREE.Color(PAL.void);
  private readonly panelBg1 = new THREE.Color(PAL.red[2]);
  private readonly panelBg2 = new THREE.Color(PAL.glowEdge);
  private readonly size = new THREE.Vector2();
  private readonly tmpV = new THREE.Vector3();
  private turnResolve: (() => void) | null = null;
  private turnBusy: Promise<void> | null = null;
  private misreg = true;
  private stampWord = '';
  private frameEma = 16.7;

  constructor(opts: InkRendererOptions) {
    THREE.ColorManagement.enabled = false;
    this.canvas = opts.canvas;
    this.mobile =
      opts.mobile ?? (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches === true);
    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.info.autoReset = false;
    this.reveal = opts.reveal ?? new RevealSystem();
    this.shared = createSharedUniforms();
    this.shared.uNoise = this.reveal.uniforms.uNoise!;
    this.shared.uResolution = { value: new THREE.Vector2(1, 1) };
    this.shared.uBoilAmt = { value: 1 };
    this.shared.uFogNear!.value = TUNING.render.fogNear;
    this.shared.uFogFar!.value = TUNING.render.fogFar;
    this.camera = new THREE.PerspectiveCamera(TUNING.camera.fovPortrait, 1, 0.1, 80);
    this.camera.position.set(0, 7.5, 9);
    this.camera.lookAt(0, 0.8, 0);
    this.quality = new AdaptiveQuality(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    this.level = opts.quality ?? 'auto';
    this.profile = profileFor(this.level, this.mobile);
    this.postMesh = new THREE.Mesh(fullscreenTriangle(), undefined);
    this.postMesh.frustumCulled = false;
    this.postScene.add(this.postMesh);
    this.edgeMesh = new THREE.Mesh(fullscreenTriangle(), this.edgeMat);
    this.edgeMesh.frustumCulled = false;
    this.edgeScene.add(this.edgeMesh);
    this.turn.material.uniforms.uNoise!.value = this.shared.uNoise!.value;
    this.selectPost();
    this.allocTargets();
    this.setQuality(this.level);
    this.canvas.addEventListener('webglcontextlost', this.onLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.onRestored, false);
  }

  // ───────────────────────────── materials / outlines ─────────────────────────────

  createInkMaterial(opts: InkMaterialOptions): THREE.ShaderMaterial {
    return createInkMaterial(this.shared, this.reveal.uniforms, RAMPS, opts);
  }

  addOutline(root: THREE.Object3D, widthPx: number = TUNING.render.hullWidthPx): () => void {
    const before = new Set<THREE.Object3D>();
    root.traverse((o) => {
      if (o.userData.inkHullOf) before.add(o);
    });
    const dispose = attachHulls(root, (reveal, printed) => {
      if (printed) {
        let pm = this.printedHulls.get(printed);
        if (!pm) {
          pm = createHullMaterial(this.shared, this.reveal.uniforms, widthPx, reveal, printed);
          this.printedHulls.set(printed, pm);
          this.hullMats.set(`p${this.hullMats.size}`, pm);
        }
        return pm;
      }
      const key = `${widthPx}|${reveal}`;
      let m = this.hullMats.get(key);
      if (!m) {
        m = createHullMaterial(this.shared, this.reveal.uniforms, widthPx, reveal);
        this.hullMats.set(key, m);
      }
      return m;
    });
    const mine: THREE.Object3D[] = [];
    root.traverse((o) => {
      if (o.userData.inkHullOf && !before.has(o)) {
        mine.push(o);
        this.hulls.add(o);
        o.visible = this.outlineMode !== 'B';
      }
    });
    return () => {
      for (const h of mine) this.hulls.delete(h);
      dispose();
    };
  }

  setOutlineMode(mode: OutlineMode): void {
    this.outlineMode = mode;
    for (const h of this.hulls) h.visible = mode !== 'B';
  }

  /** Per-frame callback on real time (FX). Returns an unsubscribe. */
  onFrame(fn: (dt: number) => void): () => void {
    this.hooks.push(fn);
    return () => {
      const i = this.hooks.indexOf(fn);
      if (i >= 0) this.hooks.splice(i, 1);
    };
  }

  // ───────────────────────────── targets / quality ─────────────────────────────

  private selectPost(): void {
    const half = this.profile.halfResEdges;
    const hq = !this.mobile && this.level !== 'low';
    const key = `${half}|${hq}`;
    let m = this.postMats.get(key);
    if (!m) {
      m = createPostMaterial(half, hq);
      m.uniforms.uNoise!.value = this.shared.uNoise!.value;
      this.postMats.set(key, m);
    }
    this.postMat = m;
    this.postMesh.material = m;
  }

  private allocTargets(): void {
    this.rtColor?.dispose();
    this.rtColor?.depthTexture?.dispose();
    this.rtEdge?.dispose();
    const { w, h } = this.bufferSize();
    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.FloatType;
    this.rtColor = new THREE.WebGLRenderTarget(w, h, {
      samples: this.profile.msaa,
      depthTexture: depth,
      depthBuffer: true,
      type: THREE.UnsignedByteType,
      magFilter: THREE.LinearFilter,
      minFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    this.rtColor.texture.colorSpace = THREE.NoColorSpace;
    this.rtEdge = this.profile.halfResEdges
      ? new THREE.WebGLRenderTarget(Math.max(1, w >> 1), Math.max(1, h >> 1), {
          depthBuffer: false,
          type: THREE.UnsignedByteType,
          format: THREE.RGFormat,
          generateMipmaps: false,
        })
      : null;
    if (this.rtCapture) this.rtCapture.setSize(w, h);
  }

  private bufferSize(): { w: number; h: number } {
    const cw = this.canvas.clientWidth || (typeof innerWidth === 'number' ? innerWidth : 1);
    const ch = this.canvas.clientHeight || (typeof innerHeight === 'number' ? innerHeight : 1);
    const pr = this.quality.pixelRatio;
    return { w: Math.max(1, Math.floor(cw * pr)), h: Math.max(1, Math.floor(ch * pr)) };
  }

  setQuality(level: QualityLevel): void {
    this.level = level;
    const prev = this.profile;
    this.profile = profileFor(level, this.mobile);
    this.quality.enabled = level === 'auto';
    if (level === 'low') this.quality.pixelRatio = TUNING.quality.minPixelRatio;
    else if (level === 'high') this.quality.pixelRatio = this.quality.maxRatio;
    this.reveal.historyEnabled = this.profile.revealHistory;
    this.selectPost();
    if (prev.msaa !== this.profile.msaa || prev.halfResEdges !== this.profile.halfResEdges)
      this.allocTargets();
    this.resize();
  }

  get qualityProfile(): Readonly<QualityProfile> {
    return this.profile;
  }

  setMisregistration(on: boolean): void {
    this.misreg = on;
  }

  setReduceMotion(on: boolean): void {
    this.reduceMotion = on;
    this.boil.enabled = !on;
    this.shake.enabled = !on;
    this.shared.uBoilAmt!.value = on ? 0 : 1;
    if (on) {
      this.boil.seed = 0;
      this.shared.uBoilSeed!.value = 0;
    }
  }

  resize(): void {
    const cw = this.canvas.clientWidth || innerWidth;
    const ch = this.canvas.clientHeight || innerHeight;
    const pr = this.quality.pixelRatio;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(cw, ch, false);
    this.renderer.getDrawingBufferSize(this.size);
    const w = this.size.x;
    const h = this.size.y;
    this.rtColor.setSize(w, h);
    this.rtEdge?.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.rtCapture?.setSize(w, h);
    this.camera.aspect = cw / Math.max(1, ch);
    this.camera.updateProjectionMatrix();
    (this.shared.uResolution!.value as THREE.Vector2).set(w, h);
    this.shared.uDpr!.value = pr;
    this.stats.pixelRatio = pr;
  }

  // ───────────────────────────── frame ─────────────────────────────

  render(frameDt: number): void {
    if (this.contextLost) return;
    const ms = frameDt * 1000;
    this.frameEma += (ms - this.frameEma) * 0.1;
    this.stats.frameMs = this.frameEma;
    if (this.quality.sample(ms)) this.resize();

    if (this.boil.update(frameDt)) this.shared.uBoilSeed!.value = this.boil.seed;
    this.shared.uTime!.value += frameDt;
    this.syncLook();
    for (let i = 0; i < this.hooks.length; i++) this.hooks[i]!(frameDt);
    this.shake.update(frameDt);
    if (this.panel.active) this.panel.update(frameDt, this.camera.aspect);

    this.renderer.info.reset();
    this.shake.apply(this.camera);
    this.drawScene();
    this.shake.restore(this.camera);
    this.drawPost(null);
    if (this.turn.active) this.drawCurl(frameDt);
    this.stats.drawCalls = this.renderer.info.render.calls;
    this.stats.triangles = this.renderer.info.render.triangles;
  }

  private syncLook(): void {
    const R = TUNING.render;
    const s = this.shared;
    s.uShadow!.value = R.shadow;
    s.uRimPx!.value = R.rimPx;
    s.uWetPx!.value = R.wetFrontPx;
    s.uSketchAmt!.value = R.sketch;
    s.uCrystalPos!.value.copy(this.reveal.center);
    const U = this.postMat.uniforms;
    U.uAngle!.value = R.lineScreenAngle;
    const ht = this.misprint.halftone;
    U.uScreenAmt!.value = Math.min(1, R.lineScreenStrength * ht);
    U.uPeriod!.value = R.lineScreenPeriod * (1 + (ht - 1) * 0.6);
    U.uEdgeW!.value = R.edgeWidthPx;
    U.uGrain!.value = R.grain;
    U.uMisreg!.value = this.misreg ? R.misregPx * this.misprint.misreg : 0;
    U.uFlash!.value = this.reduceMotion ? 0 : this.flash;
    U.uVignette!.value = R.vignette;
    U.uUseEdges!.value = this.post.edges && this.outlineMode !== 'A' ? 1 : 0;
    U.uUseScreen!.value = this.post.screen ? 1 : 0;
    U.uUsePaper!.value = this.post.paper ? 1 : 0;
    U.uDebugView!.value = this.post.view;
  }

  private drawScene(): void {
    const r = this.renderer;
    r.setClearColor(this.clear, 1);
    const rt = this.rtColor;
    if (!this.panel.active) {
      r.setRenderTarget(rt);
      r.render(this.scene, this.camera);
      return;
    }
    r.setRenderTarget(rt);
    r.clear();
    const w = rt.width;
    const h = rt.height;
    const autoClear = r.autoClear;
    for (let i = 0; i < this.panel.count; i++) {
      if (!this.panel.shown(i)) continue;
      const p = this.panel.panels[i]!;
      const x = Math.floor(p.rect.x * w);
      const y = Math.floor(p.rect.y * h);
      const pw = Math.ceil(p.rect.z * w);
      const ph = Math.ceil(p.rect.w * h);
      rt.viewport.set(x, y, pw, ph);
      rt.scissor.set(x, y, pw, ph);
      rt.scissorTest = true;
      r.setRenderTarget(rt);
      // close-ups play against a flat printed colour, like a comic splash
      r.setClearColor(i === 0 ? this.clear : i === 1 ? this.panelBg1 : this.panelBg2, 1);
      if (i > 0) this.cullAround(this.panel.focus, TUNING.panelCut.closeUpFar);
      r.render(this.scene, p.camera);
      if (i > 0) this.uncull();
    }
    r.autoClear = autoClear;
    rt.viewport.set(0, 0, w, h);
    rt.scissor.set(0, 0, w, h);
    rt.scissorTest = false;
    r.setRenderTarget(rt);
  }

  /** Hide every mesh whose world bounds miss sphere(focus, radius); undone by `uncull`. */
  private cullAround(focus: THREE.Vector3, radius: number): void {
    this.cullFocus.copy(focus);
    this.cullRadius = radius;
    this.scene.traverseVisible(this.cullVisit);
  }

  private uncull(): void {
    for (let i = 0; i < this.culled.length; i++) this.culled[i]!.visible = true;
    this.culled.length = 0;
  }

  private readonly culled: THREE.Object3D[] = [];
  private readonly cullFocus = new THREE.Vector3();
  private cullRadius = 0;
  private readonly cullSphere = new THREE.Sphere();
  private readonly cullVisit = (o: THREE.Object3D): void => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.SkinnedMesh).isSkinnedMesh || !m.frustumCulled || m.userData.inkHullOf)
      return;
    const im = m as THREE.InstancedMesh;
    if (im.isInstancedMesh) {
      if (!im.boundingSphere) im.computeBoundingSphere();
      this.cullSphere.copy(im.boundingSphere!);
    } else {
      if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
      this.cullSphere.copy(m.geometry.boundingSphere!);
    }
    this.cullSphere.applyMatrix4(m.matrixWorld);
    if (this.cullSphere.center.distanceTo(this.cullFocus) - this.cullSphere.radius > this.cullRadius) {
      m.visible = false;
      this.culled.push(m);
    }
  };

  private drawPost(target: THREE.WebGLRenderTarget | null, resW?: number, resH?: number): void {
    const r = this.renderer;
    const U = this.postMat.uniforms;
    const cam = this.camera;
    if (this.rtEdge) {
      const E = this.edgeMat.uniforms;
      E.tColor!.value = this.rtColor.texture;
      E.tDepth!.value = this.rtColor.depthTexture;
      E.uNear!.value = cam.near;
      E.uFar!.value = cam.far;
      this.writeTan(E.uTan!.value as THREE.Vector2);
      E.uCreaseLo!.value = TUNING.render.creaseAngle;
      (E.uPx!.value as THREE.Vector2).set(
        (TUNING.render.edgeWidthPx * this.quality.pixelRatio) / this.rtColor.width,
        (TUNING.render.edgeWidthPx * this.quality.pixelRatio) / this.rtColor.height,
      );
      r.setRenderTarget(this.rtEdge);
      r.render(this.edgeScene, this.quadCam);
      U.tEdge!.value = this.rtEdge.texture;
    }
    U.tColor!.value = this.rtColor.texture;
    U.tDepth!.value = this.rtColor.depthTexture;
    U.uNear!.value = cam.near;
    U.uFar!.value = cam.far;
    this.writeTan(U.uTan!.value as THREE.Vector2);
    U.uCreaseLo!.value = TUNING.render.creaseAngle;
    const w = resW ?? this.rtColor.width;
    const h = resH ?? this.rtColor.height;
    (U.uRes!.value as THREE.Vector2).set(w, h);
    // letterbox (contain) when the target aspect differs from the frame, e.g. 720×1280 covers
    const srcA = this.rtColor.width / this.rtColor.height;
    const dstA = w / h;
    const crop = U.uCrop!.value as THREE.Vector4;
    if (Math.abs(srcA - dstA) < 1e-3) crop.set(0, 0, 1, 1);
    else if (srcA < dstA) crop.set((1 - dstA / srcA) / 2, 0, dstA / srcA, 1);
    else crop.set(0, (1 - srcA / dstA) / 2, 1, srcA / dstA);
    U.uAspect!.value = srcA;
    U.uDpr!.value = this.quality.pixelRatio * (w / this.rtColor.width);
    U.uTime!.value = this.shared.uTime!.value;
    U.uBoilSeed!.value = this.shared.uBoilSeed!.value;
    this.writePanelUniforms();
    this.writeCurlUniforms();
    r.setRenderTarget(target);
    r.render(this.postScene, this.quadCam);
  }

  private writeTan(v: THREE.Vector2): void {
    const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    v.set(t * this.camera.aspect, t);
  }

  private writePanelUniforms(): void {
    const U = this.postMat.uniforms;
    const pc = this.panel;
    if (!pc.active) {
      U.uPanelCount!.value = 0;
      U.uStampOn!.value = 0;
      U.uSpeedLines!.value = 0;
      return;
    }
    U.uPanelCount!.value = pc.count;
    const A = U.uPanelA!.value as THREE.Vector4[];
    const B = U.uPanelB!.value as THREE.Vector4[];
    const S = U.uPanelShow!.value as number[];
    for (let i = 0; i < MAX_PANELS; i++) {
      const p = pc.panels[i]!;
      A[i]!.set(p.quad[0].x, p.quad[0].y, p.quad[1].x, p.quad[1].y);
      B[i]!.set(p.quad[2].x, p.quad[2].y, p.quad[3].x, p.quad[3].y);
      S[i] = pc.shown(i);
    }
    // focus in panel 1 (uv)
    const p1 = pc.panels[1]!;
    this.tmpV
      .copy(pc.focus)
      .setY(pc.focus.y + 0.9)
      .project(p1.camera);
    (U.uFocusUv!.value as THREE.Vector2).set(
      p1.rect.x + (this.tmpV.x * 0.5 + 0.5) * p1.rect.z,
      p1.rect.y + (this.tmpV.y * 0.5 + 0.5) * p1.rect.w,
    );
    U.uSpeedLines!.value = pc.shown(1);
    // stamp: slams in over panel 0 with overshoot, settles with a slight tilt
    const st = pc.t - 0.04;
    U.uStampOn!.value = st > 0 ? 1 : 0;
    if (st > 0) {
      if (this.stampWord !== pc.word) {
        this.stampWord = pc.word;
        U.tStamp!.value = stampTexture(pc.word);
      }
      const k = Math.min(1, st / 0.12);
      const c1 = 2.2;
      const ease = 1 + (c1 + 1) * (k - 1) ** 3 + c1 * (k - 1) ** 2;
      const scale = 2.3 - 1.3 * ease;
      const aspect = this.camera.aspect;
      const p0 = pc.panels[0]!;
      const halfW = Math.min(0.46 * aspect, 0.42) * scale;
      const cx = aspect <= 1 ? 0.5 : p0.rect.x + p0.rect.z * 0.5;
      const cy = aspect <= 1 ? p0.rect.y + p0.rect.w * 0.62 : 0.66;
      (U.uStamp!.value as THREE.Vector4).set(cx, cy, halfW, (halfW * STAMP_H) / STAMP_W);
      U.uStampRot!.value = 0.13 + (1 - ease) * 0.25 + (this.reduceMotion ? 0 : Math.sin(pc.t * 40) * 0.006);
    }
  }

  private writeCurlUniforms(): void {
    const U = this.postMat.uniforms;
    if (!this.turn.active) {
      U.uCurlOn!.value = 0;
      return;
    }
    const aspect = this.camera.aspect;
    const u = this.turnProgress();
    const pose = this.turn.pose(u, aspect);
    U.uCurlOn!.value = 1;
    (U.uCurlP0!.value as THREE.Vector2).copy(pose.p0);
    (U.uCurlN!.value as THREE.Vector2).copy(pose.n);
    U.uCurlR!.value = pose.r;
  }

  private turnProgress(): number {
    const t = this.turn;
    if (t.hold !== null) return t.hold;
    return t.running ? Math.min(1, t.t / t.duration) : 0;
  }

  private drawCurl(dt: number): void {
    const t = this.turn;
    if (t.running && t.hold === null) t.t += dt;
    const u = this.turnProgress();
    t.apply(u, this.camera.aspect, this.quality.pixelRatio);
    t.material.uniforms.tPage!.value = this.rtCapture!.texture;
    const r = this.renderer;
    const ac = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(null);
    r.clearDepth();
    r.render(t.scene, t.camera);
    r.autoClear = ac;
    if (t.running && t.hold === null && u >= 1) {
      t.active = false;
      t.running = false;
      const res = this.turnResolve;
      this.turnResolve = null;
      res?.();
    }
  }

  // ───────────────────────────── comic moments ─────────────────────────────

  beginPanelCut(word: string, focus: THREE.Vector3, durationS: number): void {
    this.panel.keyDir.copy(this.shared.uKeyDir!.value as THREE.Vector3);
    // budget guard: each close-up costs roughly one more scene's worth of draws / tris
    const P = TUNING.panelCut;
    const d = Math.max(1, this.stats.drawCalls);
    const t = Math.max(1, this.stats.triangles);
    let count = P.panels;
    while (count > 2 && (d * count > P.maxDraws || t * count > P.maxTris)) count--;
    this.panel.begin(word, focus, durationS, this.camera, count);
    this.shake.add(0.35, 0.3);
  }

  async pageTurn(swap: () => void | Promise<void>, durationS: number): Promise<void> {
    while (this.turnBusy) await this.turnBusy;
    const run = async () => {
      const { w, h } = { w: this.rtColor.width, h: this.rtColor.height };
      if (!this.rtCapture) {
        this.rtCapture = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, generateMipmaps: false });
        this.rtCapture.texture.colorSpace = THREE.NoColorSpace;
      }
      // capture the composited old page (scene is still the old one)
      this.drawScene();
      this.drawPost(this.rtCapture);
      const t = this.turn;
      t.active = true;
      t.running = false;
      t.t = 0;
      t.duration = Math.max(0.1, durationS);
      await swap();
      const done = new Promise<void>((res) => {
        this.turnResolve = res;
      });
      t.running = true;
      await done;
    };
    this.turnBusy = run();
    try {
      await this.turnBusy;
    } finally {
      this.turnBusy = null;
    }
  }

  snapshot(width?: number, height?: number): string {
    const w = Math.max(1, Math.floor(width ?? this.rtColor.width));
    const h = Math.max(1, Math.floor(height ?? this.rtColor.height));
    const rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, generateMipmaps: false });
    // mid panel-cut: shoot the settled composition (all panels in, stamp landed), not the slam frame
    const pc = this.panel;
    const savedT = pc.t;
    if (pc.active && pc.t < TUNING.panelCut.snapshotAt) {
      pc.t = Math.min(TUNING.panelCut.snapshotAt, pc.duration * 0.95);
      pc.update(0, this.camera.aspect);
      this.drawScene();
    }
    this.drawPost(rt, w, h);
    if (pc.t !== savedT) {
      pc.t = savedT;
      pc.update(0, this.camera.aspect);
      this.drawScene();
    }
    const px = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    rt.dispose();
    this.renderer.setRenderTarget(null);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    const row = w * 4;
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  // ───────────────────────────── context loss ─────────────────────────────

  private readonly onLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
  };

  private readonly onRestored = (): void => {
    this.contextLost = false;
    this.reveal.markDirty();
    (this.shared.uNoise!.value as THREE.Texture).needsUpdate = true;
    this.allocTargets();
    this.resize();
  };

  /** Debug: simulate a context loss + restore after `ms`. */
  simulateContextLoss(ms = 600): void {
    const ext = this.renderer.getContext().getExtension('WEBGL_lose_context');
    if (!ext) return;
    ext.loseContext();
    setTimeout(() => ext.restoreContext(), ms);
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.rtColor.dispose();
    this.rtEdge?.dispose();
    this.rtCapture?.dispose();
    for (const m of this.postMats.values()) m.dispose();
    for (const m of this.hullMats.values()) m.dispose();
    this.edgeMat.dispose();
    this.renderer.dispose();
  }
}
