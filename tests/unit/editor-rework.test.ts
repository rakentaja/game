import { describe, expect, it } from 'vitest';
import type { EnemyKind, PlayerVerb } from '../../src/core/types';
import { TUNING } from '../../src/data/tuning';
import {
  type Attack,
  type BossPhase,
  EditorFSM,
  NullSink,
  pickRewriteVerb,
  type WeakPointState,
} from '../../src/entities/Editor/fsm';
import { PaintTrail } from '../../src/entities/Editor/paint';

const DT = 1 / 60;
const B = TUNING.boss;

class Rec extends NullSink {
  log: string[] = [];
  rewrites: { verb: PlayerVerb; cut: boolean; printed: boolean; t: number }[] = [];
  stems: { stem: number; erased: boolean }[] = [];
  erases = 0;
  redraws: BossPhase[] = [];
  summons: EnemyKind[] = [];
  spawns: EnemyKind[] = [];
  hits: number[] = [];
  constructor(private f?: () => EditorFSM) {
    super();
  }
  override onPhase(p: BossPhase): void {
    this.log.push(`phase${p}`);
  }
  override onRewrite(verb: PlayerVerb, cut: boolean, printed: boolean): void {
    this.log.push(`${cut ? 'cut' : 'restore'}:${verb}`);
    this.rewrites.push({ verb, cut, printed, t: this.f?.().fightTime ?? 0 });
  }
  override onEraseStem(stem: number, erased: boolean): void {
    this.stems.push({ stem, erased });
  }
  override onErase(): void {
    this.erases++;
  }
  override onRedraw(p: BossPhase): void {
    this.redraws.push(p);
    this.log.push(`redraw${p}`);
  }
  override onSummonStart(k: EnemyKind): void {
    this.summons.push(k);
  }
  override onSpawn(k: EnemyKind): void {
    this.spawns.push(k);
  }
  override onPlayerHit(_a: Attack, p: number): void {
    this.hits.push(p);
  }
  override onPrinted(_w: WeakPointState): void {
    this.log.push('printed');
  }
}

function make(difficulty: 'normal' | 'story' = 'normal', seed = 1337): { f: EditorFSM; s: Rec } {
  let fsm: EditorFSM | null = null;
  const s = new Rec(() => fsm!);
  fsm = new EditorFSM(TUNING, difficulty, s, seed);
  return { f: fsm, s };
}

function run(f: EditorFSM, seconds: number, each?: (f: EditorFSM) => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    each?.(f);
    f.step(DT);
  }
}

const park = (f: EditorFSM) => {
  f.input.px = 9;
  f.input.pz = 9;
  f.input.crystalHeld = false;
};

const placeWps = (f: EditorFSM) => {
  for (const w of f.wps) {
    w.x = f.bossX + (w.index - 4) * 1.2;
    w.y = 1.6;
    w.z = f.bossZ + 1.5;
  }
};

describe('Editor rework — Rewrites', () => {
  it('pickRewriteVerb rotates, never cuts the crystal, and Story avoids survival verbs', () => {
    const rw = B.rewrite;
    expect(pickRewriteVerb(rw, 2, false)).toBe(rw.rotation[0]);
    expect(pickRewriteVerb(rw, 3, false)).toBe(rw.rotation[1 % rw.rotation.length]);
    for (const ph of [2, 3] as const) {
      const v = pickRewriteVerb(rw, ph, true)!;
      expect(rw.storyUnsafe).not.toContain(v);
      expect(v).not.toBe('crystal');
    }
    const forced = { ...rw, rotation: ['crystal' as const], storyRotation: ['dash' as const] };
    expect(pickRewriteVerb(forced, 2, false)).toBe('print');
    expect(pickRewriteVerb(forced, 2, true)).toBe('print');
    expect(pickRewriteVerb({ ...rw, rotation: [] }, 2, false)).toBeNull();
  });

  it('transition into phase 2 redraws the arena and cuts dash for cutTime, then restores it', () => {
    const { f, s } = make();
    f.jumpTo(2);
    // phase event → redraw → new strips → cut, in that order, at the transition start
    expect(s.log.slice(0, 3)).toEqual(['phase2', 'redraw2', `cut:${B.rewrite.rotation[0]}`]);
    expect(s.erases).toBe(B.redraw.p2.length);
    expect(f.isCut('dash')).toBe(true);
    const t0 = f.fightTime;
    run(f, B.rewrite.cutTime - 0.1, park);
    expect(f.isCut('dash')).toBe(true);
    run(f, 0.2, park);
    expect(f.isCut('dash')).toBe(false);
    const restore = s.rewrites.find((r) => !r.cut)!;
    expect(restore.verb).toBe('dash');
    expect(restore.printed).toBe(false);
    expect(restore.t - t0).toBeCloseTo(B.rewrite.cutTime, 1);
  });

  it('the verb sketch appears after the transition and printing it restores the verb early', () => {
    const { f, s } = make();
    f.jumpTo(2);
    const r = f.rewrite;
    run(f, B.transitionTime + 0.1, park);
    expect(r.sketch).toBe(false);
    run(f, B.rewrite.sketchDelay + B.rewrite.drawIn + 0.1, park);
    expect(r.sketch).toBe(true);
    expect(r.drawIn).toBe(1);
    // too small a light: no progress
    run(f, 0.5, (fsm) =>
      Object.assign(fsm.input, { crystalHeld: true, revealRadius: 3, cx: r.x, cy: 1.8, cz: r.z }),
    );
    expect(r.print).toBe(0);
    run(f, B.rewrite.printHold + 0.05, (fsm) =>
      Object.assign(fsm.input, { crystalHeld: true, revealRadius: 7, cx: r.x, cy: 1.8, cz: r.z + 2 }),
    );
    expect(f.isCut('dash')).toBe(false);
    expect(s.rewrites.at(-1)).toMatchObject({ verb: 'dash', cut: false, printed: true });
    expect(f.fightTime).toBeLessThan(B.rewrite.cutTime);
  });

  it('phase 3 cuts the next verb; story cuts are shorter and never dash', () => {
    const { f, s } = make();
    f.jumpTo(3);
    expect(s.rewrites.at(-1)).toMatchObject({ verb: B.rewrite.rotation[1], cut: true });
    expect(s.redraws).toEqual([3]);
    const st = make('story');
    st.f.jumpTo(2);
    expect(st.f.rewrite.t).toBe(B.rewrite.storyCutTime);
    expect(B.rewrite.storyCutTime).toBeLessThan(B.rewrite.cutTime);
    st.f.jumpTo(3);
    for (const r of st.s.rewrites) expect(r.verb).not.toBe('dash');
  });

  it('never leaks a cut verb: re-entering a phase restores first, death restores everything', () => {
    const { f, s } = make();
    const balance = () => s.rewrites.reduce((n, r) => n + (r.cut ? 1 : -1), 0);
    f.jumpTo(2);
    f.jumpTo(2); // respawn mid-phase
    expect(balance()).toBe(1);
    f.jumpTo(3);
    expect(balance()).toBe(1);
    f.kill();
    expect(balance()).toBe(0);
    expect(f.rewrite.cut).toBe(false);
    // and the intro (phase 1) never cuts anything
    const g = make();
    g.f.start();
    run(g.f, B.introTime + B.transitionTime + 1, park);
    expect(g.s.rewrites).toEqual([]);
  });

  it('a cut print verb blocks printing phase-2 weak points', () => {
    const { f } = make();
    f.jumpTo(2);
    f.rewrite.verb = 'print';
    run(f, B.transitionTime + 0.7 + B.phase2.drawIn + 0.1, (fsm) => {
      park(fsm);
      placeWps(fsm);
    });
    const w = f.wps[f.p2Active]!;
    run(f, B.phase2.printHold + 0.1, (fsm) => {
      placeWps(fsm);
      Object.assign(fsm.input, { crystalHeld: true, revealRadius: 7, cx: w.x, cy: 1.8, cz: w.z + 3 });
    });
    expect(w.printed).toBe(false);
  });
});

describe('Editor rework — soundtrack stems', () => {
  it('phase-1 drag strikes erase stems cyclically; phase-2 prints restore them; phase 3 restores all', () => {
    const { f, s } = make();
    f.jumpTo(1);
    run(f, 75, park);
    const erased = s.stems.filter((e) => e.erased).map((e) => e.stem);
    expect(erased.length).toBeGreaterThan(B.stems.count);
    expect(erased).toEqual(erased.map((_, i) => i % B.stems.count));
    expect(f.stemsErased).toBe((1 << B.stems.count) - 1);
    // phase 2: printing a weak point brings one stem back
    f.jumpTo(2);
    s.stems.length = 0;
    run(f, B.transitionTime + 0.7 + B.phase2.drawIn + 0.1, (fsm) => {
      park(fsm);
      placeWps(fsm);
    });
    const w = f.wps[f.p2Active]!;
    run(f, B.phase2.printHold + 0.1, (fsm) => {
      placeWps(fsm);
      Object.assign(fsm.input, { crystalHeld: true, revealRadius: 7, cx: w.x, cy: 1.8, cz: w.z + 3 });
    });
    expect(w.printed).toBe(true);
    expect(s.stems).toEqual([{ stem: 0, erased: false }]);
    // drags in phase 2 never erase stems
    expect(s.stems.some((e) => e.erased)).toBe(false);
    f.jumpTo(3);
    run(f, B.transitionTime + 0.1, park);
    expect(f.stemsErased).toBe(0);
    expect(s.stems.filter((e) => !e.erased).map((e) => e.stem)).toEqual([0, 1, 2, 3].slice(0, B.stems.count));
  });

  it('death gives every stem back', () => {
    const { f, s } = make();
    f.jumpTo(1);
    run(f, 12, park);
    expect(f.stemsErased).not.toBe(0);
    f.kill();
    expect(f.stemsErased).toBe(0);
    const bal = new Map<number, number>();
    for (const e of s.stems) bal.set(e.stem, (bal.get(e.stem) ?? 0) + (e.erased ? 1 : 0));
    for (const e of s.stems) if (!e.erased) expect(bal.get(e.stem)).toBeGreaterThan(0);
  });
});

describe('Editor rework — phase 2 summons', () => {
  it('the left hand draws roster enemies in tuning order, capped per phase', () => {
    const { f, s } = make();
    f.jumpTo(2);
    run(f, B.transitionTime + B.summon.first + 0.1, park);
    expect(f.summon.active).toBe(true);
    expect(f.windingUp).toBe(true);
    expect(s.summons).toEqual([B.summon.kinds[0]]);
    run(f, B.summon.drawTime + 0.05, park);
    expect(s.spawns).toContain(B.summon.kinds[0]);
    run(f, 60, park);
    expect(s.summons).toEqual(B.summon.kinds.slice(0, B.summon.max));
    // summons stay inside the arena
    const [cx, cz, r] = B.arena;
    expect(Math.hypot(f.summon.x - cx, f.summon.z - cz)).toBeLessThan(r);
  });

  it('story summons fewer, gentler kinds', () => {
    const { f, s } = make('story');
    f.jumpTo(2);
    run(f, 80, park);
    expect(s.summons.length).toBeLessThanOrEqual(B.summon.storyMax);
    for (const k of s.summons) expect(B.summon.storyKinds).toContain(k);
  });
});

describe('Editor rework — telegraph flag & co-op input', () => {
  it('windingUp is true exactly while an attack telegraphs (or a summon draws)', () => {
    const { f } = make();
    f.jumpTo(1);
    let seenTele = 0;
    run(f, 20, (fsm) => {
      park(fsm);
      const tele = fsm.attacks.some((a) => a.active && a.stage === 'telegraph');
      if (fsm.state === 'phase') expect(fsm.windingUp).toBe(tele || fsm.summon.active);
      if (tele) seenTele++;
    });
    expect(seenTele).toBeGreaterThan(0);
  });

  it('defaults to the single player; with two players attacks pick the nearest standing one', () => {
    const { f, s } = make();
    expect(f.playerTotal).toBe(1);
    f.input.px = 3;
    f.input.pz = 4;
    expect(f.pickTarget()).toBe(0);
    expect([f.aimX, f.aimZ]).toEqual([3, 4]);
    const P = f.input.players;
    f.input.playerCount = 2;
    Object.assign(P[0]!, { x: 0, z: 8, down: false });
    Object.assign(P[1]!, { x: 1, z: 0, down: false });
    expect(f.pickTarget()).toBe(1);
    P[1]!.down = true;
    expect(f.pickTarget()).toBe(0);
    P[1]!.down = false;
    // a circle press on player 1 hits player 1, not player 0
    f.jumpTo(1);
    run(f, 30, () => {
      Object.assign(P[0]!, { x: 8, z: 6 });
      Object.assign(P[1]!, { x: -1, z: -1 });
    });
    expect(s.hits.length).toBeGreaterThan(0);
    expect(s.hits.every((h) => h === 1)).toBe(true);
  });

  it('alternate targeting cycles through standing players', () => {
    const { f } = make();
    const mode = B.coop.targetMode;
    B.coop.targetMode = 'alternate';
    try {
      f.input.playerCount = 3;
      f.input.players[1]!.down = true;
      const seq = [f.pickTarget(), f.pickTarget(), f.pickTarget(), f.pickTarget()];
      expect(seq).toEqual([0, 2, 0, 2]);
    } finally {
      B.coop.targetMode = mode;
    }
  });
});

describe('Editor rework — Blank Page, Reversed paint trail', () => {
  it('samples the crystal trail, refreshes when still, fades and is wiped by the eraser', () => {
    const p = new PaintTrail(8);
    expect(p.at(0, 0)).toBe(0);
    for (let i = 0; i < 30; i++) {
      p.sample(0, 0, 3, 4, DT, 0.3, 0.9);
      p.step(DT);
    }
    expect(p.at(0, 0)).toBeGreaterThan(0.9);
    expect(p.at(0, 2)).toBeGreaterThan(0.5);
    expect(p.at(0, 5)).toBe(0);
    // standing still keeps it alive
    for (let i = 0; i < 60 * 6; i++) {
      p.sample(0, 0, 3, 4, DT, 0.3, 0.9);
      p.step(DT);
    }
    expect(p.at(0, 0)).toBeGreaterThan(0.9);
    // walking away: the old paint fades after its life
    for (let i = 0; i < 60 * 5; i++) {
      p.sample(20, 20, 3, 4, DT, 0.3, 0.9);
      p.step(DT);
    }
    expect(p.at(0, 0)).toBe(0);
    expect(p.at(20, 20)).toBeGreaterThan(0.9);
    p.erase(15, 20, 25, 20, 1);
    expect(p.at(20, 20)).toBe(0);
  });

  it('dash streaks paint along the dash and recycle the weakest slot when full', () => {
    const p = new PaintTrail(6);
    p.addStreak(0, 0, 4, 0, 1.5, 5);
    for (let i = 0; i < 30; i++) p.step(DT);
    expect(p.at(2, 0)).toBeGreaterThan(0.9);
    for (let k = 0; k < 10; k++) p.add(50 + k * 5, 0, 1, 5);
    for (let i = 0; i < 30; i++) p.step(DT);
    expect(p.at(95, 0)).toBeGreaterThan(0.9);
    expect(p.slots.filter((s) => s.alive).length).toBe(6);
  });
});
