/**
 * THE EDITOR — integration layer. Glues the pure FSM (fsm.ts) to the game: rig animation,
 * weak points as `Damageable`s in the TargetRegistry, reveal erase / Blank Page, events, sfx,
 * spawn requests, music intensity, and the death cinematic.
 *
 * Usage (integrator, boss page):
 *   const editor = install(ctx);          // adds itself to ctx.render.scene + ctx.targets
 *   editor.start();                       // when the player enters the arena (after the door)
 *   loop: editor.step(dt) in the fixed sim step, editor.frame(frameDt) once per rendered frame
 *   ctx.events.on('boss:death', e => e.stage === 'black' && showCover())
 *   ctx.events.on('boss:defeated', ...)
 *   editor.dispose() on leaving the page.
 *
 * Camera: the player camera should blend its look target toward `editor.focus` by
 * `editor.cameraWeight` (0..1) so the 7 m Editor stays framed.
 */
import * as THREE from 'three';
import type { Damageable, GameContext } from '../../core/types';
import { TUNING } from '../../data/tuning';
import {
  type Attack,
  type BossPhase,
  CORE_INDEX,
  EditorFSM,
  type EditorSink,
  type WeakPointState,
  WP_COUNT,
} from './fsm';
import { InkCover, InkParticles, Shape, Telegraphs, WeakPointView } from './fx';
import { createEditorUniforms, type EditorUniforms, PART } from './materials';
import { EditorRig } from './rig';

/** Onomatopoeia keys for `fx:panelCut` — matches the UI's `onomatopoeia.*` i18n set. */
export const EDITOR_WORDS = {
  intro: 'roar',
  phase1: 'scrub',
  phase2: 'skritch',
  phase3: 'fwoosh',
  final: 'krak',
} as const;

const WP_PART: Record<number, number> = { 0: PART.forearmR, 1: PART.handR, 2: PART.handL };
const WP_ID_BASE = 9000;

const _v = new THREE.Vector3();
const _p: [number, number, number] = [0, 0, 0];

class WeakPointTarget implements Damageable {
  readonly id: number;
  readonly position = new THREE.Vector3();
  constructor(
    private ed: Editor,
    readonly state: WeakPointState,
  ) {
    this.id = WP_ID_BASE + state.index;
  }
  get radius(): number {
    return TUNING.boss.weakPointRadius;
  }
  get alive(): boolean {
    return this.state.alive && this.ed.fsm.phase === this.state.phase && this.ed.fsm.state === 'phase';
  }
  get revealed(): boolean {
    if (!this.alive || !this.state.exposed) return false;
    return this.state.phase !== 3 || this.ed.coreLit;
  }
  hit(amount: number, from: THREE.Vector3): void {
    this.ed.boltHit(this.state.index, amount, from);
  }
}

export interface EditorOptions {
  /** Parent for all Editor objects (default ctx.render.scene). */
  parent?: THREE.Object3D;
  seed?: number;
  /** Try to load GLB replacements from the asset manifest (default true). */
  loadAssets?: boolean;
  manifestUrl?: string;
}

export class Editor implements EditorSink {
  readonly fsm: EditorFSM;
  readonly uniforms: EditorUniforms;
  rig: EditorRig;
  readonly telegraphs: Telegraphs;
  readonly particles: InkParticles;
  readonly cover: InkCover;
  readonly targets: WeakPointTarget[] = [];
  readonly views: WeakPointView[] = [];
  /** Camera framing hint (world) + weight 0..1. */
  readonly focus = new THREE.Vector3();
  cameraWeight = 0;
  /** True when the P3 core sits inside the crystal light (Blank Page). */
  coreLit = false;
  private group = new THREE.Group();
  private wpGeo = new THREE.IcosahedronGeometry(1, 3);
  private partTarget = new Float32Array(16);
  private hurt = 0;
  private stopSweep: (() => void) | null = null;
  private stopPrint: (() => void) | null = null;
  private printingT = 0;
  private deathStage = 0;
  private blankOut = 0;
  private boilAcc = 0;
  private offs: (() => void)[] = [];
  private parent: THREE.Object3D;

  constructor(
    private ctx: GameContext,
    opts: EditorOptions = {},
  ) {
    this.uniforms = createEditorUniforms(ctx.render.shared);
    this.fsm = new EditorFSM(ctx.tuning, ctx.settings.difficulty, this, opts.seed ?? 1337);
    this.rig = new EditorRig(this.uniforms);
    this.telegraphs = new Telegraphs(this.uniforms, this.fsm.attacks.length);
    this.particles = new InkParticles(this.uniforms);
    this.cover = new InkCover(this.uniforms);
    this.parent = opts.parent ?? ctx.render.scene;
    this.group.name = 'EditorBoss';
    this.group.add(this.rig.root, this.telegraphs.group, this.particles.mesh, this.cover.mesh);
    for (let i = 0; i < WP_COUNT; i++) {
      const st = this.fsm.wps[i]!;
      const t = new WeakPointTarget(this, st);
      this.targets.push(t);
      ctx.targets.add(t);
      const v = new WeakPointView(st, this.wpGeo, this.uniforms);
      this.views.push(v);
      this.group.add(v.mesh);
    }
    this.placeRig();
    this.parent.add(this.group);
    this.offs.push(
      ctx.events.on('settings:changed', (e) => {
        if (e.key === 'difficulty') this.fsm.difficulty = ctx.settings.difficulty;
      }),
    );
    this.fsm.reset();
    this.syncWeakpoints(0);
    if (opts.loadAssets !== false) void this.loadAssets(opts.manifestUrl);
  }

  private placeRig(): void {
    const [x, z] = this.ctx.tuning.boss.pos;
    this.rig.root.position.set(x, 0, z);
  }

  // ─────────────────────────── control ───────────────────────────
  start(): void {
    this.resetVisuals();
    this.fsm.difficulty = this.ctx.settings.difficulty;
    this.ctx.audio.setMusic('boss');
    this.fsm.start();
    this.step(0); // pose + uniforms right away (the intro panel cut freezes the sim)
  }

  /** Debug: jump to a phase (fires the transition, panel cut and all). */
  jumpTo(phase: BossPhase): void {
    if (this.rig.isTorn || this.fsm.state === 'dead' || this.fsm.state === 'dormant') this.resetVisuals();
    if (this.fsm.state === 'dormant' || this.fsm.state === 'dead') this.ctx.audio.setMusic('boss');
    this.fsm.jumpTo(phase);
    this.partTarget.fill(0);
    this.step(0);
  }

  kill(): void {
    this.fsm.kill();
  }

  get defeated(): boolean {
    return this.fsm.state === 'dead';
  }

  private resetVisuals(): void {
    if (this.rig.isTorn) {
      this.group.remove(this.rig.root);
      this.rig.dispose();
      this.rig = new EditorRig(this.uniforms);
      this.group.add(this.rig.root);
      this.placeRig();
    }
    this.partTarget.fill(0);
    const parts = this.uniforms.uPart.value;
    for (let i = 0; i < parts.length; i++) parts[i] = 0;
    this.uniforms.uInkOver.value = 0;
    this.uniforms.uTear.value = 0;
    this.uniforms.uHurt.value = 0;
    this.cover.set(0, 0.5, 0.5, 1);
    this.telegraphs.hideAll();
    this.particles.clear();
    this.deathStage = 0;
    this.blankOut = 0;
    this.ctx.reveal.blankPage = 0;
    this.stopLoops();
  }

  // ─────────────────────────── per step ───────────────────────────
  step(dt: number): void {
    const f = this.fsm;
    const ctx = this.ctx;
    const pl = ctx.player;
    const inp = f.input;
    if (pl) {
      inp.px = pl.position.x;
      inp.pz = pl.position.z;
      inp.cx = pl.crystalPos.x;
      inp.cy = pl.crystalPos.y;
      inp.cz = pl.crystalPos.z;
      inp.crystalHeld = pl.crystalHeld;
    }
    inp.playerRadius = ctx.tuning.player.radius;
    inp.revealRadius = ctx.reveal.radius;

    f.step(dt);
    this.rig.update(f, dt, inp.px, inp.pz);
    this.syncWeakpoints(dt);
    this.telegraphs.update(f, dt);
    this.stepFx(dt);
    this.stepDeath(dt);
    this.stepUniforms(dt);

    // print loop sfx while charging a sketched weak point
    if (this.printingT > 0) {
      this.printingT -= dt;
      if (this.printingT <= 0) this.stopPrintLoop();
    }

    // reveal: Blank Page level (phase 3) and the death ink-back
    if (f.state !== 'dormant') ctx.reveal.blankPage = Math.max(0, f.blank - this.blankOut);

    // camera hint
    this.focus.copy(this.rig.focus);
    const want =
      f.active || f.state === 'dying' ? (f.state === 'intro' || f.state === 'dying' ? 0.75 : 0.35) : 0;
    this.cameraWeight += (want - this.cameraWeight) * (1 - Math.exp(-2 * dt));
  }

  /** Once per rendered frame: line boil, resolution (visual-only, not simulation). */
  frame(frameDt: number): void {
    this.boilAcc += frameDt;
    const hz = this.ctx.tuning.boil.hz;
    if (!this.ctx.settings.reduceMotion && this.boilAcc >= 1 / hz) {
      this.boilAcc = 0;
      this.uniforms.uBoil.value = (this.uniforms.uBoil.value + 0.37) % 64;
    }
    const r = this.ctx.render.renderer;
    r.getDrawingBufferSize(this.uniforms.uRes.value);
    // death cover is centred on the Editor's head in screen space
    if (this.cover.mesh.visible || this.fsm.state === 'dying') {
      _v.copy(this.rig.headWorld).project(this.ctx.render.camera);
      const res = this.uniforms.uRes.value;
      this.cover.mat.uniforms.uAspect!.value = res.x / Math.max(1, res.y);
      (this.cover.mat.uniforms.uCenter!.value as THREE.Vector2).set(
        Math.min(1, Math.max(0, _v.x * 0.5 + 0.5)),
        Math.min(1, Math.max(0, _v.y * 0.5 + 0.5)),
      );
    }
  }

  private syncWeakpoints(dt: number): void {
    const f = this.fsm;
    const anchors = this.rig.anchors;
    this.rig.root.updateMatrixWorld(true);
    const cr = this.ctx.reveal.radius;
    const crystal = this.ctx.player?.crystalPos;
    for (let i = 0; i < WP_COUNT; i++) {
      const w = f.wps[i]!;
      anchors[w.anchor].getWorldPosition(_v);
      w.x = _v.x;
      w.y = _v.y;
      w.z = _v.z;
      this.targets[i]!.position.copy(_v);
    }
    const core = f.wps[CORE_INDEX]!;
    if (crystal) {
      const dx = crystal.x - core.x;
      const dz = crystal.z - core.z;
      this.coreLit = dx * dx + dz * dz <= (cr + 0.6) * (cr + 0.6);
    } else this.coreLit = false;
    for (const v of this.views) v.update(f, dt, this.ctx.tuning.boss.weakPointRadius, this.coreLit);
  }

  private stepFx(dt: number): void {
    const f = this.fsm;
    const P = this.particles;
    const C = P.colors;
    // eraser crumbs while the eraser is on the ground
    if (this.rig.contacting) {
      const c = this.rig.contact;
      const n = f.phase === 2 ? 1 : 3;
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2;
        const s = 1.5 + Math.random() * 3;
        const col = k === 0 ? C.pink : k === 1 ? C.paper : C.graphite;
        P.spawn(
          c.x,
          0.15,
          c.z,
          Math.cos(a) * s,
          2 + Math.random() * 3,
          Math.sin(a) * s,
          Shape.Crumb,
          0.12 + Math.random() * 0.12,
          col,
          0.9,
        );
      }
    }
    P.update(dt);
  }

  private stepUniforms(dt: number): void {
    const u = this.uniforms;
    const f = this.fsm;
    this.hurt = Math.max(0, this.hurt - dt * 5);
    u.uHurt.value = f.state === 'dying' && f.t < 0.9 ? (Math.sin(f.t * 40) > 0 ? 0.8 : 0) : this.hurt;
    u.uRevealR.value = this.ctx.reveal.radius;
    u.uBlank.value = f.state === 'dormant' ? 0 : Math.max(0, f.blank - this.blankOut);
    // erase / redraw parts
    const parts = u.uPart.value;
    const redraw = f.state === 'transition' && f.phase === 2;
    for (let i = 0; i < parts.length; i++) {
      const tgt = redraw ? 0 : this.partTarget[i]!;
      const k = redraw ? 0.9 : 2.2;
      parts[i] = parts[i]! + (tgt - parts[i]!) * (1 - Math.exp(-k * dt));
    }
    if (redraw) this.partTarget.fill(0);
  }

  // ─────────────────────────── death cinematic ───────────────────────────
  private stepDeath(_dt: number): void {
    const f = this.fsm;
    if (f.state !== 'dying') return;
    const t = f.t;
    const u = this.uniforms;
    const sm = (a: number, b: number) => {
      const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
      return x * x * (3 - 2 * x);
    };
    u.uInkTop.value = this.rig.headWorld.y + 0.8;
    u.uInkOver.value = sm(0.9, 2.6);
    u.uTear.value = sm(2.5, 3.1) * 0.7 + sm(3.1, 4.5) * 0.3;
    this.blankOut = sm(2.8, 3.9);
    const coverAmt = sm(3.7, 5.6);
    this.cover.set(coverAmt, 0.5, 0.6, 1);
    const P = this.particles;
    const C = P.colors;
    // ink drips off the body while it floods
    if (t > 0.9 && t < 3.0) {
      this.rig.spine.getWorldPosition(_v);
      for (let k = 0; k < 2; k++)
        P.spawn(
          _v.x + (Math.random() - 0.5) * 2.4,
          _v.y + Math.random() * 3,
          _v.z + (Math.random() - 0.3) * 1.6,
          (Math.random() - 0.5) * 0.5,
          0,
          (Math.random() - 0.5) * 0.5,
          Shape.Blob,
          0.15 + Math.random() * 0.15,
          C.ink,
          1.2,
          12,
        );
    }
    if (this.deathStage === 0 && t >= 2.6) {
      this.deathStage = 1;
      this.ctx.events.emit('boss:death', { stage: 'inked' });
    }
    if (this.deathStage === 1 && t >= 3.0) {
      this.deathStage = 2;
      this.rig.spine.getWorldPosition(_v);
      P.burst(_v.x, _v.y, _v.z, 110, 9, 9, Shape.Shred, 0.45, C.paper, 3.2, 4);
      P.burst(_v.x, _v.y + 1.5, _v.z, 50, 7, 7, Shape.Shred, 0.4, C.ghost, 3.0, 4);
      P.burst(_v.x, _v.y, _v.z, 40, 6, 6, Shape.Shred, 0.38, C.red, 2.8, 4);
      P.burst(_v.x, _v.y, _v.z, 70, 11, 6, Shape.Blob, 0.32, C.ink, 1.6, 14);
      this.ctx.events.emit('fx:shake', { intensity: 1, duration: 0.8 });
      this.ctx.events.emit('boss:death', { stage: 'torn' });
      this.ctx.audio.play('ghost_die', { position: _v, volume: 1, rate: 0.55 });
      this.ctx.audio.play('page_turn', { volume: 1, rate: 0.7 });
    }
    if (this.deathStage === 2 && t >= 5.6) {
      this.deathStage = 3;
      this.ctx.events.emit('boss:death', { stage: 'black' });
    }
  }

  // ─────────────────────────── bolts ───────────────────────────
  boltHit(index: number, amount: number, from: THREE.Vector3): void {
    const ok = this.fsm.hitWeakpoint(index, amount);
    const w = this.fsm.wps[index]!;
    const P = this.particles;
    const C = P.colors;
    if (!ok) {
      // glancing off: a puff of paper
      P.burst(w.x, w.y, w.z, 6, 2, 2, Shape.Crumb, 0.12, C.paper, 0.5);
      return;
    }
    void from;
  }

  // ─────────────────────────── EditorSink ───────────────────────────
  onIntro(): void {
    this.rig.headWorld.toArray(_p);
    this.ctx.audio.play('boss_roar', { volume: 1, rate: 0.85 });
    this.ctx.events.emit('fx:panelCut', {
      word: EDITOR_WORDS.intro,
      focus: this.focusTuple(),
      reason: 'boss:intro',
    });
    this.ctx.events.emit('fx:shake', { intensity: 0.6, duration: 1.4 });
  }

  onPhase(phase: BossPhase): void {
    this.ctx.events.emit('boss:phase', { phase });
    if (this.fsm.t > 0.01 && phase === 1) return; // intro already cut + roared
    const word = phase === 1 ? EDITOR_WORDS.phase1 : phase === 2 ? EDITOR_WORDS.phase2 : EDITOR_WORDS.phase3;
    this.ctx.events.emit('fx:panelCut', { word, focus: this.focusTuple(), reason: `boss:phase${phase}` });
    this.ctx.events.emit('fx:shake', { intensity: 0.5, duration: 1.2 });
    this.ctx.audio.play('boss_roar', { volume: 1, rate: phase === 3 ? 0.75 : 0.95 });
    this.stopLoops();
    if (phase === 3) this.ctx.audio.play('eraser_sweep', { volume: 1, rate: 0.6 });
  }

  onAttack(a: Attack, stage: 'telegraph' | 'strike' | 'end'): void {
    this.ctx.events.emit('boss:attack', { kind: a.kind, stage });
    const at = _v.set(a.ax, 0.2, a.az);
    if (stage === 'strike') {
      const P = this.particles;
      const C = P.colors;
      if (a.kind === 'drag') {
        this.stopSweepLoop();
        this.stopSweep = this.ctx.audio.loop('eraser_sweep', { volume: 0.9 });
        P.burst(a.ax, 0.2, a.az, 26, 6, 5, Shape.Crumb, 0.2, C.pink, 1.0);
        this.ctx.events.emit('fx:shake', { intensity: 0.45, duration: 0.35 });
      } else {
        P.burst(
          a.ax,
          0.15,
          a.az,
          30,
          a.hw * 3.2,
          4,
          Shape.Crumb,
          0.2,
          a.kind === 'press' ? C.paper : C.graphite,
          0.9,
        );
        P.burst(a.ax, 0.15, a.az, 10, a.hw * 2, 6, Shape.Shred, 0.3, C.paper, 1.4, 5);
        this.ctx.events.emit('fx:shake', { intensity: a.kind === 'press' ? 0.6 : 0.4, duration: 0.3 });
        this.ctx.audio.play(a.kind === 'press' ? 'page_turn' : 'scribble_fire', {
          position: at,
          volume: 1,
          rate: 0.6,
        });
      }
    } else if (stage === 'end' && a.kind === 'drag') {
      this.stopSweepLoop();
    } else if (stage === 'telegraph' && a.kind === 'drag') {
      this.ctx.audio.play('scribble_fire', { position: at, volume: 0.5, rate: 0.5 });
    }
  }

  onErase(ax: number, az: number, bx: number, bz: number, hw: number): void {
    this.ctx.reveal.eraseStrip(ax, az, bx, bz, hw);
  }

  onPlayerHit(a: Attack): void {
    const pl = this.ctx.player;
    if (!pl) return;
    pl.damage(this.ctx.tuning.boss.contactDamage, a.kind === 'drag' ? 'eraser' : 'editor');
  }

  onSpawn(kind: 'smudge' | 'scribbler' | 'blot', x: number, z: number): void {
    this.ctx.events.emit('spawn:request', { kind, x, z, source: 'editor' });
    this.particles.burst(x, 0.3, z, 12, 2.5, 4, Shape.Shred, 0.3, this.particles.colors.paper, 1.2, 5);
  }

  onWeakpointHit(w: WeakPointState, destroyed: boolean): void {
    const P = this.particles;
    const C = P.colors;
    const b = this.ctx.tuning.boss;
    this.hurt = destroyed ? 1 : 0.7;
    this.rig.hurtKick = destroyed ? 1 : 0.6;
    P.burst(w.x, w.y, w.z, destroyed ? 34 : 16, destroyed ? 7 : 4.5, 5, Shape.Blob, 0.28, C.ink, 1.1, 12);
    P.burst(w.x, w.y, w.z, destroyed ? 10 : 4, 3, 3, Shape.Blob, 0.18, C.glow, 0.6, 10);
    this.ctx.player?.addEnergy(destroyed ? b.inkPerDestroy : b.inkPerHit);
    this.ctx.events.emit('boss:weakpoint', { index: w.index, destroyed });
    if (destroyed) {
      P.burst(w.x, w.y, w.z, 22, 6, 6, Shape.Shred, 0.35, C.paper, 2.2, 5);
      this.ctx.events.emit('fx:hitstop', { duration: 0.12 });
      this.ctx.events.emit('fx:shake', { intensity: 0.5, duration: 0.4 });
      this.ctx.audio.play('ghost_die', { position: _v.set(w.x, w.y, w.z), volume: 1, rate: 0.7 });
      const part = WP_PART[w.index];
      if (part !== undefined) {
        this.partTarget[part] = 0.92;
        if (w.index === 1) this.partTarget[PART.forearmR] = Math.max(this.partTarget[PART.forearmR]!, 0.5);
      }
      if (w.phase === 3) this.partTarget[PART.torso] = 0.6;
    } else {
      this.ctx.audio.play('blot_drain', { position: _v.set(w.x, w.y, w.z), volume: 0.8, rate: 1.3 });
      if (w.phase === 3) this.partTarget[PART.torso] = Math.min(0.5, this.partTarget[PART.torso]! + 0.2);
    }
  }

  onPrintProgress(w: WeakPointState): void {
    this.ctx.events.emit('sketch:progress', { id: `editor:wp${w.index}`, t: w.print });
    if (!this.stopPrint) this.stopPrint = this.ctx.audio.loop('sketch_loop', { volume: 0.8 });
    this.printingT = 0.15;
  }

  onPrinted(w: WeakPointState): void {
    this.stopPrintLoop();
    this.ctx.events.emit('sketch:printed', { id: `editor:wp${w.index}` });
    this.ctx.audio.play('sketch_done', { position: _v.set(w.x, w.y, w.z), volume: 1 });
    this.particles.burst(w.x, w.y, w.z, 20, 4, 4, Shape.Blob, 0.22, this.particles.colors.ink, 0.9, 10);
  }

  onUnprinted(w: WeakPointState): void {
    this.particles.burst(w.x, w.y, w.z, 14, 3, 3, Shape.Crumb, 0.16, this.particles.colors.pink, 0.8);
    this.ctx.audio.play('eraser_sweep', { position: _v.set(w.x, w.y, w.z), volume: 0.6, rate: 1.4 });
  }

  onStagger(): void {
    this.ctx.audio.play('boss_roar', { volume: 0.7, rate: 1.35 });
    this.ctx.events.emit('fx:shake', { intensity: 0.35, duration: 0.3 });
  }

  onMusic(level: number): void {
    this.ctx.events.emit('music:intensity', { layer: 'boss', level });
  }

  onDeathStart(): void {
    this.stopLoops();
    this.telegraphs.hideAll();
    this.ctx.events.emit('fx:panelCut', {
      word: EDITOR_WORDS.final,
      focus: this.focusTuple(),
      reason: 'boss:final',
    });
    this.ctx.events.emit('fx:hitstop', { duration: 0.25 });
    this.ctx.events.emit('fx:shake', { intensity: 0.8, duration: 1.0 });
    this.ctx.audio.play('boss_roar', { volume: 1, rate: 0.6 });
  }

  onDefeated(): void {
    this.ctx.events.emit('boss:defeated', {});
    this.ctx.audio.play('fanfare', { volume: 1 });
  }

  // ─────────────────────────── helpers ───────────────────────────
  private focusTuple(): [number, number, number] {
    return [this.rig.focus.x, this.rig.focus.y, this.rig.focus.z];
  }

  private stopSweepLoop(): void {
    this.stopSweep?.();
    this.stopSweep = null;
  }
  private stopPrintLoop(): void {
    this.stopPrint?.();
    this.stopPrint = null;
  }
  private stopLoops(): void {
    this.stopSweepLoop();
    this.stopPrintLoop();
  }

  /**
   * Asset hook: if the manifest lists `editor` / `eraser` GLBs (assets workstream), swap them in.
   * Tolerates `[{id,url}]`, `{assets:[{id,url}]}` and `{id:{url}}` shapes; silently keeps the
   * procedural figure when nothing is there.
   */
  async loadAssets(manifestUrl = '/assets/manifest.json'): Promise<void> {
    try {
      const res = await fetch(manifestUrl);
      if (!res.ok) return;
      const json: unknown = await res.json();
      const url = (id: string): string | null => {
        const list = Array.isArray(json)
          ? json
          : json && typeof json === 'object' && Array.isArray((json as { assets?: unknown }).assets)
            ? (json as { assets: unknown[] }).assets
            : null;
        if (list) {
          for (const e of list as { id?: string; url?: string; path?: string; file?: string }[])
            if (e?.id === id) return e.url ?? e.path ?? e.file ?? null;
          return null;
        }
        const e = (json as Record<string, { url?: string; path?: string; file?: string } | string>)[id];
        if (!e) return null;
        return typeof e === 'string' ? e : (e.url ?? e.path ?? e.file ?? null);
      };
      const editorUrl = url('editor');
      const eraserUrl = url('eraser');
      if (!editorUrl && !eraserUrl) return;
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const loader = new GLTFLoader();
      const base = manifestUrl.replace(/[^/]*$/, '');
      const abs = (u: string) => (/^(\/|https?:)/.test(u) ? u : base + u);
      if (editorUrl) this.rig.useModel((await loader.loadAsync(abs(editorUrl))).scene);
      if (eraserUrl) this.rig.usePencilModel((await loader.loadAsync(abs(eraserUrl))).scene);
    } catch {
      // keep procedural
    }
  }

  dispose(): void {
    this.stopLoops();
    for (const off of this.offs) off();
    for (const t of this.targets) this.ctx.targets.remove(t);
    this.parent.remove(this.group);
    this.rig.dispose();
    this.telegraphs.dispose();
    this.particles.dispose();
    this.cover.dispose();
    for (const v of this.views) v.dispose();
    this.wpGeo.dispose();
    this.ctx.reveal.blankPage = 0;
  }
}

/** Create the Editor, add it to the scene and the target registry. */
export function install(ctx: GameContext, opts?: EditorOptions): Editor {
  return new Editor(ctx, opts);
}
