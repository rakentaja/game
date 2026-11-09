/**
 * Editor's Red Pen — an ULTRAKILL-style style meter written in the margin. Combat events earn
 * points scaled by the action's *freshness*: repeating the same move makes it stale (each use
 * multiplies its freshness by `staleMul`), variety lets it recover. The score decays over time
 * (faster at higher grades) and taking damage costs a chunk. Grades D..P go out as `style:grade`.
 *
 * `StyleMeter` is pure (unit-tested); `installStyle` wires it to the event bus and RunStats.
 */
import type { EventBus, GameEvents } from '../core/events';
import type { GameContext, RunStats } from '../core/types';
import type { Tuning } from '../data/tuning';

export type StyleAction = 'bolt' | 'crit' | 'nib' | 'lasso' | 'parry' | 'flare' | 'onBeat';
export type StyleGrade = 'D' | 'C' | 'B' | 'A' | 'S' | 'P';

export const STYLE_ACTIONS: readonly StyleAction[] = [
  'bolt',
  'crit',
  'nib',
  'lasso',
  'parry',
  'flare',
  'onBeat',
];
export const STYLE_GRADES: readonly StyleGrade[] = ['D', 'C', 'B', 'A', 'S', 'P'];

type StyleTuning = Tuning['combatPlus']['style'];

export class StyleMeter {
  /** Current (decaying) meter value. */
  score = 0;
  /** Points earned this run (never decays) — the final score. */
  total = 0;
  /** Best grade index reached. */
  best = 0;
  readonly fresh: Record<StyleAction, number> = {
    bolt: 1,
    crit: 1,
    nib: 1,
    lasso: 1,
    parry: 1,
    flare: 1,
    onBeat: 1,
  };

  constructor(private cfg: () => StyleTuning) {}

  get gradeIndex(): number {
    const g = this.cfg().grades;
    let i = 0;
    for (let k = 1; k < g.length; k++) if (this.score >= g[k]!) i = k;
    return i;
  }

  get grade(): StyleGrade {
    return STYLE_GRADES[this.gradeIndex]!;
  }

  /** Award an action; returns the points earned. `mult` scales it (e.g. lasso catching 3). */
  add(action: StyleAction, mult = 1): number {
    const c = this.cfg();
    const f = this.fresh[action];
    const pts = c.points[action] * f * mult;
    this.fresh[action] = Math.max(c.minFresh, f * c.staleMul);
    this.score = Math.min(c.max, this.score + pts);
    this.total += pts;
    this.best = Math.max(this.best, this.gradeIndex);
    return pts;
  }

  damaged(): void {
    this.score = Math.max(0, this.score - this.cfg().damagePenalty);
  }

  update(dt: number): void {
    const c = this.cfg();
    if (this.score > 0) {
      const rate = c.decayPerSec * (1 + this.gradeIndex * c.decayPerGrade);
      this.score = Math.max(0, this.score - rate * dt);
    }
    for (const a of STYLE_ACTIONS) {
      const f = this.fresh[a];
      if (f < 1) this.fresh[a] = Math.min(1, f + c.freshRegen * dt);
    }
  }

  reset(): void {
    this.score = 0;
    this.total = 0;
    this.best = 0;
    for (const a of STYLE_ACTIONS) this.fresh[a] = 1;
  }
}

/** Event wiring: feeds the meter, emits `style:grade` on change, writes RunStats. */
export class StyleSystem {
  readonly meter: StyleMeter;
  private lastGrade = -1;
  private offs: (() => void)[] = [];

  constructor(
    private events: EventBus<GameEvents>,
    tuning: Tuning,
    private stats?: RunStats,
  ) {
    this.meter = new StyleMeter(() => tuning.combatPlus.style);
    const m = this.meter;
    const ev = events;
    this.offs.push(
      ev.on('bolt:hit', (e) => {
        if (e.critical) m.add('crit');
        else if (e.kill) m.add('bolt');
      }),
      ev.on('combat:nib', (e) => {
        m.add('nib', e.kill ? 1 : 0.5);
      }),
      ev.on('combat:lasso', (e) => {
        m.add('lasso', Math.min(3, Math.max(1, e.ids.length)));
      }),
      ev.on('combat:parry', () => {
        m.add('parry');
      }),
      ev.on('crystal:flare', (e) => {
        if (e.caught > 0) m.add('flare', Math.min(3, e.caught));
      }),
      ev.on('combat:onBeat', () => {
        m.add('onBeat');
      }),
      ev.on('player:damaged', () => m.damaged()),
    );
    this.sync();
  }

  step(dt: number): void {
    this.meter.update(dt);
    this.sync();
  }

  /** New run: zero the meter (RunStats is reset by the game). */
  reset(): void {
    this.meter.reset();
    this.lastGrade = -1;
    this.sync();
  }

  dispose(): void {
    for (const o of this.offs) o();
    this.offs.length = 0;
  }

  private sync(): void {
    const m = this.meter;
    const st = this.stats;
    if (st) {
      st.styleScore = Math.round(m.total);
      st.styleGrade = STYLE_GRADES[m.best]!;
    }
    const g = m.gradeIndex;
    if (g === this.lastGrade) return;
    this.lastGrade = g;
    this.events.emit('style:grade', { grade: STYLE_GRADES[g]!, score: Math.round(m.score) });
  }
}

export function installStyle(ctx: Pick<GameContext, 'events' | 'tuning' | 'stats'>): StyleSystem {
  return new StyleSystem(ctx.events, ctx.tuning, ctx.stats);
}
