/**
 * Game shell: builds the GameContext, owns the fixed loop and the page flow
 * Boot → Title → Playing(page 1..3) → PageTurn → Boss → Cover → Credits.
 */
import * as THREE from 'three';
import { AudioEngine } from '../audio/AudioEngine';
import { install as installAudio } from '../audio/install';
import { type EventBus, events, type GameEvents } from '../core/events';
import { FLAGS } from '../core/flags';
import { Input } from '../core/input/Input';
import { FixedLoop } from '../core/loop';
import { load, save } from '../core/storage';
import {
  type AudioAPI,
  type CollisionAPI,
  DEFAULT_SETTINGS,
  type GameContext,
  type PageId,
  type RunStats,
  type SaveData,
} from '../core/types';
import { TUNING } from '../data/tuning';
import { type AutoplayBot, installAutoplay } from '../debug/autoplay';
import { attachEditorBot } from '../entities/Editor/bot';
import { type Editor, install as installEditor } from '../entities/Editor/Editor';
import { EnemyRenderer } from '../entities/enemies/EnemyRenderer';
import { EnemySystem } from '../entities/enemies/EnemySystem';
import { installPlayer, type Player } from '../entities/Player';
import { type FxSystem, installFx } from '../fx';
import { InkRenderer, installRender, RevealSystem } from '../render';
import { type Combat, installCombat } from '../systems/combat';
import { InkEnergy, type InkPickups, installInkPickups } from '../systems/ink-energy';
import { Spawner } from '../systems/spawner';
import { createTargets } from '../systems/targets';
import { install as installUI, type UI } from '../ui';
import { loadAsset, preload } from '../world/assets';
import { type CameraRig, installCamera } from '../world/camera';
import { installLevel, type LevelRuntime } from '../world/install';
import { getLevel, nextPage } from '../world/levels';
import { NullAudio } from './NullAudio';

/** Forwards to whichever level collision is current, so systems can keep one reference. */
class CollisionProxy implements CollisionAPI {
  target: CollisionAPI | null = null;
  groundHeight(x: number, z: number): number {
    return this.target ? this.target.groundHeight(x, z) : 0;
  }
  resolveCircle(x: number, z: number, r: number, out: THREE.Vector2): boolean {
    if (this.target) return this.target.resolveCircle(x, z, r, out);
    out.set(x, z);
    return false;
  }
  walkable(x: number, z: number): boolean {
    return this.target ? this.target.walkable(x, z) : true;
  }
  segmentClear(ax: number, az: number, bx: number, bz: number): boolean {
    return this.target ? this.target.segmentClear(ax, az, bx, bz) : true;
  }
}

const SAVE_KEY = 'save';
const PRELOAD = ['wizard', 'props_forest', 'props_graveyard'];

function freshStats(): RunStats {
  return {
    timeS: 0,
    ghostsInked: 0,
    inkCollected: 0,
    pagesTorn: 0,
    deaths: 0,
    boltsFired: 0,
    boltsHit: 0,
    bestPanel: null,
  };
}

export class Game {
  readonly ctx: GameContext;
  readonly render: InkRenderer;
  readonly loop: FixedLoop;
  private collision = new CollisionProxy();
  private ui!: UI;
  private rig!: CameraRig;
  private fx!: FxSystem;
  private player!: Player;
  private energy!: InkEnergy;
  private combat!: Combat;
  private pickups!: InkPickups;
  private enemies!: EnemySystem;
  private enemyGfx!: EnemyRenderer;
  private spawner!: Spawner;
  private level: LevelRuntime | null = null;
  private editor: Editor | null = null;
  private bot: AutoplayBot | null = null;
  private page: PageId | null = null;
  private mode: 'boot' | 'title' | 'playing' | 'turning' | 'cover' = 'boot';
  private paused = false;
  private propCache = new Map<string, THREE.Object3D>();
  private saveData: SaveData = load<SaveData>(SAVE_KEY, {
    lastCheckpoint: null,
    bestTimeS: null,
    completed: false,
  });
  private snapshotPending = 0;
  private snapshotPriority = -1;
  private bossStartArmed = false;
  private readonly bossFocus = new THREE.Vector3();
  private readonly listenerFwd = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    const reveal = new RevealSystem();
    this.render = new InkRenderer({ canvas, reveal, quality: DEFAULT_SETTINGS.quality });
    let audio: AudioAPI;
    try {
      audio = new AudioEngine();
    } catch {
      audio = new NullAudio();
    }
    const settings = { ...DEFAULT_SETTINGS };
    this.ctx = {
      events: events as EventBus<GameEvents>,
      tuning: TUNING,
      settings,
      render: this.render,
      reveal,
      input: new Input({ element: canvas, overlay: document.getElementById('app'), leftHanded: false }),
      audio,
      collision: this.collision,
      targets: createTargets(),
      player: null,
      stats: freshStats(),
      time: { scale: 1, simTime: 0 },
      t: (k) => k,
    };
    this.loop = new FixedLoop(
      { step: (dt) => this.step(dt), render: (a, fdt) => this.frame(a, fdt) },
      TUNING.sim.hz,
      TUNING.sim.maxStepsPerFrame,
    );
  }

  async boot(): Promise<void> {
    const ctx = this.ctx;
    this.ui = installUI(ctx, { onQuit: () => void this.toTitle() });
    ctx.input.setLeftHanded(ctx.settings.leftHanded);
    installRender(ctx, this.render);
    this.fx = installFx(ctx, this.render);
    installAudio(ctx);
    this.rig = installCamera(ctx);
    this.ui.showLoading();
    this.resize();
    addEventListener('resize', () => this.resize());
    addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));
    this.loop.start();

    let character: Awaited<ReturnType<typeof loadAsset>> | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        await preload(PRELOAD, (p) => this.ui.setProgress(p.loaded / Math.max(1, p.total)));
        character = await loadAsset('wizard');
        for (const id of PRELOAD.slice(1)) this.indexProps(id, (await loadAsset(id)).scene);
        break;
      } catch (e) {
        console.warn('asset load failed', e);
        if (attempt >= 1) {
          await new Promise<void>((res) => this.ui.loadError(() => res()));
          attempt = -1;
        }
      }
    }
    this.ui.setProgress(1);

    this.energy = new InkEnergy(ctx.events, TUNING);
    this.player = installPlayer(ctx, character, this.rig, this.energy);
    this.combat = installCombat(ctx, this.player, this.energy);
    this.pickups = installInkPickups(ctx);
    this.enemies = new EnemySystem(
      {
        events: ctx.events,
        tuning: TUNING,
        reveal: ctx.reveal,
        targets: ctx.targets,
        player: this.player,
        stats: ctx.stats,
        collision: this.collision,
        settings: ctx.settings,
      },
      FLAGS.seed,
    );
    this.enemyGfx = new EnemyRenderer(this.enemies, {
      crystalPos: () => this.player.crystalPos,
      inkContext: { shared: this.render.shared, reveal: ctx.reveal.uniforms },
    });
    this.render.scene.add(this.enemyGfx.root);
    this.spawner = new Spawner(ctx.events, this.enemies);
    this.wireEvents();
    this.player.object.visible = false;

    document.documentElement.dataset.ready = '1';
    await this.ui.finishLoading({ waitForTap: !(FLAGS.skipIntro || FLAGS.page) });
    void this.ctx.audio.unlock().catch(() => {});
    const start = FLAGS.page ? (FLAGS.page === 'boss' ? 'boss' : (Number(FLAGS.page) as PageId)) : null;
    if (start || FLAGS.skipIntro) await this.newRun(start ?? 1);
    else await this.toTitle();
  }

  // ───────────────────────────── flow ─────────────────────────────

  private async toTitle(): Promise<void> {
    this.mode = 'title';
    this.setPaused(false);
    this.ui.hideHud();
    this.teardownPage();
    this.page = null;
    // a live, empty first page behind the title
    this.level = installLevel(this.ctx, 1, { assets: (id) => this.prop(id) });
    this.collision.target = this.level.built.collision;
    this.ctx.collision = this.collision;
    this.level.start();
    this.player.object.visible = true;
    this.player.setControllable(false);
    this.ctx.input.setEnabled(false);
    this.ctx.events.emit('state:change', { from: 'boot', to: 'title' });
    const cp = this.saveData.lastCheckpoint;
    const choice = await this.ui.title({ continuePage: cp ? (cp.page === 'boss' ? 4 : cp.page) : null });
    if (choice === 'continue' && cp) await this.newRun(cp.page, cp.id);
    else await this.newRun(1);
  }

  private async newRun(page: PageId, checkpoint?: string): Promise<void> {
    void this.ctx.audio.unlock().catch(() => {});
    Object.assign(this.ctx.stats, freshStats());
    this.energy.add(TUNING.energy.max);
    await this.startPage(page, checkpoint);
  }

  private async startPage(page: PageId, checkpoint?: string): Promise<void> {
    this.teardownPage();
    this.page = page;
    const def = getLevel(page);
    this.level = installLevel(this.ctx, def, { assets: (id) => this.prop(id) });
    this.collision.target = this.level.built.collision;
    this.ctx.collision = this.collision;
    this.spawner.load(def);
    this.player.object.visible = true;
    this.level.start(checkpoint);
    this.rig.snap(this.player.position);
    this.player.setControllable(true);
    this.ctx.input.setEnabled(true);
    this.mode = 'playing';
    if (page === 'boss') this.setupBoss(def.anchors?.boss);
    this.ctx.events.emit('state:change', { from: 'boot', to: page === 'boss' ? 'boss' : 'playing' });
    if (FLAGS.autoplay) {
      this.bot = installAutoplay(
        this.ctx,
        { path: def.path, sketches: def.sketches.map((s) => ({ id: s.id, at: s.at })) },
        this.rig,
      );
      if (this.editor) attachEditorBot(this.bot, this.editor, this.ctx, this.rig);
    }
    this.ui.showHud();
    void this.ui.titleCard(page);
  }

  private setupBoss(anchor: readonly number[] | undefined): void {
    if (anchor) TUNING.boss.pos = [anchor[0] ?? 0, anchor[2] ?? -11];
    this.editor = installEditor(this.ctx, {
      loadAssets: false,
      seed: FLAGS.seed,
      dropInk: (x, z, n) => this.pickups.spawn(x, this.collision.groundHeight(x, z), z, n),
    });
    this.bossStartArmed = true;
  }

  private teardownPage(): void {
    this.bot?.dispose();
    this.bot = null;
    this.editor?.dispose();
    this.editor = null;
    this.bossStartArmed = false;
    this.enemies?.clear();
    this.spawner?.load(null);
    this.level?.dispose();
    this.level = null;
    this.collision.target = null;
    this.ctx.reveal.reset();
  }

  private async nextPageTurn(): Promise<void> {
    if (this.mode !== 'playing' || this.page === null) return;
    const next = nextPage(this.page);
    if (next === null) return;
    this.mode = 'turning';
    this.ctx.events.emit('sfx:play', { id: 'page_turn' });
    await this.render.pageTurn(() => this.startPage(next), TUNING.pageTurn.duration);
  }

  private async toCover(): Promise<void> {
    if (this.mode === 'cover') return;
    this.mode = 'cover';
    this.player.setControllable(false);
    this.ctx.input.setEnabled(false);
    this.ui.hideHud();
    const time = this.ctx.stats.timeS;
    const best = this.saveData.bestTimeS;
    this.saveData = {
      lastCheckpoint: null,
      completed: true,
      bestTimeS: best == null ? time : Math.min(best, time),
    };
    save(SAVE_KEY, this.saveData);
    if (!this.ctx.stats.bestPanel) this.ctx.stats.bestPanel = this.render.snapshot(720, 1280);
    this.ctx.events.emit('state:change', { from: 'boss', to: 'cover' });
    await this.ui.cover(this.ctx.stats, { bestTimeS: best });
    await this.toTitle();
  }

  // ───────────────────────────── events ─────────────────────────────

  private wireEvents(): void {
    const ev = this.ctx.events;
    ev.on('trigger:fired', ({ id }) => {
      this.spawner.fireTrigger(id);
      if (this.bossStartArmed && id === 'boss_intro') {
        this.bossStartArmed = false;
        this.editor?.start();
      }
    });
    ev.on('tutorial:hint', (e) => ev.emit('ui:tutorial', e));
    ev.on('spawn:request', (e) => {
      this.enemies.spawn(e.kind, e.x, e.z);
    });
    ev.on('page:complete', () => void this.nextPageTurn());
    ev.on('checkpoint:reached', ({ id }) => {
      if (this.page === null || this.mode !== 'playing') return;
      this.saveData.lastCheckpoint = { page: this.page, id };
      save(SAVE_KEY, this.saveData);
    });
    ev.on('player:died', () => {
      this.ctx.stats.deaths++;
    });
    ev.on('player:damaged', () => {
      this.ctx.stats.pagesTorn++;
    });
    // the Blank Page wipe erases every ghost too (they'd be invisible and unhittable in it)
    ev.on('boss:phase', (e) => {
      if (e.phase === 3) this.enemies.clear();
    });
    ev.on('boss:death', (e) => {
      if (e.stage === 'black') setTimeout(() => void this.toCover(), 600);
    });
    ev.on('fx:panelCut', (e) => {
      const pri = e.reason.startsWith('boss') ? 3 : e.reason.includes('crit') ? 2 : 1;
      if (pri >= this.snapshotPriority) {
        this.snapshotPriority = pri;
        this.snapshotPending = 4;
      }
    });
    // Audio handles both itself: game:pause muffles music and silences loops (pause-menu clicks
    // still play); the engine suspends on hide and resumes on show / the next gesture (iOS).
    ev.on('game:pause', (e) => {
      this.paused = e.paused;
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.mode === 'playing') this.setPaused(true);
    });
  }

  private setPaused(p: boolean): void {
    this.paused = p;
    this.ui?.setPaused(p);
  }

  // ───────────────────────────── loop ─────────────────────────────

  private step(dt: number): void {
    if (this.mode === 'boot' || this.paused) return;
    const ctx = this.ctx;
    // installAutoplay patches input.poll() to drive the bot; driving it again here cleared its
    // edge-triggered presses (no bolt ever fired under ?autoplay=1).
    ctx.input.poll();
    this.player.step(dt);
    this.combat.step(dt);
    this.pickups.step(dt, this.player, (n) => this.energy.add(n));
    this.spawner.step(dt);
    this.enemies.step(dt);
    this.editor?.step(dt);
    this.level?.update(dt);
    ctx.reveal.update(dt);
    if (this.mode === 'playing') ctx.stats.timeS += dt;
  }

  private frame(alpha: number, frameDt: number): void {
    const ctx = this.ctx;
    this.loop.timeScale = this.paused ? 0 : ctx.time.scale;
    ctx.time.simTime = this.loop.simTime;
    const dt = this.paused ? 0 : frameDt;
    if (this.mode !== 'boot') {
      this.player.render(alpha, dt);
      const target = this.player.renderPosition;
      if (this.editor && this.editor.cameraWeight > 0) {
        this.bossFocus.copy(target).lerp(this.editor.focus, this.editor.cameraWeight * 0.5);
        this.rig.update(frameDt, this.bossFocus, this.player.velocity);
        this.editor.applyCamera(this.render.camera, frameDt);
      } else this.rig.update(frameDt, target, this.player.velocity);
      this.player.faceCamera(this.render.camera);
      this.combat.render(alpha);
      this.pickups.render(this.render.shared.uTime!.value as number);
      this.enemyGfx.update(dt * ctx.time.scale, this.render.camera);
      this.editor?.frame(dt);
      this.render.camera.getWorldDirection(this.listenerFwd);
      ctx.audio.setListener(this.render.camera.position, this.listenerFwd);
    }
    this.fx.update(frameDt);
    this.ui.update(frameDt);
    this.render.render(frameDt);
    if (this.snapshotPending > 0 && --this.snapshotPending === 0) {
      ctx.stats.bestPanel = this.render.snapshot(720, 1280);
    }
  }

  private resize(): void {
    this.render.resize();
    this.level?.resize();
  }

  // ───────────────────────────── props ─────────────────────────────

  private indexProps(_packId: string, root: THREE.Object3D): void {
    root.traverse((o) => {
      if (o !== root && o.parent === root) this.propCache.set(o.name, o);
    });
  }

  private prop(id: string): THREE.Object3D | null {
    const src = this.propCache.get(id) ?? this.propCache.get(id.replace(/^.*[:/]/, ''));
    return src ? src.clone(true) : null;
  }
}
