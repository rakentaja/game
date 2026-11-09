/**
 * The Editor Writes Back — the narrator's caption director. Pure logic: feed it game moments
 * (`note`) and a per-step snapshot (`update`); it answers with at most one caption request,
 * honouring a global cooldown, per-category cooldowns and priorities. Threat captions (with an
 * effect the player can scratch out) are rare: never early in a page, at most one per page,
 * never on Story's first page, never on the boss page.
 */
import type { CaptionEffect, PageId } from '../../core/types';
import { TUNING } from '../../data/tuning';

export type CaptionCategory = 'nearDeath' | 'firstKill' | 'damage' | 'lowInk' | 'idle' | 'multiKill';

/** Lines per category in i18n (`caption.<category>.<n>`). Keep in sync with en/tr.json. */
export const CAPTION_LINES: Record<CaptionCategory, number> = {
  nearDeath: 3,
  firstKill: 3,
  damage: 4,
  lowInk: 3,
  idle: 4,
  multiKill: 2,
};

export const CAPTION_EFFECTS: readonly CaptionEffect[] = ['crystalOut', 'fogIn', 'ghostsHaste', 'inkDrought'];

/** Priority order (first wins when several are pending). */
const ORDER: readonly CaptionCategory[] = ['nearDeath', 'firstKill', 'multiKill', 'damage', 'lowInk', 'idle'];

/** A pending moment older than this is stale and dropped (a comment must land on its moment). */
const PENDING_TTL = 2.5;

export interface CaptionRequest {
  key: string;
  category: CaptionCategory | 'threat';
  effect?: CaptionEffect;
  delay?: number;
}

export interface DirectorSnapshot {
  /** Player is moving / acting this step. */
  active: boolean;
  /** Current ink 0..1. */
  energyFrac: number;
}

export interface DirectorOptions {
  rng?: () => number;
  story?: () => boolean;
  /** Whether a caption is currently on screen (no stacking). */
  busy?: () => boolean;
}

export class CaptionDirector {
  private time = 0;
  private pageTime = 0;
  private page: PageId | null = null;
  private lastAny = Number.NEGATIVE_INFINITY;
  private readonly lastCat = new Map<string, number>();
  private readonly pending = new Map<CaptionCategory, number>();
  private idleT = 0;
  private idleFired = false;
  private lowInk = false;
  private killedThisRun = false;
  private killTimes: number[] = [];
  private threatThisPage = false;
  private threatAcc = 0;
  private readonly rng: () => number;
  private readonly story: () => boolean;
  private readonly busy: () => boolean;
  enabled = true;

  constructor(opts: DirectorOptions = {}) {
    this.rng = opts.rng ?? Math.random;
    this.story = opts.story ?? (() => false);
    this.busy = opts.busy ?? (() => false);
  }

  /** New run: first-kill etc. reset. */
  startRun(): void {
    this.killedThisRun = false;
    this.killTimes.length = 0;
    this.lastCat.clear();
    this.lastAny = Number.NEGATIVE_INFINITY;
  }

  pageStart(page: PageId): void {
    this.page = page;
    this.pageTime = 0;
    this.threatThisPage = false;
    this.threatAcc = 0;
    this.pending.clear();
    this.idleT = 0;
    this.idleFired = false;
    // the page card owns the first seconds
    this.lastAny = Math.max(this.lastAny, this.time - TUNING.worldMeta.captions.globalCooldown + 4);
  }

  /** Something happened worth a remark. */
  note(kind: 'kill' | 'damage', pagesLeft = 99): void {
    if (kind === 'kill') {
      if (!this.killedThisRun) {
        this.killedThisRun = true;
        this.pending.set('firstKill', this.time);
      }
      this.killTimes.push(this.time);
      while (this.killTimes.length && this.time - this.killTimes[0]! > 4) this.killTimes.shift();
      if (this.killTimes.length >= 3) {
        this.pending.set('multiKill', this.time);
        this.killTimes.length = 0;
      }
    } else if (pagesLeft <= 1) this.pending.set('nearDeath', this.time);
    else this.pending.set('damage', this.time);
  }

  /** Mark that the reader just put a caption up from elsewhere (daily rule, story beats). */
  markShown(category = 'external'): void {
    this.lastAny = this.time;
    this.lastCat.set(category, this.time);
  }

  update(dt: number, s: DirectorSnapshot): CaptionRequest | null {
    const C = TUNING.worldMeta.captions;
    this.time += dt;
    this.pageTime += dt;
    // idle: one remark per still spell
    if (s.active) {
      this.idleT = 0;
      this.idleFired = false;
    } else {
      this.idleT += dt;
      if (this.idleT >= C.idleS && !this.idleFired) {
        this.idleFired = true;
        this.pending.set('idle', this.time);
      }
    }
    const lowAt = TUNING.crystal.lowEnergy / Math.max(1, TUNING.energy.max);
    if (!this.lowInk && s.energyFrac <= lowAt) {
      this.lowInk = true;
      this.pending.set('lowInk', this.time);
    } else if (this.lowInk && s.energyFrac > lowAt * 2) this.lowInk = false;

    for (const [k, t] of this.pending) if (this.time - t > PENDING_TTL) this.pending.delete(k);
    if (!this.enabled || this.page === null) return null;
    if (this.busy()) return null;
    if (this.time - this.lastAny < C.globalCooldown) return null;

    // threat: roll once per second
    this.threatAcc += dt;
    while (this.threatAcc >= 1) {
      this.threatAcc -= 1;
      if (this.threatAllowed() && this.rng() < C.threatChancePerMin / 60) {
        this.threatThisPage = true;
        const effect =
          CAPTION_EFFECTS[Math.floor(this.rng() * CAPTION_EFFECTS.length) % CAPTION_EFFECTS.length]!;
        this.lastAny = this.time;
        this.lastCat.set('threat', this.time);
        this.pending.clear();
        return { key: `caption.threat.${effect}`, category: 'threat', effect, delay: C.threatDelay };
      }
    }

    for (const cat of ORDER) {
      if (!this.pending.has(cat)) continue;
      const last = this.lastCat.get(cat) ?? Number.NEGATIVE_INFINITY;
      if (this.time - last < C.categoryCooldown) {
        this.pending.delete(cat);
        continue;
      }
      this.pending.clear();
      this.lastAny = this.time;
      this.lastCat.set(cat, this.time);
      const n = Math.floor(this.rng() * CAPTION_LINES[cat]) % CAPTION_LINES[cat];
      return { key: `caption.${cat}.${n}`, category: cat };
    }
    return null;
  }

  private threatAllowed(): boolean {
    const C = TUNING.worldMeta.captions;
    if (this.threatThisPage || this.page === 'boss') return false;
    if (this.story() && this.page === 1) return false;
    if (this.pageTime < C.threatMinPageS) return false;
    const last = this.lastCat.get('threat') ?? Number.NEGATIVE_INFINITY;
    return this.time - last >= C.categoryCooldown * 2;
  }
}
