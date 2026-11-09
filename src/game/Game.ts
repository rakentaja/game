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
import type { AutoplayBot } from '../debug/autoplay';
import type { Editor } from '../entities/Editor/Editor';
import { EnemyRenderer } from '../entities/enemies/EnemyRenderer';
import { EnemySystem } from '../entities/enemies/EnemySystem';
import { type HeroRuntime, installHeroes } from '../entities/heroes/runtime';
import { installPlayer, type Player } from '../entities/Player';
import { type FxSystem, installFx } from '../fx';
import { InkRenderer, installRender, RevealSystem } from '../render';
import { Director, directorWorld } from '../systems/ai/director';
import { type Combat, installCombat } from '../systems/combat';
import { InkEnergy, type InkPickups, installInkPickups } from '../systems/ink-energy';
import { Spawner } from '../systems/spawner';
import { installStyle, type StyleSystem } from '../systems/style';
import { createTargets } from '../systems/targets';
import { install as installUI, type UI } from '../ui';
import { MarginNotes } from '../ui/hud/margin';
import { loadAsset, preload } from '../world/assets';
import { type CameraRig, installCamera } from '../world/camera';
import { installLevel, type LevelRuntime } from '../world/install';
import { nextPage } from '../world/levels';
import { parseDailyFlag } from '../world/meta/daily';
import { installMeta, type MetaRuntime } from '../world/meta/install';
import { NullAudio } from './NullAudio';

type CoopModule = typeof import('../coop');
type CoopSessionT = import('../coop').CoopSession;
type CoopHostT = import('../coop').CoopHost;
let coopModule: Promise<CoopModule> | null = null;
/** Co-op runtime (local 2P + online) is a lazy chunk: solo players never download it. */
function loadCoop(): Promise<CoopModule> {
  coopModule ??= import('../coop');
  return coopModule;
}
const LOCAL2P =
  typeof location !== 'undefined' && new URLSearchParams(location.search).get('local2p') === '1';

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

type BossModule = {
  installEditor: typeof import('../entities/Editor/Editor').install;
  attachEditorBot: typeof import('../entities/Editor/bot').attachEditorBot;
};
let bossModule: Promise<BossModule> | null = null;
/** THE EDITOR is code-split out of the initial bundle; prefetched from page 3 (or on demand). */
function loadBoss(): Promise<BossModule> {
  bossModule ??= Promise.all([import('../entities/Editor/Editor'), import('../entities/Editor/bot')]).then(
    ([e, b]) => ({ installEditor: e.install, attachEditorBot: b.attachEditorBot }),
  );
  return bossModule;
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
  private style!: StyleSystem;
  private margin: MarginNotes | null = null;
  private level: LevelRuntime | null = null;
  private meta!: MetaRuntime;
  private editor: Editor | null = null;
  private bot: AutoplayBot | null = null;
  private heroes!: HeroRuntime;
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
  /** Co-op session (local 2P or online); null in solo play. */
  private coop: CoopSessionT | null = null;
  private coopStarting = false;
  private readonly coopFocus = new THREE.Vector3();
  private lastFrameAt = 0;

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
      // #app (not the canvas): HUD layers sit above the canvas; Input skips real UI controls itself
      input: new Input({
        element: document.getElementById('app') ?? canvas,
        overlay: document.getElementById('app'),
        leftHanded: false,
      }),
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
    this.heroes = installHeroes(ctx, this.player);
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
        get beat() {
          return ctx.beat ?? null;
        },
      },
      FLAGS.seed,
    );
    this.enemyGfx = new EnemyRenderer(this.enemies, {
      crystalPos: () => this.player.crystalPos,
      inkContext: { shared: this.render.shared, reveal: ctx.reveal.uniforms },
      label: (k) => ctx.t(k),
    });
    this.render.scene.add(this.enemyGfx.root);
    this.spawner = new Spawner(ctx.events, this.enemies);
    this.combat.projectiles = this.enemies.projectiles;
    this.style = installStyle(ctx);
    this.margin = new MarginNotes(
      ctx.events,
      () => ctx.t,
      () => ctx.settings.reduceMotion,
    );
    (document.getElementById('ui-root') ?? document.getElementById('app') ?? document.body).append(
      this.margin.el,
    );
    // "The Inker's Deadline": director moments layered on the authored waves
    this.spawner.director = new Director(ctx.events, TUNING, directorWorld(this.enemies), {
      scale: () => TUNING.difficulty[ctx.settings.difficulty]?.deadline ?? 1,
    });
    this.meta = installMeta(ctx, {
      dropInk: (x, z, n) => this.pickups.spawn(x, this.collision.groundHeight(x, z), z, n),
    });
    this.wireEvents();
    this.player.object.visible = false;
    if (LOCAL2P) this.coop = await (await loadCoop()).startLocal2p(this.coopHost());
    // an invite link may land while the host is already mid-issue: watch the lobby for a resume
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('room'))
      void Promise.all([loadCoop(), import('../net')]).then(([m, n]) =>
        m.watchResume(this.ctx.events, () => this.coop !== null || this.coopStarting, n),
      );

    document.documentElement.dataset.ready = '1';
    await this.ui.finishLoading({ waitForTap: !(FLAGS.skipIntro || FLAGS.page) });
    void this.ctx.audio.unlock().catch(() => {});
    const start = FLAGS.page ? (FLAGS.page === 'boss' ? 'boss' : (Number(FLAGS.page) as PageId)) : null;
    const daily = parseDailyFlag(FLAGS.daily);
    if (daily) await this.newRun(start ?? 1, undefined, daily);
    // ?autoplay=1 with a co-op room (?room=CODE or ?coop=host) goes through the lobby (e2e)
    else if ((start || FLAGS.skipIntro) && !/[?&](room|coop)=/.test(location.search))
      await this.newRun(start ?? 1);
    else await this.toTitle();
  }

  // ───────────────────────────── flow ─────────────────────────────

  private async toTitle(): Promise<void> {
    if (this.coop && this.coop.kind !== 'local') this.endNetCoop();
    this.mode = 'title';
    this.setPaused(false);
    this.ui.hideHud();
    this.margin?.setVisible(false);
    this.heroes.hide();
    this.teardownPage();
    this.page = null;
    this.meta.detachPage();
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
    const dailyDate = parseDailyFlag(FLAGS.daily) ?? undefined;
    const choice = await this.ui.title({
      continuePage: cp ? (cp.page === 'boss' ? 4 : cp.page) : null,
      daily: this.meta.dailyEntry(dailyDate),
    });
    if (choice === 'daily') await this.newRun(1, undefined, this.meta.dailyEntry(dailyDate).date);
    else if (choice === 'continue' && cp) await this.newRun(cp.page, cp.id);
    else await this.newRun(1);
  }

  private async newRun(page: PageId, checkpoint?: string, dailyDate?: string): Promise<void> {
    void this.ctx.audio.unlock().catch(() => {});
    Object.assign(this.ctx.stats, freshStats());
    this.style?.reset();
    this.meta.startRun(dailyDate ? 'daily' : 'main', dailyDate);
    await this.meta.ready();
    await this.heroes.prepare();
    this.energy.add(this.energy.max);
    await this.startPage(page, checkpoint);
  }

  private async startPage(page: PageId, checkpoint?: string): Promise<void> {
    this.coop?.onPageTeardown();
    this.teardownPage();
    this.page = page;
    const def = this.meta.levelFor(page);
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
    if (page === 'boss') this.setupBoss(def.anchors?.boss, await loadBoss());
    else if (page === 3) void loadBoss();
    if (page === 'boss') void this.ui.loadEndScreens();
    this.ctx.events.emit('state:change', { from: 'boot', to: page === 'boss' ? 'boss' : 'playing' });
    this.coop?.onPageStart(page);
    if (FLAGS.autoplay) {
      // the bot is a debug tool: lazy chunk, never in the initial bundle
      const { installAutoplay } = await import('../debug/autoplay');
      this.bot = installAutoplay(
        this.ctx,
        {
          path: def.path,
          sketches: def.sketches.map((s) => ({ id: s.id, at: s.at })),
          inkWells: def.inkWells,
          canPrint: (id) => this.level?.sketches.isEnabled(id) ?? true,
        },
        this.rig,
        { boss: () => this.editor?.fsm ?? null, projectiles: this.enemies.projectiles },
      );
      if (this.editor && bossModule)
        (await bossModule).attachEditorBot(this.bot, this.editor, this.ctx, this.rig);
    }
    this.ui.showHud();
    this.coop?.setHudVisible(true);
    this.margin?.setVisible(true);
    const lv = this.level;
    this.heroes.pageStarted(page, {
      sketches: def.sketches,
      isPrinted: (id) => lv?.sketches.isPrinted(id) ?? true,
      isEnabled: (id) => lv?.sketches.isEnabled(id) ?? false,
    });
    this.meta.attachPage(page);
    void this.ui.titleCard(page);
  }

  private setupBoss(anchor: readonly number[] | undefined, mod: BossModule): void {
    if (anchor) TUNING.boss.pos = [anchor[0] ?? 0, anchor[2] ?? -11];
    this.editor = mod.installEditor(this.ctx, {
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
    // co-op: the host schedules the turn for both machines (only when BOTH wizards are at the exit)
    if (this.coop?.handlePageComplete(this.page)) return;
    const next = nextPage(this.page);
    if (next === null) return;
    await this.turnTo(next);
  }

  private async turnTo(next: PageId): Promise<void> {
    if (this.mode !== 'playing') return;
    this.mode = 'turning';
    this.ctx.events.emit('sfx:play', { id: 'page_turn' });
    await this.render.pageTurn(() => this.startPage(next), TUNING.pageTurn.duration);
  }

  // ───────────────────────────── co-op ─────────────────────────────

  private coopHost(): CoopHostT {
    return {
      ctx: this.ctx,
      player: this.player,
      energy: this.energy,
      combat: this.combat,
      enemies: this.enemies,
      spawner: this.spawner,
      pickups: this.pickups,
      rig: this.rig,
      level: () => this.level,
      page: () => this.page,
      editor: () => this.editor,
      mode: () => this.mode,
      startRun: (page, cp) => this.newRun(page, cp),
      startPage: (page, cp) => {
        this.mode = 'playing';
        return this.startPage(page, cp);
      },
      turnTo: (page) => this.turnTo(page),
      session: () => this.coop,
      setSession: (c) => {
        this.coop = c;
      },
      endCoop: () => this.endNetCoop(),
      stepSim: (dt) => this.step(dt),
      lastFrameAt: () => this.lastFrameAt,
    };
  }

  private async startNetCoop(e: GameEvents['coop:start']): Promise<void> {
    if (this.coopStarting || (this.coop && this.coop.kind !== 'local')) return;
    this.coopStarting = true;
    try {
      const [m, n] = await Promise.all([loadCoop(), import('../net')]);
      await m.launchNet(this.coopHost(), e, n.activeSession());
    } finally {
      this.coopStarting = false;
    }
  }

  private endNetCoop(): void {
    const c = this.coop;
    if (!c || c.kind === 'local') return;
    this.coop = null;
    c.dispose();
    void import('../net').then((n) => n.activeSession()?.close());
  }

  private async toCover(): Promise<void> {
    if (this.mode === 'cover') return;
    this.mode = 'cover';
    this.coop?.setHudVisible(false);
    this.player.setControllable(false);
    this.ctx.input.setEnabled(false);
    this.ui.hideHud();
    this.margin?.setVisible(false);
    const time = this.ctx.stats.timeS;
    const best = this.saveData.bestTimeS;
    this.meta.detachPage();
    this.meta.runComplete(time);
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
    // A spawn group's last wave cleared → `<trigger>_cleared` (e.g. Level 3's boss door
    // `requires: 'p3_arena_cleared'`). Without this bridge the door could never print.
    ev.on('wave:cleared', (e) => {
      if (e.last) ev.emit('trigger:fired', { id: `${e.trigger}_cleared` });
    });
    ev.on('tutorial:hint', (e) => ev.emit('ui:tutorial', e));
    ev.on('settings:changed', (e) => {
      if (e.key === 'lang' || e.key === '*') this.enemyGfx?.refreshLabels();
    });
    // bonus ink (First Edition elites, director relax beats); regular death drops come from enemy:died
    ev.on('ink:drop', (e) => {
      if (!e.bonus) return;
      const [x, , z] = e.position;
      this.pickups.spawn(x, this.collision.groundHeight(x, z), z, e.amount);
    });
    // a hero printed a sketch its own way (Penciller traced around it)
    ev.on('hero:print', (e) => {
      const lv = this.level;
      if (!lv || this.mode !== 'playing') return;
      for (const s of lv.def.sketches) {
        if (lv.sketches.isPrinted(s.id) || !lv.sketches.isEnabled(s.id)) continue;
        if (Math.hypot(s.at[0] - e.x, s.at[2] - e.z) > e.radius) continue;
        if (s.ambushTrigger) ev.emit('trigger:fired', { id: s.ambushTrigger });
        lv.sketches.printNow(s.id);
        break;
      }
    });
    ev.on('spawn:request', (e) => {
      this.enemies.spawn(e.kind, e.x, e.z);
    });
    ev.on('page:complete', () => void this.nextPageTurn());
    ev.on('checkpoint:reached', ({ id }) => {
      if (this.page === null || this.mode !== 'playing') return;
      this.saveData.lastCheckpoint = { page: this.page, id };
      save(SAVE_KEY, this.saveData);
    });
    ev.on('player:respawn', () => {
      this.coop?.onRespawn?.();
      // fresh encounters after a reprint: no ghosts camping the checkpoint, fights replay from their triggers
      this.enemies.clear();
      if (this.level && this.page !== 'boss' && this.coop?.authority !== false)
        this.spawner.load(this.level.def);
    });
    // 'inkDrought' caption: InkEnergy.add ignores negative amounts, so drain explicitly
    ev.on('caption:effect', (e) => {
      if (e.effect === 'inkDrought') this.energy.drain(TUNING.worldMeta.captions.inkDrought);
    });
    ev.on('coop:start', (e) => void this.startNetCoop(e));
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
      // online co-op can't pause a shared page: keep simulating (watchdog below covers lost rAF)
      if (document.hidden && this.mode === 'playing' && !this.netCoop) this.setPaused(true);
    });
  }

  private get netCoop(): boolean {
    return !!this.coop && this.coop.kind !== 'local';
  }

  private setPaused(p: boolean): void {
    this.paused = p;
    this.ui?.setPaused(p);
  }

  // ───────────────────────────── loop ─────────────────────────────

  private step(dt: number): void {
    // an online page never pauses (the pause menu still opens; the shared world keeps going)
    if (this.mode === 'boot' || (this.paused && !this.netCoop)) return;
    const ctx = this.ctx;
    const coop = this.coop;
    // installAutoplay patches input.poll() to drive the bot; driving it again here cleared its
    // edge-triggered presses (no bolt ever fired under ?autoplay=1).
    ctx.input.poll();
    this.player.step(dt);
    coop?.stepPlayers(dt);
    this.combat.step(dt);
    coop?.stepCombat(dt);
    this.style.step(dt);
    if (coop) coop.stepPickups(dt);
    else this.pickups.step(dt, this.player, (n) => this.energy.add(n));
    this.spawner.step(dt);
    coop?.preWorld(dt);
    this.enemies.step(dt);
    this.editor?.step(dt);
    this.level?.update(dt);
    this.meta.step(dt, this.mode === 'playing');
    coop?.postStep(dt);
    ctx.reveal.update(dt);
    if (this.mode === 'playing') ctx.stats.timeS += dt;
  }

  private frame(alpha: number, frameDt: number): void {
    const ctx = this.ctx;
    this.lastFrameAt = performance.now();
    this.loop.timeScale = this.paused && !this.netCoop ? 0 : ctx.time.scale;
    ctx.time.simTime = this.loop.simTime;
    const dt = this.paused ? 0 : frameDt;
    if (this.mode !== 'boot') {
      this.player.render(alpha, dt);
      this.coop?.frame(alpha, dt);
      const zoom2 = this.coop?.cameraFocus(this.coopFocus) ?? null;
      const target = zoom2 !== null ? this.coopFocus : this.player.renderPosition;
      if (this.editor && this.editor.cameraWeight > 0) {
        this.bossFocus.copy(target).lerp(this.editor.focus, this.editor.cameraWeight * 0.5);
        this.rig.zoom = 1 + this.editor.cameraWeight * 0.55; // keep the 7 m Editor and the wizard in frame
        this.rig.update(frameDt, this.bossFocus, this.player.velocity);
        this.editor.applyCamera(this.render.camera, frameDt);
      } else {
        this.rig.zoom = zoom2 ?? 1;
        this.rig.update(frameDt, target, this.player.velocity);
      }
      this.player.faceCamera(this.render.camera);
      this.combat.render(alpha);
      this.pickups.render(this.render.shared.uTime!.value as number);
      this.enemyGfx.update(dt * ctx.time.scale, this.render.camera);
      this.editor?.frame(dt);
      this.render.camera.getWorldDirection(this.listenerFwd);
      ctx.audio.setListener(this.render.camera.position, this.listenerFwd);
    }
    // FX advance through render.onFrame (inside render.render); calling fx.update here as well
    // ran every hit-stop / slow-mo clock at double speed.
    this.margin?.update(frameDt);
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
