/**
 * THE EDITOR — pure fight logic (no three.js, no DOM). Fully deterministic for a given seed.
 *
 * The FSM owns: phase flow, attack scheduling + lane geometry, player hit tests, weak-point state
 * (hp / exposure / printing), ghost spawn requests, the Blank Page level and the death timer.
 * Side effects go through an `EditorSink`; the visual rig reads the public state every frame.
 *
 *   dormant → intro → phase 1 "Erase" → transition → phase 2 "Redraw" → transition
 *           → phase 3 "Blank Page" → dying → dead
 *
 * Pacing: phase durations in TUNING are *targets* produced by exposure windows, not timers.
 *  - P1: arm weak points are only exposed while the slamming arm is pinned (recover), and each
 *        weak point takes one hit per window (it flinches shut).
 *  - P2: one sketched weak point at a time is drawn in, must be printed (crystal held ≥ printRadius
 *        within printRadius for printHold s), then shot; it un-prints after printedLife.
 *  - P3: the core is exposed only while the Editor bows after every `bowEvery` sweeps; each hit
 *        staggers it and ends the window.
 * After a phase's target duration, damage is multiplied (anti-stall, never softlocks).
 *
 * Idea Ledger rework (wave 1):
 *  - Rewrites: every transition into P2 / P3 redraws the arena (reveal re-inked, new rim strips
 *    erased) and cuts one player verb for `rewrite.cutTime` s (`onRewrite(verb, true)`). A pencil
 *    sketch of the verb's icon appears in the arena; printing it (crystal hold, like P2 weak
 *    points) restores the verb early. Story cuts shorter and never cuts a survival verb.
 *  - P1 drag strikes erase music stems cyclically; P2 prints restore them (`onEraseStem`).
 *  - P2: the free left hand draws roster enemies into the arena (`onSummonStart` → `onSpawn`).
 *  - `windingUp` is true while any attack (or a summon drawing) telegraphs (Close-Up Crits).
 *  - Player input is array-capable (co-op prep): attacks aim at the nearest / alternating player.
 */
import type { Difficulty, EnemyKind, PlayerVerb } from '../../core/types';
import type { Tuning } from '../../data/tuning';

export type EditorState = 'dormant' | 'intro' | 'phase' | 'transition' | 'dying' | 'dead';
export type BossPhase = 1 | 2 | 3;
export type AttackKind = 'drag' | 'press' | 'stab';
export type AttackStage = 'idle' | 'telegraph' | 'strike' | 'recover';
export type Hand = 'L' | 'R';

export class Attack {
  active = false;
  kind: AttackKind = 'drag';
  stage: AttackStage = 'idle';
  hand: Hand = 'R';
  /** Time in current stage. */
  t = 0;
  telegraph = 1;
  travel = 1;
  recover = 1;
  /** Lane start (slam point) → end (push direction). Circles use a only. */
  ax = 0;
  az = 0;
  bx = 0;
  bz = 0;
  /** Lane half width, or circle radius. */
  hw = 1;
  headX = 0;
  headZ = 0;
  hitDone = false;
  /** Sequence number (monotonic) — lets visuals tell attacks apart without allocating. */
  serial = 0;

  /** 0..1 progress through the current stage. */
  get p(): number {
    const d =
      this.stage === 'telegraph' ? this.telegraph : this.stage === 'strike' ? this.travel : this.recover;
    return d > 0 ? Math.min(1, this.t / d) : 1;
  }
}

/** Where a weak point lives on the rig. The rig resolves anchors to world positions. */
export type WeakAnchor = 'forearmR' | 'wristR' | 'handL' | 'hipL' | 'hipR' | 'coat' | 'core';

export class WeakPointState {
  hp = 0;
  maxHp = 0;
  alive = false;
  /** Targetable right now by game rules (the Damageable additionally checks crystal light in P3). */
  exposed = false;
  /** P2: appear (draw-in) progress 0..1. */
  drawIn = 0;
  /** P2: print progress 0..1. */
  print = 0;
  printed = false;
  printedT = 0;
  /** Already took its hit in the current P1 window. */
  windowHit = false;
  /** Seconds of hit flash / flinch (visual). */
  flash = 0;
  /** World position, written by the rig each frame. */
  x = 0;
  y = 0;
  z = 0;
  constructor(
    readonly index: number,
    readonly phase: BossPhase,
    readonly anchor: WeakAnchor,
    readonly hand: Hand | null,
  ) {}
}

/** One player as the Editor sees it (co-op prep). */
export interface EditorPlayer {
  x: number;
  z: number;
  /** Down / reprinting: never targeted, never hit. */
  down: boolean;
  /** Co-op (wave 2): this player's crystal tip, hold state and current reveal radius. */
  cx?: number;
  cy?: number;
  cz?: number;
  held?: boolean;
  radius?: number;
}

/** Co-op "STET" moment (phase 3): the red pencil circles one player and erases them. */
export class StetState {
  active = false;
  /** Player index being erased. */
  target = 0;
  /** Seconds since the circle was drawn (the final slam lands at tuning.coop.stet.eraseS). */
  t = 0;
  /** 0..1 erase progress (partner holding the crystal on the circle pauses it). */
  erase = 0;
  /** Partner's crystal is on the circle right now ("STET" stamp shows). */
  held = false;
  /** Both players held inside the slam window. */
  parry = false;
  x = 0;
  z = 0;
  /** Monotonic, so visuals/net can tell moments apart. */
  serial = 0;
}

export const MAX_PLAYERS = 4;

export interface EditorInput {
  /** Single-player position (also player 0 whenever `playerCount < 2`). */
  px: number;
  pz: number;
  /**
   * Co-op: when `playerCount >= 2`, `players[0..playerCount)` are used for targeting and hit
   * tests instead of px/pz. Preallocated (MAX_PLAYERS); fill in place, never reallocate.
   * TODO(co-op wave 3): "Two-Page Spread" — with two players on opposite halves of the arena the
   * Editor splits the page: each hand works its own half (one target per hand, see pickTarget).
   * TODO(co-op wave 3): "STET" — a downed partner standing in a printed rewrite sketch can
   * proof-mark a cut verb back for both players (restoreRewrite(true) from a co-op trigger).
   */
  players: EditorPlayer[];
  playerCount: number;
  playerRadius: number;
  cx: number;
  cy: number;
  cz: number;
  crystalHeld: boolean;
  revealRadius: number;
}

/** Side effects. All methods are optional no-ops in `NullSink`. */
export interface EditorSink {
  onIntro(): void;
  /** Phase start (also fired at the *beginning* of a transition into that phase). */
  onPhase(phase: BossPhase): void;
  onAttack(a: Attack, stage: 'telegraph' | 'strike' | 'end'): void;
  onErase(ax: number, az: number, bx: number, bz: number, halfWidth: number): void;
  /** `player` = index into input.players (0 in single player). */
  onPlayerHit(a: Attack, player: number): void;
  onSpawn(kind: EnemyKind, x: number, z: number): void;
  onWeakpointHit(wp: WeakPointState, destroyed: boolean): void;
  onPrintProgress(wp: WeakPointState): void;
  onPrinted(wp: WeakPointState): void;
  onUnprinted(wp: WeakPointState): void;
  onStagger(): void;
  onMusic(level: number): void;
  onDeathStart(): void;
  onDefeated(): void;
  /** Arena redraw at a transition: re-ink the page (the FSM then erases the new strips via onErase). */
  onRedraw(phase: BossPhase): void;
  /** A player verb was cut from the issue (cut) or restored (printed = early via the sketch). */
  onRewrite(verb: PlayerVerb, cut: boolean, printed: boolean): void;
  onRewriteProgress(r: RewriteState): void;
  onEraseStem(stem: number, erased: boolean): void;
  /** P2: the left hand starts drawing an enemy at x,z (spawned via onSpawn after drawTime). */
  onSummonStart(kind: EnemyKind, x: number, z: number): void;
  /** Co-op: "Two-Page Spread" gutter wall up / down (phase 2, two players). Optional. */
  onSpread?(on: boolean): void;
  /** Co-op: "STET" moment lifecycle (`target` = player index). Optional. */
  onStet?(stage: 'start' | 'parry' | 'erased' | 'saved', target: number): void;
}

export class NullSink implements EditorSink {
  onIntro(): void {}
  onPhase(_p: BossPhase): void {}
  onAttack(_a: Attack, _s: 'telegraph' | 'strike' | 'end'): void {}
  onErase(_ax: number, _az: number, _bx: number, _bz: number, _hw: number): void {}
  onPlayerHit(_a: Attack, _p: number): void {}
  onSpawn(_k: EnemyKind, _x: number, _z: number): void {}
  onWeakpointHit(_wp: WeakPointState, _d: boolean): void {}
  onPrintProgress(_wp: WeakPointState): void {}
  onPrinted(_wp: WeakPointState): void {}
  onUnprinted(_wp: WeakPointState): void {}
  onStagger(): void {}
  onMusic(_l: number): void {}
  onDeathStart(): void {}
  onDefeated(): void {}
  onRedraw(_p: BossPhase): void {}
  onRewrite(_v: PlayerVerb, _c: boolean, _pr: boolean): void {}
  onRewriteProgress(_r: RewriteState): void {}
  onEraseStem(_s: number, _e: boolean): void {}
  onSummonStart(_k: EnemyKind, _x: number, _z: number): void {}
}

/** The verb the Editor has cut, and the pencil sketch that prints it back. */
export class RewriteState {
  verb: PlayerVerb | null = null;
  cut = false;
  /** Seconds of cut left. */
  t = 0;
  /** Seconds until the sketch appears (counts through the transition). */
  sketchDelay = 0;
  /** Sketch present in the arena. */
  sketch = false;
  drawIn = 0;
  print = 0;
  x = 0;
  y = 1;
  z = 0;
}

/** P2 summon in progress (the left hand drawing an enemy). */
export class SummonState {
  active = false;
  t = 0;
  kind: EnemyKind = 'smudge';
  x = 0;
  z = 0;
  /** Summons drawn this phase. */
  count = 0;
  timer = 0;
}

type RewriteTuning = Tuning['boss']['rewrite'];

/**
 * Which verb a rewrite into `phase` cuts. Never 'crystal' (it prints the restore sketch); on
 * Story never a verb in `storyUnsafe` (falls back to 'print' / 'bolt').
 */
export function pickRewriteVerb(rw: RewriteTuning, phase: 2 | 3, story: boolean): PlayerVerb | null {
  const list = story ? rw.storyRotation : rw.rotation;
  if (!list.length) return null;
  const v = list[(phase - 2) % list.length]!;
  const bad = (x: PlayerVerb) => x === 'crystal' || (story && rw.storyUnsafe.includes(x));
  if (!bad(v)) return v;
  for (const f of ['print', 'bolt'] as const) if (!bad(f)) return f;
  return null;
}

/** mulberry32 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Distance² from point p to segment a-b (XZ). */
export function distSqToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : Math.min(t, 1);
  const qx = ax + dx * t - px;
  const qz = az + dz * t - pz;
  return qx * qx + qz * qz;
}

const MAX_ATTACKS = 3;
export const WP_COUNT = 7;
export const CORE_INDEX = 6;

export class EditorFSM {
  state: EditorState = 'dormant';
  phase: BossPhase = 1;
  /** Time in current state. */
  t = 0;
  /** Gameplay time in the current phase (excludes transitions). */
  phaseTime = 0;
  /** Whole-fight clock from intro start. */
  fightTime = 0;
  /** 0..1 Blank Page level (Editor writes it to reveal.blankPage). */
  blank = 0;
  /** P3: bow window remaining (s) and its 0..1 envelope for the rig. */
  bowT = 0;
  bowAmt = 0;
  /** Stagger (recoil) timer, visual + blocks attacks. */
  staggerT = 0;
  /** Seconds left before the next attack is scheduled. */
  attackTimer = 0;
  attacksThisPhase = 0;
  sweepsDone = 0;
  readonly attacks: Attack[] = [];
  readonly wps: WeakPointState[] = [
    new WeakPointState(0, 1, 'forearmR', 'R'),
    new WeakPointState(1, 1, 'wristR', 'R'),
    new WeakPointState(2, 1, 'handL', 'L'),
    new WeakPointState(3, 2, 'hipL', null),
    new WeakPointState(4, 2, 'coat', null),
    new WeakPointState(5, 2, 'hipR', null),
    new WeakPointState(6, 3, 'core', null),
  ];
  /** P2: index into wps of the sketched point currently in play (-1 none). */
  p2Active = -1;
  p2Gap = 0;
  readonly rewrite = new RewriteState();
  readonly summon = new SummonState();
  /** Co-op "Two-Page Spread": phase 2 with two players splits the arena at `gutterX`. */
  spread = false;
  gutterX = 0;
  readonly stet = new StetState();
  /** Bitmask of erased music stems. */
  stemsErased = 0;
  private stemCursor = 0;
  /** Set by the Editor from settings: slower Blank Page white-out. */
  reduceMotion = false;
  private aimSerial = 0;
  readonly input: EditorInput = {
    px: 0,
    pz: 6,
    players: Array.from({ length: MAX_PLAYERS }, () => ({ x: 0, z: 6, down: false })),
    playerCount: 0,
    playerRadius: 0.35,
    cx: 0,
    cy: 1.8,
    cz: 6,
    crystalHeld: false,
    revealRadius: 3,
  };
  private serial = 0;
  private pendingDouble = false;
  private rng: () => number;

  constructor(
    private tuning: Tuning,
    public difficulty: Difficulty,
    public sink: EditorSink = new NullSink(),
    seed = 1337,
  ) {
    this.rng = makeRng(seed);
    for (let i = 0; i < MAX_ATTACKS; i++) this.attacks.push(new Attack());
  }

  // ───────────── difficulty helpers (read tuning at use time — the debug panel edits it live) ─────────────
  private get story(): boolean {
    return this.difficulty === 'story';
  }
  private mul(k: 'telegraphMul' | 'intervalMul' | 'travelMul' | 'windowMul'): number {
    return this.story ? this.tuning.boss.story[k] : 1;
  }
  private hp(base: number): number {
    return this.story ? Math.max(1, Math.round(base * this.tuning.boss.story.hpMul)) : base;
  }

  get bossX(): number {
    return this.tuning.boss.pos[0];
  }
  get bossZ(): number {
    return this.tuning.boss.pos[1];
  }
  get active(): boolean {
    return this.state === 'intro' || this.state === 'phase' || this.state === 'transition';
  }
  /** Phase-1 weak points left etc. — handy for UI. */
  aliveCount(phase: BossPhase): number {
    let n = 0;
    for (const w of this.wps) if (w.phase === phase && (w.alive || (phase === 2 && w.hp > 0))) n++;
    return n;
  }
  /** Health fraction of the whole fight 1..0 (boss bar). */
  get health(): number {
    if (this.state === 'dying' || this.state === 'dead') return 0;
    let total = 0;
    let left = 0;
    for (const w of this.wps) {
      total += w.maxHp || 1;
      left += w.maxHp ? Math.max(0, w.hp) : 1;
    }
    return total > 0 ? left / total : 1;
  }

  /** True while `verb` is cut from the issue. */
  isCut(verb: PlayerVerb): boolean {
    return this.rewrite.cut && this.rewrite.verb === verb;
  }

  /** The Editor is winding up (any attack telegraphing, or the left hand drawing a summon). */
  get windingUp(): boolean {
    if (!this.active) return false;
    for (const a of this.attacks) if (a.active && a.stage === 'telegraph') return true;
    return this.summon.active;
  }

  get stemCount(): number {
    return Math.max(0, Math.min(16, this.tuning.boss.stems.count | 0));
  }

  // ───────────── lifecycle ─────────────
  /**
   * Give back everything the Editor took from the player / soundtrack (cut verb, erased stems).
   * Safe to call any time; emits only for things actually taken.
   */
  releaseAll(): void {
    this.restoreRewrite(false);
    this.rewrite.sketch = false;
    this.rewrite.sketchDelay = 0;
    this.restoreAllStems();
    this.summon.active = false;
  }

  reset(): void {
    this.releaseAll();
    this.stemCursor = 0;
    this.summon.count = 0;
    this.summon.timer = 0;
    this.state = 'dormant';
    this.phase = 1;
    this.t = 0;
    this.phaseTime = 0;
    this.fightTime = 0;
    this.blank = 0;
    this.bowT = 0;
    this.bowAmt = 0;
    this.staggerT = 0;
    this.attacksThisPhase = 0;
    this.pendingDouble = false;
    this.p2Active = -1;
    this.p2Gap = 0;
    this.setSpread(false);
    this.stet.active = false;
    for (const a of this.attacks) {
      a.active = false;
      a.stage = 'idle';
    }
    const b = this.tuning.boss;
    for (const w of this.wps) {
      const base = w.phase === 1 ? b.phase1.wpHp : w.phase === 2 ? b.phase2.wpHp : b.phase3.hitsToKill;
      w.maxHp = this.hp(base);
      w.hp = w.maxHp;
      w.alive = false;
      w.exposed = false;
      w.drawIn = 0;
      w.print = 0;
      w.printed = false;
      w.printedT = 0;
      w.windowHit = false;
      w.flash = 0;
    }
  }

  start(): void {
    this.reset();
    this.state = 'intro';
    this.t = 0;
    this.sink.onIntro();
    this.sink.onMusic(0.2);
  }

  /** Debug: jump straight into a phase (previous phases count as cleared). */
  jumpTo(phase: BossPhase): void {
    if (this.state === 'dormant' || this.state === 'dead' || this.state === 'dying') this.start();
    for (const w of this.wps) if (w.phase < phase) w.hp = 0;
    this.beginTransition(phase);
  }

  /** Debug: kill now. */
  kill(): void {
    if (!this.active) return;
    this.beginDeath();
  }

  // ───────────── main step ─────────────
  step(dt: number): void {
    if (this.state === 'dormant' || this.state === 'dead') return;
    this.t += dt;
    if (this.state !== 'dying') this.fightTime += dt;
    if (this.state === 'transition' || this.state === 'phase') this.stepRewrite(dt);
    for (const w of this.wps) if (w.flash > 0) w.flash = Math.max(0, w.flash - dt);
    if (this.staggerT > 0) this.staggerT = Math.max(0, this.staggerT - dt);

    switch (this.state) {
      case 'intro':
        if (this.t >= this.tuning.boss.introTime) this.beginTransition(1, true);
        break;
      case 'transition':
        this.stepAttacks(dt, false);
        if (this.phase === 3) {
          const fade =
            this.tuning.boss.phase3.blankFade *
            (this.reduceMotion ? this.tuning.boss.paint.reduceMotionFadeMul : 1);
          this.blank = Math.min(1, this.t / fade);
        }
        if (this.t >= this.tuning.boss.transitionTime) this.beginPhase();
        break;
      case 'phase':
        this.phaseTime += dt;
        this.stepPhase(dt);
        break;
      case 'dying':
        this.bowAmt = Math.max(0, this.bowAmt - dt * 2);
        if (this.t >= this.tuning.boss.deathTime) {
          this.state = 'dead';
          this.t = 0;
          this.sink.onDefeated();
        }
        break;
    }
  }

  private beginTransition(phase: BossPhase, fromIntro = false): void {
    this.setSpread(false);
    this.endStet(false);
    this.phase = phase;
    this.state = 'transition';
    this.t = fromIntro ? this.tuning.boss.transitionTime * 0.55 : 0; // intro already roared
    this.bowT = 0;
    this.staggerT = 0;
    this.pendingDouble = false;
    for (const a of this.attacks) if (a.active && a.stage === 'telegraph') this.endAttack(a);
    for (const w of this.wps) w.exposed = false;
    this.blank = 0;
    this.summon.active = false;
    // Rewrite: pick the verb before onPhase so the panel cut can carry its caption word
    const verb =
      !fromIntro && phase >= 2 && this.tuning.boss.rewrite.enabled
        ? pickRewriteVerb(this.tuning.boss.rewrite, phase as 2 | 3, this.story)
        : null;
    this.restoreRewrite(false);
    if (verb) this.prepareRewrite(verb, phase as 2 | 3);
    this.sink.onPhase(phase);
    this.sink.onMusic(phase === 1 ? 0.4 : phase === 2 ? 0.7 : 1);
    if (phase >= 2) this.redraw(phase);
    if (verb) this.sink.onRewrite(verb, true, false);
  }

  // ───────────── rewrites ─────────────
  private redraw(phase: BossPhase): void {
    this.sink.onRedraw(phase);
    const strips = phase === 2 ? this.tuning.boss.redraw.p2 : this.tuning.boss.redraw.p3;
    for (const s of strips) this.sink.onErase(s[0], s[1], s[2], s[3], s[4]);
  }

  private prepareRewrite(verb: PlayerVerb, phase: 2 | 3): void {
    const rw = this.tuning.boss.rewrite;
    const r = this.rewrite;
    r.verb = verb;
    r.cut = true;
    r.t = this.story ? rw.storyCutTime : rw.cutTime;
    r.sketch = false;
    r.sketchDelay = this.tuning.boss.transitionTime + rw.sketchDelay;
    r.drawIn = 0;
    r.print = 0;
    const pos = rw.sketchPos[(phase - 2) % Math.max(1, rw.sketchPos.length)] ?? [0, 4];
    r.x = pos[0];
    r.z = pos[1];
    r.y = rw.sketchY;
  }

  /** Give the cut verb back (printed = early, via the sketch). No-op when nothing is cut. */
  restoreRewrite(printed: boolean): void {
    const r = this.rewrite;
    if (!r.cut || !r.verb) return;
    r.cut = false;
    r.sketch = false;
    r.t = 0;
    this.sink.onRewrite(r.verb, false, printed);
  }

  private stepRewrite(dt: number): void {
    const r = this.rewrite;
    if (!r.cut) return;
    r.t -= dt;
    if (r.t <= 0) {
      this.restoreRewrite(false);
      return;
    }
    if (!r.sketch) {
      r.sketchDelay -= dt;
      if (r.sketchDelay <= 0) {
        r.sketch = true;
        r.drawIn = 0;
        r.print = 0;
      }
      return;
    }
    const rw = this.tuning.boss.rewrite;
    if (r.drawIn < 1) {
      r.drawIn = Math.min(1, r.drawIn + dt / Math.max(0.05, rw.drawIn));
      return;
    }
    if (this.state !== 'phase') return;
    const i = this.input;
    const dx = i.cx - r.x;
    const dy = i.cy - r.y;
    const dz = i.cz - r.z;
    const inRange = dx * dx + dy * dy + dz * dz <= rw.printRadius * rw.printRadius;
    const charging = i.crystalHeld && i.revealRadius >= rw.printRadius * 0.9 && inRange;
    if (charging) {
      r.print = Math.min(1, r.print + dt / Math.max(0.05, rw.printHold));
      this.sink.onRewriteProgress(r);
    } else r.print = Math.max(0, r.print - dt * rw.printDecay);
    if (r.print >= 1) this.restoreRewrite(true);
  }

  // ───────────── soundtrack stems ─────────────
  private eraseNextStem(): void {
    const n = this.stemCount;
    if (n <= 0) return;
    const stem = this.stemCursor % n;
    this.stemCursor++;
    this.stemsErased |= 1 << stem;
    this.sink.onEraseStem(stem, true);
  }

  /** Restore the lowest erased stem (P2 prints). Returns the stem or -1. */
  private restoreOneStem(): number {
    for (let s = 0; s < this.stemCount; s++)
      if (this.stemsErased & (1 << s)) {
        this.stemsErased &= ~(1 << s);
        this.sink.onEraseStem(s, false);
        return s;
      }
    return -1;
  }

  private restoreAllStems(): void {
    while (this.stemsErased && this.restoreOneStem() >= 0);
    this.stemsErased = 0;
  }

  private beginPhase(): void {
    const b = this.tuning.boss;
    this.state = 'phase';
    this.t = 0;
    this.phaseTime = 0;
    this.attacksThisPhase = 0;
    this.sweepsDone = 0;
    if (this.phase === 3) this.blank = 1;
    for (const w of this.wps) {
      if (w.phase !== this.phase) continue;
      w.hp = w.maxHp;
      w.alive = this.phase !== 2; // P2 points come alive one by one when drawn in
      w.drawIn = 0;
      w.print = 0;
      w.printed = false;
    }
    if (this.phase === 2) {
      // co-op: "Two-Page Spread" — the gutter splits the arena between the two players
      this.setSpread(this.playerTotal >= 2);
      this.p2Active = -1;
      this.p2Gap = 0.6;
      this.summon.active = false;
      this.summon.count = 0;
      this.summon.timer = b.summon.first;
    }
    // the final page has its whole soundtrack back
    if (this.phase === 3) this.restoreAllStems();
    this.attackTimer =
      this.phase === 1
        ? 1.0
        : this.phase === 2
          ? b.phase2.attackInterval * 0.6
          : b.phase3.sweepInterval * 0.5;
  }

  private beginDeath(): void {
    this.setSpread(false);
    this.endStet(false);
    this.releaseAll();
    for (const a of this.attacks) if (a.active) this.endAttack(a);
    for (const w of this.wps) {
      w.exposed = false;
      w.alive = false;
    }
    this.state = 'dying';
    this.t = 0;
    this.bowT = 0;
    this.sink.onMusic(0);
    this.sink.onDeathStart();
  }

  // ───────────── phases ─────────────
  private stepPhase(dt: number): void {
    // Bow envelope (P3)
    if (this.bowT > 0) {
      this.bowT = Math.max(0, this.bowT - dt);
      this.bowAmt = Math.min(1, this.bowAmt + dt * 2.5);
    } else this.bowAmt = Math.max(0, this.bowAmt - dt * 2.2);

    this.stepAttacks(dt, true);

    // Schedule next attack
    const blocked = this.bowT > 0 || this.staggerT > 0 || this.stet.active;
    if (!blocked) {
      this.attackTimer -= dt;
      if (this.attackTimer <= 0 && this.freeAttack()) this.scheduleAttack();
    }

    if (this.phase === 1) this.stepP1();
    else if (this.phase === 2) this.stepP2(dt);
    else {
      this.stepP3();
      this.stepStet(dt);
    }
  }

  // ───────────── co-op moments (wave 2) ─────────────
  private setSpread(on: boolean): void {
    if (on) this.gutterX = this.bossX;
    if (this.spread === on) return;
    this.spread = on;
    this.sink.onSpread?.(on);
  }

  /**
   * Which side of the gutter a point is on (-1 / +1). The Spread splits the arena along the
   * line through the Editor perpendicular to the X axis.
   */
  gutterSide(x: number): -1 | 1 {
    return x < this.gutterX ? -1 : 1;
  }

  /**
   * Is a P2 weak point being charged right now? Solo: the one crystal. Co-op: any standing
   * player's crystal; during the Spread only ink pushed from the OTHER panel counts (the
   * crystal must sit on the opposite side of the gutter, with a little extra reach).
   */
  private p2Charging(w: WeakPointState, reqR: number): boolean {
    if (this.isCut('print')) return false;
    const i = this.input;
    const n = this.playerTotal;
    if (n < 2) {
      const dx = i.cx - w.x;
      const dy = i.cy - w.y;
      const dz = i.cz - w.z;
      return i.crystalHeld && i.revealRadius >= reqR * 0.9 && dx * dx + dy * dy + dz * dz <= reqR * reqR;
    }
    const reach = this.spread ? reqR * this.tuning.coop.spread.crossReach : reqR;
    const side = this.gutterSide(w.x);
    for (let k = 0; k < n; k++) {
      const p = i.players[k]!;
      if (p.down || !p.held || (p.radius ?? 0) < reqR * 0.9) continue;
      const cx = p.cx ?? p.x;
      const cz = p.cz ?? p.z;
      if (this.spread && this.gutterSide(cx) === side) continue;
      const dx = cx - w.x;
      const dy = (p.cy ?? i.cy) - w.y;
      const dz = cz - w.z;
      if (dx * dx + dy * dy + dz * dz <= reach * reach) return true;
    }
    return false;
  }

  /** P3 co-op: start a STET moment on the player the Editor is aiming at. */
  private beginStet(): void {
    const s = this.stet;
    if (s.active || this.playerTotal < 2) return;
    for (let k = 0; k < 2; k++) if (this.playerDown(k)) return;
    s.active = true;
    s.target = this.pickTarget();
    s.t = 0;
    s.erase = 0;
    s.held = false;
    s.parry = false;
    s.serial++;
    s.x = this.playerX(s.target);
    s.z = this.playerZ(s.target);
    this.attackTimer = Math.max(this.attackTimer, this.tuning.coop.stet.eraseS + 1);
    this.sink.onStet?.('start', s.target);
  }

  private stepStet(dt: number): void {
    const s = this.stet;
    if (!s.active) return;
    const S = this.tuning.coop.stet;
    const i = this.input;
    if (this.playerTotal < 2 || this.playerDown(s.target)) {
      this.endStet(false);
      return;
    }
    s.t += dt;
    s.x = this.playerX(s.target);
    s.z = this.playerZ(s.target);
    const partner = i.players[1 - s.target]!;
    const me = i.players[s.target]!;
    const onCircle = (p: EditorPlayer) =>
      !p.down && !!p.held && Math.hypot((p.cx ?? p.x) - s.x, (p.cz ?? p.z) - s.z) <= S.radius + 0.6;
    s.held = onCircle(partner);
    s.erase = s.held ? Math.max(0, s.erase - dt / S.eraseS) : Math.min(1, s.erase + dt / S.eraseS);
    const half = S.slamWindowMs / 2000;
    if (s.t >= S.eraseS - half && s.held && me.held) s.parry = true;
    if (s.t < S.eraseS + half) return;
    if (s.parry) {
      // both inkers held their light through the slam: the eraser bounces into the Editor
      const core = this.wps[CORE_INDEX]!;
      if (core.alive) {
        core.hp = Math.max(0, core.hp - S.parryDamage);
        core.flash = 0.35;
        const destroyed = core.hp <= 0;
        if (destroyed) core.alive = false;
        this.sink.onWeakpointHit(core, destroyed);
        this.staggerT = 1.4;
        if (destroyed) {
          s.active = false;
          this.sink.onStet?.('parry', s.target);
          this.beginDeath();
          return;
        }
      }
      this.sink.onStet?.('parry', s.target);
    } else this.sink.onStet?.(s.erase >= 1 - 1e-6 ? 'erased' : 'saved', s.target);
    s.active = false;
  }

  private endStet(notify: boolean): void {
    if (!this.stet.active) return;
    this.stet.active = false;
    if (notify) this.sink.onStet?.('saved', this.stet.target);
  }

  /**
   * Co-op guest mirror: advance only the attacks the host started (lane geometry arrives as
   * spawn params) so each client tests its own wizard against them. No scheduling, no phases.
   */
  stepPuppet(dt: number): void {
    if (this.state === 'dormant' || this.state === 'dead') return;
    this.t += dt;
    for (const w of this.wps) if (w.flash > 0) w.flash = Math.max(0, w.flash - dt);
    if (this.staggerT > 0) this.staggerT = Math.max(0, this.staggerT - dt);
    if (this.bowT > 0) this.bowAmt = Math.min(1, this.bowAmt + dt * 2.5);
    else this.bowAmt = Math.max(0, this.bowAmt - dt * 2.2);
    this.stepAttacks(dt, false);
    if (this.stet.active) this.stet.t += dt;
  }

  /** Co-op guest mirror: start attack slot `i` from the host's spawn params (`late` s already elapsed). */
  startRemoteAttack(
    i: number,
    kind: AttackKind,
    hand: Hand,
    geo: { ax: number; az: number; bx: number; bz: number; hw: number },
    times: { telegraph: number; travel: number; recover: number },
    late: number,
  ): Attack | null {
    const a = this.attacks[i];
    if (!a) return null;
    if (a.active) this.endAttack(a);
    a.kind = kind;
    a.hand = hand;
    a.ax = geo.ax;
    a.az = geo.az;
    a.bx = geo.bx;
    a.bz = geo.bz;
    a.hw = geo.hw;
    a.telegraph = times.telegraph;
    a.travel = times.travel;
    a.recover = times.recover;
    this.startAttack(a);
    if (late > 0) {
      // catch up the time the message spent on the wire (keeps the strike on the host's beat)
      a.t = Math.min(late, Math.max(0, a.telegraph - 0.05));
    }
    return a;
  }

  /** Co-op guest mirror: end attack slot `i`. */
  endRemoteAttack(i: number): void {
    const a = this.attacks[i];
    if (a?.active) this.endAttack(a);
  }

  private stepP1(): void {
    for (const w of this.wps) {
      if (w.phase !== 1) continue;
      w.exposed = w.alive && !w.windowHit && this.handPinned(w.hand!);
    }
    if (this.aliveCount(1) === 0) this.beginTransition(2);
  }

  private stepSummon(dt: number): void {
    const S = this.tuning.boss.summon;
    const sm = this.summon;
    const kinds = this.story ? S.storyKinds : S.kinds;
    const max = this.story ? S.storyMax : S.max;
    if (sm.active) {
      sm.t += dt;
      if (sm.t >= S.drawTime) {
        sm.active = false;
        sm.timer = S.every * this.mul('intervalMul');
        this.sink.onSpawn(sm.kind, sm.x, sm.z);
      }
      return;
    }
    if (sm.count >= max || !kinds.length || this.staggerT > 0) return;
    sm.timer -= dt;
    if (sm.timer > 0) return;
    // somewhere in the arena's front half, away from the target player
    const [cx, cz] = this.tuning.boss.arena;
    this.pickTarget();
    let x = cx;
    let z = cz;
    for (let k = 0; k < 6; k++) {
      const ang = (this.rng() - 0.5) * Math.PI * 1.3;
      const r = S.minR + this.rng() * (S.maxR - S.minR);
      x = cx + Math.sin(ang) * r;
      z = cz + Math.cos(ang) * r * 0.8;
      if (Math.hypot(x - this.aimX, z - this.aimZ) >= S.awayFromPlayer) break;
    }
    sm.kind = kinds[sm.count % kinds.length]!;
    sm.count++;
    sm.active = true;
    sm.t = 0;
    sm.x = x;
    sm.z = z;
    this.sink.onSummonStart(sm.kind, x, z);
  }

  private stepP2(dt: number): void {
    const p2 = this.tuning.boss.phase2;
    const reqR = p2.printRadius;
    this.stepSummon(dt);
    if (this.p2Active < 0) {
      this.p2Gap -= dt;
      if (this.p2Gap <= 0) {
        const next = this.wps.find((w) => w.phase === 2 && w.hp > 0);
        if (!next) {
          this.beginTransition(3);
          return;
        }
        this.p2Active = next.index;
        next.alive = true;
        next.drawIn = 0;
        next.print = 0;
        next.printed = false;
      }
      return;
    }
    const w = this.wps[this.p2Active]!;
    if (w.drawIn < 1) {
      w.drawIn = Math.min(1, w.drawIn + dt / (p2.drawIn * this.mul('windowMul') ** 0.3));
      w.exposed = false;
      return;
    }
    if (!w.printed) {
      const charging = this.p2Charging(w, reqR);
      const before = w.print;
      if (charging) w.print = Math.min(1, w.print + dt / p2.printHold);
      else w.print = Math.max(0, w.print - dt * p2.printDecay);
      if (w.print !== before && charging) this.sink.onPrintProgress(w);
      if (w.print >= 1) {
        w.printed = true;
        w.printedT = p2.printedLife * this.mul('windowMul');
        this.sink.onPrinted(w);
        this.restoreOneStem();
      }
      w.exposed = false;
    } else {
      w.printedT -= dt;
      w.exposed = true;
      if (w.printedT <= 0) {
        w.printed = false;
        w.print = 0;
        w.exposed = false;
        this.sink.onUnprinted(w);
      }
    }
  }

  private stepP3(): void {
    const core = this.wps[CORE_INDEX]!;
    core.exposed = core.alive && this.bowT > 0 && this.bowAmt > 0.6 && this.staggerT <= 0;
  }

  /** Called by the Damageable wrapper. Returns true if the hit counted. */
  hitWeakpoint(index: number, amount: number): boolean {
    const w = this.wps[index];
    if (!w?.alive || !w.exposed || this.state !== 'phase') return false;
    const b = this.tuning.boss;
    const dur =
      this.phase === 1 ? b.phase1.duration : this.phase === 2 ? b.phase2.duration : b.phase3.duration;
    const mul = this.phase !== 3 && this.phaseTime > dur ? b.overtimeDamageMul : 1;
    const dmg = this.phase === 3 ? 1 : amount * mul;
    w.hp = Math.max(0, w.hp - dmg);
    w.flash = 0.35;
    const destroyed = w.hp <= 0;
    if (this.phase === 1) {
      w.windowHit = true;
      w.exposed = false;
    }
    if (destroyed) {
      w.alive = false;
      w.exposed = false;
    }
    this.sink.onWeakpointHit(w, destroyed);
    if (this.phase === 2 && destroyed) {
      this.p2Active = -1;
      this.p2Gap = 1.4;
    }
    if (this.phase === 3) {
      // Each hit staggers and ends the bow window.
      this.bowT = 0;
      this.staggerT = 1.2;
      w.exposed = false;
      if (destroyed) this.beginDeath();
      else this.sink.onStagger();
    }
    return true;
  }

  // ───────────── players (co-op prep) ─────────────
  /** Aim point chosen by pickTarget() (world XZ). */
  aimX = 0;
  aimZ = 6;
  /** Index of the player the last attack aimed at. */
  aimIndex = 0;

  /** Number of players the Editor considers (≥ 1; px/pz when playerCount < 2). */
  get playerTotal(): number {
    return this.input.playerCount >= 2 ? Math.min(MAX_PLAYERS, this.input.playerCount) : 1;
  }
  playerX(i: number): number {
    return this.input.playerCount >= 2 ? this.input.players[i]!.x : this.input.px;
  }
  playerZ(i: number): number {
    return this.input.playerCount >= 2 ? this.input.players[i]!.z : this.input.pz;
  }
  private playerDown(i: number): boolean {
    return this.input.playerCount >= 2 && this.input.players[i]!.down;
  }

  /**
   * Choose whom the next attack aims at: the single player, else (tuning.boss.coop.targetMode)
   * the nearest standing player to the Editor, or alternate between standing players.
   */
  pickTarget(): number {
    const n = this.playerTotal;
    let idx = 0;
    if (n > 1) {
      if (this.tuning.boss.coop.targetMode === 'alternate') {
        for (let k = 0; k < n; k++) {
          const c = (this.aimSerial + k) % n;
          if (!this.playerDown(c)) {
            idx = c;
            break;
          }
        }
        this.aimSerial = idx + 1;
      } else {
        let best = Number.POSITIVE_INFINITY;
        for (let k = 0; k < n; k++) {
          if (this.playerDown(k)) continue;
          const d = Math.hypot(this.playerX(k) - this.bossX, this.playerZ(k) - this.bossZ);
          if (d < best) {
            best = d;
            idx = k;
          }
        }
      }
    }
    this.aimIndex = idx;
    this.aimX = this.playerX(idx);
    this.aimZ = this.playerZ(idx);
    return idx;
  }

  // ───────────── attacks ─────────────
  private freeAttack(): Attack | null {
    for (const a of this.attacks) if (!a.active) return a;
    return null;
  }

  /** True while an attack using this hand is pinned on the ground. */
  handPinned(hand: Hand): boolean {
    for (const a of this.attacks) if (a.active && a.hand === hand && a.stage === 'recover') return true;
    return false;
  }

  /** The attack the rig should animate for a hand (strike > recover > telegraph). */
  visualAttack(hand: Hand): Attack | null {
    let best: Attack | null = null;
    let score = -1;
    for (const a of this.attacks) {
      if (!a.active || a.hand !== hand) continue;
      const s = a.stage === 'strike' ? 3 : a.stage === 'recover' ? 2 : 1;
      if (s > score) {
        score = s;
        best = a;
      }
    }
    return best;
  }

  private scheduleAttack(): void {
    const b = this.tuning.boss;
    const a = this.freeAttack();
    if (!a) return;
    const n = this.attacksThisPhase++;
    if (this.phase === 1) {
      const p1 = b.phase1;
      const lAlive = this.wps[2]!.alive;
      const rAlive = this.wps[0]!.alive || this.wps[1]!.alive;
      const press = lAlive && (!rAlive || n % 2 === 1);
      if (press) this.setupCircle(a, 'press', 'L', p1.pressRadius, p1.telegraph, p1.recover);
      else this.setupDrag(a, p1.laneHalfWidth, p1.telegraph, p1.travel, p1.recover);
      this.attackTimer = p1.sweepInterval * this.mul('intervalMul');
    } else if (this.phase === 2) {
      const p2 = b.phase2;
      this.setupCircle(a, 'stab', 'R', p2.stabRadius, p2.stabTelegraph, p2.stabRecover);
      this.attackTimer = p2.attackInterval * this.mul('intervalMul');
    } else {
      const p3 = b.phase3;
      this.setupDrag(a, p3.laneHalfWidth, p3.telegraph, p3.travel, p3.recover);
      this.attackTimer = p3.sweepInterval * this.mul('intervalMul');
      if (p3.doubleEvery > 0 && (n + 1) % p3.doubleEvery === 0) this.pendingDouble = true;
    }
    this.startAttack(a);
  }

  private setupDrag(a: Attack, hw: number, tele: number, travel: number, recover: number): void {
    this.pickTarget();
    const [cx, cz, r] = this.tuning.boss.arena;
    let dx = this.aimX - this.bossX;
    let dz = this.aimZ - this.bossZ;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    // small aim jitter so lanes fan out
    const j = (this.rng() - 0.5) * 0.22;
    const c = Math.cos(j);
    const s = Math.sin(j);
    const ux = dx * c - dz * s;
    const uz = dx * s + dz * c;
    a.ax = this.bossX + ux * 2.6;
    a.az = this.bossZ + uz * 2.6;
    // extend past the player to the arena rim
    const ox = a.ax - cx;
    const oz = a.az - cz;
    const bq = ox * ux + oz * uz;
    const cq = ox * ox + oz * oz - r * r;
    const disc = bq * bq - cq;
    const tRim = disc > 0 ? -bq + Math.sqrt(disc) : len + 3;
    const tEnd = Math.min(tRim, len - 2.6 + 4.5);
    a.bx = a.ax + ux * Math.max(4, tEnd);
    a.bz = a.az + uz * Math.max(4, tEnd);
    a.kind = 'drag';
    a.hand = 'R';
    a.hw = hw;
    a.telegraph = tele * this.mul('telegraphMul');
    a.travel = travel * this.mul('travelMul');
    a.recover = recover * this.mul('windowMul');
  }

  private setupCircle(
    a: Attack,
    kind: AttackKind,
    hand: Hand,
    radius: number,
    tele: number,
    recover: number,
  ): void {
    this.pickTarget();
    const [cx, cz, r] = this.tuning.boss.arena;
    let x = this.aimX;
    let z = this.aimZ;
    const ox = x - cx;
    const oz = z - cz;
    const d = Math.hypot(ox, oz);
    if (d > r - radius * 0.5) {
      x = cx + (ox / d) * (r - radius * 0.5);
      z = cz + (oz / d) * (r - radius * 0.5);
    }
    a.kind = kind;
    a.hand = hand;
    a.ax = a.bx = x;
    a.az = a.bz = z;
    a.hw = radius;
    a.telegraph = tele * this.mul('telegraphMul');
    a.travel = 0.12;
    a.recover = recover * this.mul('windowMul');
  }

  private startAttack(a: Attack): void {
    a.active = true;
    a.stage = 'telegraph';
    a.t = 0;
    a.hitDone = false;
    a.headX = a.ax;
    a.headZ = a.az;
    a.serial = ++this.serial;
    if (a.hand === 'R') for (const w of this.wps) if (w.hand === 'R') w.windowHit = false;
    if (a.hand === 'L') for (const w of this.wps) if (w.hand === 'L') w.windowHit = false;
    this.sink.onAttack(a, 'telegraph');
  }

  private endAttack(a: Attack): void {
    if (!a.active) return;
    a.active = false;
    a.stage = 'idle';
    this.sink.onAttack(a, 'end');
  }

  private stepAttacks(dt: number, allowFollowUps: boolean): void {
    for (const a of this.attacks) {
      if (!a.active) continue;
      a.t += dt;
      if (a.stage === 'telegraph') {
        // a second drag waits for the eraser to be free
        if (a.t >= a.telegraph && !(a.kind === 'drag' && this.otherDragBusy(a))) {
          a.stage = 'strike';
          a.t = 0;
          this.sink.onAttack(a, 'strike');
          if (a.kind !== 'drag') this.circleImpact(a);
          else if (this.phase === 1 && this.state === 'phase') this.eraseNextStem();
        }
      } else if (a.stage === 'strike') {
        if (a.kind === 'drag') this.dragStep(a);
        if (a.t >= a.travel) {
          a.stage = 'recover';
          a.t = 0;
          if (a.kind === 'drag') this.afterDrag(a);
          if (allowFollowUps && this.pendingDouble && this.phase === 3) {
            this.pendingDouble = false;
            const b2 = this.freeAttack();
            if (b2) {
              const p3 = this.tuning.boss.phase3;
              this.setupDrag(b2, p3.laneHalfWidth, p3.telegraph * 0.8, p3.travel, p3.recover);
              this.startAttack(b2);
            }
          }
        }
      } else if (a.stage === 'recover') {
        if (a.t >= a.recover) {
          this.endAttack(a);
          if (allowFollowUps && this.phase === 3 && this.state === 'phase') this.maybeBow();
        }
      }
    }
  }

  private otherDragBusy(a: Attack): boolean {
    for (const o of this.attacks)
      if (o !== a && o.active && o.kind === 'drag' && (o.stage === 'strike' || o.stage === 'recover'))
        return o.serial < a.serial;
    return false;
  }

  private dragStep(a: Attack): void {
    const k = a.p;
    const e = k * k * (3 - 2 * k); // smoothstep: slam, accelerate, settle
    const nx = a.ax + (a.bx - a.ax) * e;
    const nz = a.az + (a.bz - a.az) * e;
    if (!a.hitDone) {
      const rr = a.hw + this.input.playerRadius;
      for (let p = 0; p < this.playerTotal; p++) {
        if (this.playerDown(p)) continue;
        if (distSqToSegment(this.playerX(p), this.playerZ(p), a.headX, a.headZ, nx, nz) <= rr * rr) {
          // TODO(co-op): per-player hitDone so one sweep can catch both players
          a.hitDone = true;
          this.sink.onPlayerHit(a, p);
          break;
        }
      }
    }
    if (nx !== a.headX || nz !== a.headZ) this.sink.onErase(a.headX, a.headZ, nx, nz, a.hw);
    a.headX = nx;
    a.headZ = nz;
  }

  private afterDrag(a: Attack): void {
    if (this.phase !== 1) return;
    const p1 = this.tuning.boss.phase1;
    let n = p1.ghostsPerSweep + (this.rng() < p1.extraGhostChance ? 1 : 0);
    while (n-- > 0) {
      const t = 0.35 + this.rng() * 0.6;
      const side = (this.rng() - 0.5) * a.hw;
      const dx = a.bx - a.ax;
      const dz = a.bz - a.az;
      const l = Math.hypot(dx, dz) || 1;
      this.sink.onSpawn('smudge', a.ax + dx * t - (dz / l) * side, a.az + dz * t + (dx / l) * side);
    }
  }

  private circleImpact(a: Attack): void {
    const rr = a.hw + this.input.playerRadius;
    for (let p = 0; p < this.playerTotal; p++) {
      if (this.playerDown(p)) continue;
      const dx = this.playerX(p) - a.ax;
      const dz = this.playerZ(p) - a.az;
      if (dx * dx + dz * dz <= rr * rr) {
        a.hitDone = true;
        this.sink.onPlayerHit(a, p);
      }
    }
    if (a.kind === 'stab' && this.rng() < this.tuning.boss.phase2.scribblerChance) {
      this.sink.onSpawn('scribbler', a.ax, a.az);
    }
  }

  private maybeBow(): void {
    const p3 = this.tuning.boss.phase3;
    // Every `bowEvery` finished sweeps (more often once overtime) the Editor bows, panting.
    const every = this.phaseTime > p3.duration ? 1 : p3.bowEvery;
    this.sweepsDone++;
    // co-op: every `stet.every` sweeps the red pencil circles one inker instead of a plain bow
    if (
      this.playerTotal >= 2 &&
      !this.stet.active &&
      this.sweepsDone % this.tuning.coop.stet.every === 0 &&
      !this.anyActive()
    ) {
      this.beginStet();
      return;
    }
    if (this.sweepsDone % every === 0 && !this.anyActive()) {
      this.bowT = p3.bowTime * this.mul('windowMul');
      this.attackTimer = Math.max(this.attackTimer, 0.4);
    }
  }

  private anyActive(): boolean {
    for (const a of this.attacks) if (a.active) return true;
    return false;
  }
}
