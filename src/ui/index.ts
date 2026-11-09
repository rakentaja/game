/**
 * UI workstream entry. `install(ctx)` builds every screen into #ui-root, wires the event bus and
 * returns the `UI` API the integrator drives from main.ts (see docs/DECISIONS.md "ui:" entries).
 *
 *   const ui = install(ctx);
 *   ui.showLoading(); ui.setProgress(p); await ui.finishLoading();   // tap = audio unlock gesture
 *   await ui.title();                                                 // resolves on "Read Issue #1"
 *   ui.showHud();  …  ui.update(frameDt) every frame
 *   await ui.cover(ctx.stats);                                        // resolves on "Back to title"
 */
import type { EventBus, GameEvents } from '../core/events';
import { FLAGS } from '../core/flags';
import { haptics } from '../core/input/haptics';
import { captureInstallPrompt, installHeadLinks, installMode, promptInstall, registerPWA } from '../core/pwa';
import { load, save } from '../core/storage';
import type { GameContext, PageId, RunStats, Settings, SfxId } from '../core/types';
import { TUNING } from '../data/tuning';
import { h } from './dom';
import { Captions } from './hud/captions';
import { Hud, type HudSources } from './hud/hud';
import type { Hint } from './hud/tutorial';
import { I18n, type Vars } from './i18n';
import { ICON_IOS_SHARE } from './icons';
import { CoverScreen } from './screens/cover';
import { CreditsScreen } from './screens/credits';
import { LoadingScreen } from './screens/loading';
import { DeathOverlay, TitleCard } from './screens/overlays';
import { PauseScreen } from './screens/pause';
import type { ToastOpts, UIEnv } from './screens/screen';
import { SettingsScreen } from './screens/settings';
import { TitleScreen } from './screens/title';
import { SettingsStore } from './settings';
import { Toasts } from './toast';
import './fonts.css';
import './theme.css';

export type { Hint } from './hud/tutorial';
export { I18n } from './i18n';
export { SettingsStore } from './settings';

export interface UIOptions {
  root?: HTMLElement;
  /** Register the service worker + head links (default true). */
  pwa?: boolean;
  /** Push settings into ctx.audio/render/input on change (default true; calls are idempotent). */
  applySettings?: boolean;
  /** Called when the player confirms "Back to title" in the pause menu. */
  onQuit?: () => void;
  /** Extra HUD data sources (defaults read ctx.player / ctx.render / ctx.input). */
  hud?: HudSources;
}

/** Subset of GameContext the UI can run with (dev harness passes only events + settings). */
export type UIContext = Pick<GameContext, 'events'> & Partial<Omit<GameContext, 'events'>>;

const A2HS_KEY = 'a2hs';

export class UI {
  readonly i18n: I18n;
  readonly settings: SettingsStore;
  readonly t: (key: string, vars?: Vars) => string;
  readonly root: HTMLElement;
  readonly hud: Hud;
  readonly loading: LoadingScreen;
  readonly captions: Captions;
  private titleScr: TitleScreen;
  private pauseScr: PauseScreen;
  private settingsScr: SettingsScreen;
  private creditsScr: CreditsScreen;
  private coverScr: CoverScreen;
  private death: DeathOverlay;
  private card: TitleCard;
  private toasts: Toasts;
  private env: UIEnv;
  private bus: EventBus<GameEvents>;
  private offs: (() => void)[] = [];
  private paused = false;
  private bossHits = 0;
  private bossExact = false;
  private hintTimer = new Map<Hint, number>();
  onQuit: (() => void) | null;

  constructor(
    private ctx: UIContext,
    private opts: UIOptions = {},
  ) {
    this.bus = ctx.events;
    this.root = opts.root ?? (document.getElementById('ui-root') as HTMLElement) ?? document.body;
    this.settings = new SettingsStore(this.bus, ctx.settings);
    // ?lang=tr|en (debug/share links) overrides for this session without persisting
    if (FLAGS.lang) this.settings.value.lang = FLAGS.lang;
    this.i18n = new I18n(this.settings.get('lang'));
    document.documentElement.lang = this.i18n.lang;
    this.t = this.i18n.t;
    this.onQuit = opts.onQuit ?? null;
    this.toasts = new Toasts(() => this.sfx('ui_click'));

    this.env = {
      root: this.root,
      i18n: this.i18n,
      t: this.t,
      settings: this.settings,
      bus: this.bus,
      sfx: (id) => this.sfx(id),
      haptic: (p) => this.haptic(p),
      reduceMotion: () => this.settings.get('reduceMotion'),
      inputDrivesPause: !!ctx.input,
      toast: (m, o) => this.toast(m, o),
    };

    this.loading = new LoadingScreen(this.env);
    this.titleScr = new TitleScreen(this.env);
    this.pauseScr = new PauseScreen(this.env);
    this.settingsScr = new SettingsScreen(this.env);
    this.creditsScr = new CreditsScreen(this.env);
    this.coverScr = new CoverScreen(this.env);
    this.death = new DeathOverlay(this.env);
    this.card = new TitleCard(this.env);

    const p = () => ctx.player ?? null;
    this.hud = new Hud(this.env, {
      camera: () => ctx.render?.camera ?? null,
      anchor: () => p()?.crystalPos ?? null,
      playerVelX: () => p()?.velocity.x ?? 0,
      moveLen: () => ctx.input?.state.move.length() ?? 0,
      device: () =>
        ctx.input?.state.device ?? (matchMedia('(pointer: coarse)').matches ? 'touch' : 'keyboard'),
      ...opts.hud,
    });
    this.hud.onPause = () => this.setPaused(true);
    this.captions = new Captions(this.bus, this.t, (x) => this.i18n.upper(x), {
      sfx: () => this.sfx('ui_click'),
      haptic: (p) => this.haptic(p),
    });
    this.root.append(this.hud.el, this.captions.el, this.toasts.el);

    if (ctx.t === undefined || ctx.t !== this.t) (ctx as { t?: UI['t'] }).t = this.t;
    // input-side haptics (taps/dash/crystal) honour the vibration toggle
    haptics.settings = this.settings.value;
    this.wire();
    this.applyAll();
    captureInstallPrompt();
    if (opts.pwa !== false) {
      installHeadLinks();
      void registerPWA({ t: this.t, toast: (m, o) => this.toast(m, o) });
    }
  }

  // ───────────────────────── services ─────────────────────────
  sfx(id: SfxId): void {
    this.bus.emit('sfx:play', { id });
  }

  haptic(pattern: number | number[]): void {
    if (!this.settings.get('vibration')) return;
    // Chrome warns when vibrate() runs before the first user gesture
    const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
    if (ua && !ua.hasBeenActive) return;
    try {
      navigator.vibrate?.(pattern);
    } catch {
      /* iOS / unsupported */
    }
  }

  toast(msg: string | Node, opts?: ToastOpts): () => void {
    return this.toasts.show(msg, opts);
  }

  // ───────────────────────── flow API ─────────────────────────
  showLoading(): void {
    this.loading.show();
  }

  setProgress(p: number): void {
    this.loading.setProgress(p);
  }

  /** Ink the logo, wait for the first tap (audio unlock), then fade out the loading screen. */
  async finishLoading(opts: { waitForTap?: boolean } = {}): Promise<void> {
    await this.loading.complete(opts);
    this.loading.hide();
  }

  loadError(retry: () => void): void {
    this.loading.error(retry);
  }

  /** Show the title menu; resolves when the player starts (or continues) the issue. */
  title(
    opts: {
      continuePage?: number | null;
      daily?: { number: number; ruleKey: string; bestS: number | null } | null;
    } = {},
  ): Promise<'play' | 'continue' | 'daily'> {
    this.hideHud();
    this.card.hide();
    this.bus.emit('music:intensity', { layer: 'explore', level: 0 });
    return new Promise((resolve) => {
      const done = (r: 'play' | 'continue' | 'daily') => {
        this.titleScr.hide();
        resolve(r);
      };
      this.titleScr.show({
        play: () => done('play'),
        continuePage: opts.continuePage ?? null,
        continue: () => done('continue'),
        daily: opts.daily ?? null,
        playDaily: () => done('daily'),
        settings: () => void this.openSettings(),
        credits: () => void this.openCredits(),
      });
    });
  }

  showHud(): void {
    this.hud.show();
    this.captions.setEnabled(true);
  }

  hideHud(): void {
    this.hud.hide();
    this.captions.setEnabled(false);
    this.hud.tutorial.clear();
  }

  /** Comic cover + stats; resolves when the reader returns to the title. */
  cover(stats: RunStats, opts: { bestTimeS?: number | null } = {}): Promise<void> {
    this.hideHud();
    this.setPaused(false, false);
    return new Promise((resolve) => {
      this.coverScr.show(stats, {
        bestTimeS: opts.bestTimeS,
        credits: () => void this.openCredits(),
        title: () => {
          this.coverScr.hide();
          resolve();
        },
        afterReveal: () => this.offerInstall(),
      });
    });
  }

  openSettings(): Promise<void> {
    return new Promise((r) => this.settingsScr.show(r));
  }

  openCredits(): Promise<void> {
    return new Promise((r) => void this.creditsScr.show(r));
  }

  titleCard(page: PageId): Promise<void> {
    return this.card.show(page);
  }

  /** Death sheet down. Also triggered automatically by `player:died`. */
  reprint(): Promise<void> {
    return this.death.cover();
  }

  /** Death sheet up. Also triggered automatically by `player:respawn`. */
  reprinted(): Promise<void> {
    return this.death.reveal();
  }

  hint(h: Hint, show = true): void {
    if (show) this.hud.showHint(h);
    else this.hud.hideHint(h);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Open/close the pause menu and broadcast `game:pause`. */
  setPaused(paused: boolean, emit = true): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      this.pauseScr.show({
        resume: () => this.setPaused(false),
        settings: () => void this.openSettings(),
        quit: () => {
          this.setPaused(false);
          this.hideHud();
          this.onQuit?.();
        },
      });
    } else {
      this.pauseScr.hide();
      this.settingsScr.hide();
    }
    if (emit) this.bus.emit('game:pause', { paused });
  }

  /** Per frame (allocation-free). */
  update(dt: number): void {
    this.hud.update(dt);
    // Esc / P / gamepad Start (Input latches them; the game loop doesn't poll while paused)
    const input = this.ctx.input;
    if (!input) return;
    if (this.paused) {
      input.poll();
      if (input.state.pausePressed) {
        if (this.settingsScr.visible) this.settingsScr.close();
        else if (this.creditsScr.visible) this.creditsScr.close();
        else {
          this.setPaused(false);
          input.poll(); // clear the edge so the next frame doesn't re-pause
        }
      }
    } else if (input.state.pausePressed && this.hud.visible && !this.death.active) {
      input.poll(); // consume so the next frame doesn't see the same edge
      this.setPaused(true);
    }
  }

  // ───────────────────────── internals ─────────────────────────
  private offerInstall(): void {
    const mode = installMode();
    if (!mode || load<{ v: boolean }>(A2HS_KEY, { v: false }).v) return;
    const remember = () => save(A2HS_KEY, { v: true });
    const host = this.root.querySelector<HTMLElement>('.cover-side');
    if (mode === 'prompt') {
      this.toast(this.t('a2hs.text'), {
        action: {
          label: this.t('a2hs.add'),
          run: () => void promptInstall().then(remember),
        },
        closable: true,
        host,
      });
    } else {
      const parts = this.t('a2hs.ios').split('{icon}');
      const msg = h('span', null, this.t('a2hs.text'), h('br'), parts[0] ?? '');
      msg.insertAdjacentHTML('beforeend', ICON_IOS_SHARE);
      msg.append(parts[1] ?? '');
      const close = this.toast(msg, { closable: true, host });
      setTimeout(() => {
        close();
        remember();
      }, 14000);
    }
  }

  private on<K extends keyof GameEvents>(k: K, fn: (p: GameEvents[K]) => void): void {
    this.offs.push(this.bus.on(k, fn));
  }

  private wire(): void {
    const maxPages = () => this.ctx.tuning?.player.maxPages ?? TUNING.player.maxPages;
    this.on('player:damaged', (e) => {
      this.hud.setPages(e.pagesLeft, maxPages());
      this.haptic(e.pagesLeft > 0 ? 50 : [80, 60, 140]);
    });
    this.on('player:died', () => {
      this.hud.tutorial.clear();
      void this.death.cover();
    });
    this.on('player:respawn', () => {
      this.hud.setPages(maxPages(), maxPages());
      if (this.death.active) void this.death.reveal();
    });
    this.on('checkpoint:reached', () => this.hud.setPages(maxPages(), maxPages()));
    this.on('energy:changed', (e) => this.hud.setEnergy(e.value, e.max));
    this.on('sketch:progress', (e) => this.hud.setPrint(e.t));
    this.on('sketch:printed', () => {
      this.hud.printDone();
      this.hud.hideHint('print');
    });
    this.on('page:start', (e) => {
      // the title screen's live background page must not get a card
      if (this.hud.visible) void this.card.show(e.page);
      if (e.page !== 'boss') this.hud.showBoss(false);
    });
    this.on('boss:phase', (e) => {
      this.hud.setBossPhase(e.phase);
      if (!this.bossExact) {
        this.bossHits = Math.max(this.bossHits, (e.phase - 1) * 3);
        this.hud.setBossHealth(1 - this.bossHits / 9);
      }
    });
    this.on('boss:weakpoint', (e) => {
      if (!e.destroyed || this.bossExact) return;
      this.bossHits = Math.min(9, this.bossHits + 1);
      this.hud.setBossHealth(1 - this.bossHits / 9);
    });
    this.on('boss:health', (e) => {
      this.bossExact = true;
      this.hud.setBossHealth(e.value);
    });
    this.on('boss:defeated', () => {
      this.hud.setBossHealth(0);
      setTimeout(() => this.hud.showBoss(false), 1400);
      this.bossHits = 0;
      this.bossExact = false;
    });
    this.on('ui:tutorial', (e) => this.hint(e.hint, e.show));
    this.on('crystal:hold', (e) => {
      clearTimeout(this.hintTimer.get('crystal'));
      if (e.held)
        this.hintTimer.set(
          'crystal',
          window.setTimeout(() => this.hud.hideHint('crystal'), 450),
        );
    });
    this.on('bolt:fire', () => this.hud.hideHint('bolt'));
    this.on('player:dash', () => this.hud.hideHint('dash'));
    this.on('game:pause', (e) => this.setPaused(e.paused, false));
    this.on('settings:changed', (e) => this.apply(e.key as keyof Settings | 'all'));

    const onVis = () => {
      if (document.hidden && this.hud.visible && !this.paused && !this.death.active) this.setPaused(true);
    };
    document.addEventListener('visibilitychange', onVis);
    this.offs.push(() => document.removeEventListener('visibilitychange', onVis));
  }

  private applyAll(): void {
    this.apply('all');
  }

  private apply(key: keyof Settings | 'all'): void {
    const s = this.settings.value;
    const all = key === 'all';
    const push = this.opts.applySettings !== false;
    const c = this.ctx;
    if (all || key === 'master' || key === 'music' || key === 'sfx') {
      if (push) c.audio?.setVolumes({ master: s.master, music: s.music, sfx: s.sfx });
    }
    if (all || key === 'leftHanded') {
      if (push) c.input?.setLeftHanded(s.leftHanded);
      this.hud.el.classList.toggle('left-handed', s.leftHanded);
    }
    if (all || key === 'reduceMotion') {
      document.documentElement.classList.toggle('reduce-motion', s.reduceMotion);
      if (push) c.render?.setReduceMotion(s.reduceMotion);
    }
    if ((all || key === 'misregistration') && push) c.render?.setMisregistration(s.misregistration);
    if ((all || key === 'quality') && push) c.render?.setQuality(s.quality);
    if (all || key === 'lang') {
      this.i18n.setLang(s.lang);
      if (!all) this.refreshText();
    }
  }

  private refreshText(): void {
    for (const scr of [
      this.loading,
      this.titleScr,
      this.pauseScr,
      this.settingsScr,
      this.creditsScr,
      this.coverScr,
      this.card,
    ]) {
      scr.refresh();
    }
    this.hud.refreshText();
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.hud.dispose();
    this.captions.dispose();
    this.toasts.el.remove();
    for (const scr of [
      this.loading,
      this.titleScr,
      this.pauseScr,
      this.settingsScr,
      this.creditsScr,
      this.coverScr,
    ]) {
      (scr as { hide(): void }).hide();
    }
  }
}

/** Build the UI into #ui-root and wire it to the game context. Sets `ctx.t`. */
export function install(ctx: UIContext, opts?: UIOptions): UI {
  return new UI(ctx, opts);
}
