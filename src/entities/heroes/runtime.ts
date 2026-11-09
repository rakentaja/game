/**
 * Hero runtime (initial bundle, small): picks + loads the local hero kit, offers the per-page perk
 * card, feeds the Splash meter HUD, and tells the kit what can be printed. The HUD and the
 * non-Inker kits are lazy chunks.
 *
 * Game wiring:  const heroes = installHeroes(ctx, player);
 *               await heroes.prepare();          // newRun (loads the chosen kit, resets perks)
 *               heroes.pageStarted(page, level); // startPage (perk card, print spots)
 */
import type { EventBus, GameEvents } from '../../core/events';
import { FLAGS } from '../../core/flags';
import type { Damageable, GameContext, HeroId, PageId, Vec3T } from '../../core/types';
import type { Player } from '../Player';
import type { PrintSpot } from './HeroKit';
import { isHeroId, perkOptions } from './perks';
import { loadKit, rememberHero, selectedHero } from './registry';

export interface HeroLevel {
  sketches: readonly { id: string; at: Vec3T }[];
  isPrinted(id: string): boolean;
  isEnabled(id: string): boolean;
}

/** What the lazily loaded HUD module implements (src/ui/hud/hero.ts). */
export interface HeroHudAPI {
  setSplash(v: number): void;
  setHero(id: HeroId): void;
  /** Show a 2-option perk card; resolves with the pick (auto-picks after `autoS`). */
  perk(hero: HeroId, options: readonly [string, string], autoS: number): Promise<string>;
  setVisible(v: boolean): void;
  dispose(): void;
}

type HudModule = { createHeroHud(ctx: GameContext): HeroHudAPI };
let hudModule: Promise<HudModule> | null = null;

export class HeroRuntime {
  hero: HeroId = 'inker';
  private hud: HeroHudAPI | null = null;
  private level: HeroLevel | null = null;
  private spots: PrintSpot[] = [];
  private spotPool: PrintSpot[] = [];
  private offered = new Set<PageId>();
  private offs: (() => void)[] = [];
  private loading: Promise<void> | null = null;
  /** Hero the co-op lobby picked for this machine's wizard (wins over `?hero=` / storage). */
  private coopHero: HeroId | null = null;
  /** Extra wizards on this machine (local 2P): they get their own perk card after player 1. */
  private readonly locals: Player[] = [];

  constructor(
    private ctx: GameContext,
    private player: Player,
  ) {
    player.printSpots = () => this.collectSpots();
    const ev: EventBus<GameEvents> = ctx.events;
    this.offs.push(
      ev.on('splash:changed', (e) => {
        if (e.pid === this.player.slot) this.hud?.setSplash(e.value);
      }),
      // co-op: the lobby decided our hero (pair combos are installed by the co-op runtime)
      ev.on('coop:start', (e) => {
        const h = e.heroes[e.slot];
        if (isHeroId(h)) {
          rememberHero(h);
          this.coopHero = h;
          void this.prepare(h);
        }
      }),
    );
  }

  /** Another wizard on this machine (local 2P player 2): per-player perk cards. */
  addLocal(p: Player): () => void {
    this.locals.push(p);
    return () => {
      const i = this.locals.indexOf(p);
      if (i >= 0) this.locals.splice(i, 1);
    };
  }

  /** Load + install the chosen hero kit (resets perks and the Splash meter: a fresh run). */
  prepare(hero: HeroId = this.coopHero ?? selectedHero()): Promise<void> {
    this.loading = (async () => {
      const make = await loadKit(hero);
      const p = this.player;
      if (p.kit.id !== hero) p.setKit(make());
      p.kit.resetPerks();
      p.splash.reset(0);
      for (const q of this.locals) {
        q.kit.resetPerks();
        q.splash.reset(0);
      }
      this.hero = p.kit.id;
      this.offered.clear();
      this.hud?.setHero(this.hero);
    })();
    return this.loading;
  }

  /** A gameplay page started: print spots + (once per page per run) the perk card. */
  pageStarted(page: PageId, level: HeroLevel | null): void {
    this.level = level;
    void this.ensureHud().then((hud) => {
      hud.setHero(this.hero);
      hud.setVisible(true);
      hud.setSplash(this.player.splash.value);
      this.offerPerk(page);
    });
  }

  hide(): void {
    this.hud?.setVisible(false);
    this.level = null;
  }

  private async offerPerk(page: PageId): Promise<void> {
    if (this.offered.has(page)) return;
    this.offered.add(page);
    for (const p of [this.player, ...this.locals]) {
      const hero = p.kit.id;
      const opts = perkOptions(hero, page);
      if (!opts || !this.hud) continue;
      const pick = await this.hud.perk(hero, opts, FLAGS.autoplay ? 0.6 : 12);
      const kit = p.kit;
      if (kit.id !== hero || kit.perks.has(pick)) continue;
      kit.applyPerk(pick);
      // co-op replicates it so the partner's puppet of this kit plays the perk too
      this.ctx.events.emit('hero:perk', { pid: p.slot, hero, perk: pick });
    }
  }

  private ensureHud(): Promise<HeroHudAPI> {
    if (this.hud) return Promise.resolve(this.hud);
    hudModule ??= import('../../ui/hud/hero');
    return hudModule.then((m) => {
      this.hud ??= m.createHeroHud(this.ctx);
      return this.hud;
    });
  }

  private k = 0;
  private take(x: number, z: number): void {
    const s = this.spotPool[this.k] ?? { x: 0, z: 0 };
    this.spotPool[this.k++] = s;
    s.x = x;
    s.z = z;
    this.spots.push(s);
  }
  private readonly scanWp = (t: Damageable) => {
    if (t.alive && (t as { kind?: string }).kind === undefined) this.take(t.position.x, t.position.z);
  };

  /** Unprinted, enabled sketches + live boss weak points (allocation-free). */
  private collectSpots(): readonly PrintSpot[] {
    this.spots.length = 0;
    this.k = 0;
    const L = this.level;
    if (L)
      for (const s of L.sketches) if (!L.isPrinted(s.id) && L.isEnabled(s.id)) this.take(s.at[0], s.at[2]);
    this.ctx.targets.forEach(this.scanWp);
    return this.spots;
  }

  dispose(): void {
    for (const o of this.offs) o();
    this.offs.length = 0;
    this.hud?.dispose();
    this.hud = null;
  }
}

export function installHeroes(ctx: GameContext, player: Player): HeroRuntime {
  return new HeroRuntime(ctx, player);
}
