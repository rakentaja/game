/**
 * World-meta runtime (one per game, survives page changes): Daily Issue mode + rules, the
 * narrator's CaptionDirector and its threat effects, and the Ghost Inker recorder/playback.
 *
 * Game wiring:
 *   const meta = installMeta(ctx, { dropInk });
 *   meta.startRun('daily' | 'main', date?)    before the first page
 *   def = meta.levelFor(page)                  instead of getLevel(page)
 *   meta.attachPage(page)                      after level.start()
 *   meta.step(dt, playing)                     every sim step
 *   meta.runComplete(timeS)                    on the cover (daily best)
 */
import { loadDailyBest, recordDailyBest } from '../../core/storage';
import type { CaptionEffect, GameContext, LevelDef, PageId } from '../../core/types';
import { TUNING } from '../../data/tuning';
import { getLevel } from '../levels';
import { CaptionDirector } from './CaptionDirector';
import { type DailyInfo, dailyInfo, isoDate } from './daily';
import type { dailyLevel as DailyLevelFn } from './daily-level';
import { GhostRecorder, type GhostTrack, loadGhost, saveGhostIfBest } from './ghost';
import type { GhostInker } from './ghost-inker';

// Daily variants and the ghost silhouette are lazy chunks (most runs need neither)
let dailyLevelFn: typeof DailyLevelFn | null = null;
let dailyMod: Promise<void> | null = null;
function loadDaily(): Promise<void> {
  dailyMod ??= import('./daily-level').then((m) => {
    dailyLevelFn = m.dailyLevel;
  });
  return dailyMod;
}

import { RUN_MODS, resetRunMods } from './mods';

export interface MetaOptions {
  /** Spawn ink pickups at a point (Daily "every kill prints ink puddles"). */
  dropInk?: (x: number, z: number, amount: number) => void;
}

interface Threat {
  id: string;
  effect: CaptionEffect;
  t: number;
  delay: number;
}

interface CapReveal {
  capRadius?(r: number, seconds: number): void;
}

export class MetaRuntime {
  mode: 'main' | 'daily' = 'main';
  daily: DailyInfo | null = null;
  readonly director: CaptionDirector;
  private readonly rec = new GhostRecorder();
  private ghost: GhostInker | null = null;
  private ghostLoading = false;
  private ghostTrack: GhostTrack | null = null;
  private page: PageId | null = null;
  private pageTime = 0;
  private threats: Threat[] = [];
  private seq = 0;
  private sinceCaption = 99;
  private fogT = 0;
  private fogBase: [number, number] = [0, 0];
  private readonly levelCache = new Map<string, LevelDef>();
  private readonly offs: (() => void)[] = [];
  private readonly showPayload = { id: '', key: '' } as {
    id: string;
    key: string;
    effect?: CaptionEffect;
    delay?: number;
  };

  constructor(
    private readonly ctx: GameContext,
    private readonly opts: MetaOptions = {},
  ) {
    this.director = new CaptionDirector({
      story: () => ctx.settings.difficulty === 'story',
      busy: () => this.threats.length > 0 || this.sinceCaption < TUNING.worldMeta.captions.showS,
    });
    const ev = ctx.events;
    this.offs.push(
      ev.on('enemy:died', (e) => {
        if (this.page === null) return;
        this.director.note('kill');
        if (RUN_MODS.killInk > 0) this.opts.dropInk?.(e.position[0], e.position[2], RUN_MODS.killInk);
      }),
      ev.on('player:damaged', (e) => {
        if (this.page !== null) this.director.note('damage', e.pagesLeft);
      }),
      ev.on('caption:show', () => {
        this.sinceCaption = 0;
      }),
      ev.on('caption:cancel', (e) => {
        const i = this.threats.findIndex((t) => t.id === e.id);
        if (i >= 0) this.threats.splice(i, 1);
      }),
      ev.on('page:complete', (e) => {
        if (this.page === null || e.page !== this.page) return;
        saveGhostIfBest(this.ghostSlot, e.page, this.rec.track());
      }),
    );
  }

  /** Begin a run. `date` (YYYY-MM-DD) selects the Daily Issue; defaults to today. */
  startRun(mode: 'main' | 'daily', date?: string): void {
    this.mode = mode;
    this.daily = mode === 'daily' ? dailyInfo(date ?? isoDate(new Date())) : null;
    resetRunMods();
    switch (this.daily?.rule) {
      case 'inkPuddles':
        RUN_MODS.killInk = 8;
        RUN_MODS.killStampMul = 1.6;
        break;
      case 'longMemory':
        RUN_MODS.reclaimMul = 0;
        RUN_MODS.killStampMul = 1.4;
        break;
      default:
        break;
    }
    this.director.startRun();
  }

  /** Resolves once the current mode's lazy modules (Daily variants) are loaded. */
  ready(): Promise<void> {
    return this.daily ? loadDaily().catch((e) => console.warn('daily module failed', e)) : Promise.resolve();
  }

  /** The LevelDef to build for `page` in the current mode (daily variants are cached). */
  levelFor(page: PageId): LevelDef {
    const base = getLevel(page);
    const d = this.daily;
    if (!d) return base;
    const k = `${d.key}:${page}`;
    let def = this.levelCache.get(k);
    if (!def) {
      if (!dailyLevelFn) {
        void loadDaily();
        return base;
      }
      try {
        def = dailyLevelFn(base, d);
      } catch (e) {
        console.warn('daily variant failed, using the authored page', e);
        def = base;
      }
      this.levelCache.set(k, def);
    }
    return def;
  }

  get ghostSlot(): string {
    return this.daily ? `d${this.daily.key}` : 'main';
  }

  get ghostEnabled(): boolean {
    const g = this.ctx.settings.ghost ?? 'daily';
    return g === 'always' || (g === 'daily' && this.mode === 'daily');
  }

  /** A playable page just started (after level.start). */
  attachPage(page: PageId): void {
    this.page = page;
    this.pageTime = 0;
    this.rec.reset();
    for (const t of this.threats) this.ctx.events.emit('caption:cancel', { id: t.id });
    this.threats.length = 0;
    this.fogT = 0;
    this.director.pageStart(page);
    this.ghostTrack = this.ghostEnabled ? loadGhost(this.ghostSlot, page) : null;
    if (this.ghostTrack && !this.ghost && !this.ghostLoading) {
      this.ghostLoading = true;
      void import('./ghost-inker').then((m) => {
        this.ghost ??= new m.GhostInker(this.ctx);
        this.ghost.setTrack(this.page !== null ? this.ghostTrack : null);
      });
    }
    this.ghost?.setTrack(this.ghostTrack);
    if (this.daily) {
      this.caption(`daily.rule.${this.daily.rule}`);
      this.director.markShown('daily');
    }
  }

  /** Leaving play (title / cover). */
  detachPage(): void {
    this.page = null;
    this.ghostTrack = null;
    this.ghost?.setTrack(null);
    for (const t of this.threats) this.ctx.events.emit('caption:cancel', { id: t.id });
    this.threats.length = 0;
  }

  /** Emit a caption; returns its id. */
  caption(key: string, effect?: CaptionEffect, delay?: number): string {
    const id = `cap${++this.seq}`;
    const p = this.showPayload;
    p.id = id;
    p.key = key;
    p.effect = effect;
    p.delay = delay;
    if (effect) this.threats.push({ id, effect, t: 0, delay: delay ?? 0 });
    this.ctx.events.emit('caption:show', p);
    return id;
  }

  step(dt: number, playing: boolean): void {
    this.sinceCaption += dt;
    this.stepFog(dt);
    const p = this.ctx.player;
    if (!playing || this.page === null || !p) return;
    this.pageTime += dt;
    const yaw = Math.atan2(p.facing.x, p.facing.z);
    this.rec.step(dt, p.position.x, p.position.z, yaw);
    this.ghost?.update(this.pageTime, p.position.x, p.position.z);

    for (let i = this.threats.length - 1; i >= 0; i--) {
      const t = this.threats[i]!;
      t.t += dt;
      if (t.t >= t.delay) {
        this.threats.splice(i, 1);
        this.ctx.events.emit('caption:effect', { id: t.id, effect: t.effect });
        this.applyEffect(t.effect);
      }
    }

    const v = p.velocity;
    const req = this.director.update(dt, {
      active: v.x * v.x + v.z * v.z > 0.09 || p.crystalHeld,
      energyFrac: p.energy / Math.max(1, TUNING.energy.max),
    });
    if (req) this.caption(req.key, req.effect, req.delay);
  }

  applyEffect(effect: CaptionEffect): void {
    const C = TUNING.worldMeta.captions;
    const ctx = this.ctx;
    switch (effect) {
      case 'crystalOut':
        (ctx.reveal as CapReveal).capRadius?.(C.crystalOutRadius, C.crystalOutS);
        break;
      case 'fogIn': {
        const sh = ctx.render.shared;
        if (!sh.uFogNear || !sh.uFogFar) break;
        if (this.fogT <= 0) this.fogBase = [sh.uFogNear.value as number, sh.uFogFar.value as number];
        this.fogT = C.fogInS;
        break;
      }
      case 'inkDrought': {
        const p = ctx.player;
        if (!p) break;
        // only where the energy store accepts negative adds; otherwise the threat is empty
        p.addEnergy(-C.inkDrought);
        break;
      }
      default:
        // ghostsHaste: the event is the effect (enemies listen to caption:effect)
        break;
    }
  }

  private stepFog(dt: number): void {
    if (this.fogT <= 0) return;
    const C = TUNING.worldMeta.captions;
    this.fogT -= dt;
    const sh = this.ctx.render.shared;
    const elapsed = C.fogInS - this.fogT;
    const inK = Math.min(1, elapsed / 0.8);
    const outK = Math.min(1, Math.max(0, this.fogT) / 1.2);
    const k = Math.min(inK, outK);
    const m = 1 - (1 - C.fogInMul) * k * k * (3 - 2 * k);
    if (sh.uFogNear) sh.uFogNear.value = this.fogBase[0] * m;
    if (sh.uFogFar) sh.uFogFar.value = this.fogBase[1] * (0.4 + 0.6 * m);
    if (this.fogT <= 0) {
      if (sh.uFogNear) sh.uFogNear.value = this.fogBase[0];
      if (sh.uFogFar) sh.uFogFar.value = this.fogBase[1];
    }
  }

  /** Daily bookkeeping on the cover. Null for normal runs. */
  runComplete(timeS: number): { best: number; improved: boolean } | null {
    return this.daily ? recordDailyBest(this.daily.key, timeS) : null;
  }

  /** Title screen entry data for today's (or ?daily=) issue. */
  dailyEntry(date?: string): { number: number; ruleKey: string; bestS: number | null; date: string } {
    const d = dailyInfo(date ?? isoDate(new Date()));
    return { number: d.number, ruleKey: `daily.rule.${d.rule}`, bestS: loadDailyBest(d.key), date: d.date };
  }

  dispose(): void {
    for (const o of this.offs) o();
    this.ghost?.dispose();
  }
}

export function installMeta(ctx: GameContext, opts?: MetaOptions): MetaRuntime {
  return new MetaRuntime(ctx, opts);
}
