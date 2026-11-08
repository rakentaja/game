import { describe, expect, it } from 'vitest';
import type { EnemyKind } from '../../src/core/types';
import { TUNING } from '../../src/data/tuning';
import {
  type Attack,
  type BossPhase,
  CORE_INDEX,
  distSqToSegment,
  EditorFSM,
  makeRng,
  NullSink,
  type WeakPointState,
} from '../../src/entities/Editor/fsm';

const DT = 1 / 60;

class RecSink extends NullSink {
  log: string[] = [];
  phases: BossPhase[] = [];
  erases = 0;
  playerHits = 0;
  spawns: EnemyKind[] = [];
  printed = 0;
  defeated = 0;
  override onIntro(): void {
    this.log.push('intro');
  }
  override onPhase(p: BossPhase): void {
    this.phases.push(p);
    this.log.push(`phase${p}`);
  }
  override onErase(): void {
    this.erases++;
  }
  override onPlayerHit(_a: Attack): void {
    this.playerHits++;
  }
  override onSpawn(k: EnemyKind): void {
    this.spawns.push(k);
  }
  override onPrinted(_w: WeakPointState): void {
    this.printed++;
  }
  override onDeathStart(): void {
    this.log.push('dying');
  }
  override onDefeated(): void {
    this.defeated++;
    this.log.push('defeated');
  }
}

function run(fsm: EditorFSM, seconds: number, each?: (f: EditorFSM) => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    each?.(fsm);
    fsm.step(DT);
  }
}

/** Put the P2 sketched points somewhere reachable in front of the Editor, like the rig does. */
function placeWeakpoints(f: EditorFSM): void {
  for (const w of f.wps) {
    w.x = f.bossX + (w.index - 4) * 1.2;
    w.y = 1.6;
    w.z = f.bossZ + 1.5;
  }
}

/** Keep the player well away from everything (never hit). */
function parkPlayer(f: EditorFSM): void {
  f.input.px = 9;
  f.input.pz = 9;
}

describe('EditorFSM — flow', () => {
  it('stays dormant until started, then intro → phase 1', () => {
    const sink = new RecSink();
    const f = new EditorFSM(TUNING, 'normal', sink);
    run(f, 2);
    expect(f.state).toBe('dormant');
    f.start();
    expect(f.state).toBe('intro');
    run(f, TUNING.boss.introTime + 0.1);
    expect(sink.phases).toEqual([1]);
    run(f, TUNING.boss.transitionTime);
    expect(f.state).toBe('phase');
    expect(f.phase).toBe(1);
  });

  it('phase 1 weak points are only exposed while their arm is pinned, one hit per window', () => {
    const f = new EditorFSM(TUNING, 'normal');
    f.jumpTo(1);
    run(f, TUNING.boss.transitionTime + 0.05, parkPlayer);
    expect(f.state).toBe('phase');
    // Not exposed during idle / telegraph.
    expect(f.wps[0]!.exposed).toBe(false);
    expect(f.hitWeakpoint(0, 1)).toBe(false);
    // Wait for the first drag to pin the right arm.
    let guard = 0;
    while (!f.wps[0]!.exposed && guard++ < 600) {
      parkPlayer(f);
      f.step(DT);
    }
    expect(f.wps[0]!.exposed).toBe(true);
    expect(f.handPinned('R')).toBe(true);
    expect(f.hitWeakpoint(0, 1)).toBe(true);
    expect(f.wps[0]!.hp).toBe(TUNING.boss.phase1.wpHp - 1);
    // Flinched shut for the rest of this window.
    expect(f.wps[0]!.exposed).toBe(false);
    f.step(DT);
    expect(f.hitWeakpoint(0, 1)).toBe(false);
    // The other arm point is still open in the same window.
    expect(f.hitWeakpoint(1, 1)).toBe(true);
  });

  it('destroying all phase-1 points transitions to phase 2 with a panel-cut phase event', () => {
    const sink = new RecSink();
    const f = new EditorFSM(TUNING, 'normal', sink);
    f.jumpTo(1);
    run(f, 120, (fsm) => {
      parkPlayer(fsm);
      if (fsm.phase === 1)
        for (const w of fsm.wps) if (w.phase === 1 && w.exposed) fsm.hitWeakpoint(w.index, 1);
    });
    expect(sink.phases).toContain(2);
  });

  it('phase 2 points must be printed (crystal held at full radius in range for printHold) before they take hits', () => {
    const sink = new RecSink();
    const f = new EditorFSM(TUNING, 'normal', sink);
    f.jumpTo(2);
    run(f, TUNING.boss.transitionTime + 0.05, parkPlayer);
    run(f, 0.7 + TUNING.boss.phase2.drawIn + 0.1, (fsm) => {
      parkPlayer(fsm);
      placeWeakpoints(fsm);
    });
    const w = f.wps[f.p2Active]!;
    expect(w.drawIn).toBe(1);
    expect(f.hitWeakpoint(w.index, 1)).toBe(false);
    // Holding the crystal but too far: no progress.
    run(f, 1, (fsm) => {
      placeWeakpoints(fsm);
      Object.assign(fsm.input, { crystalHeld: true, revealRadius: 7, cx: 9, cy: 1.8, cz: 9 });
    });
    expect(w.print).toBe(0);
    // In range, but radius not grown yet: no progress.
    run(f, 0.5, (fsm) => {
      placeWeakpoints(fsm);
      Object.assign(fsm.input, { crystalHeld: true, revealRadius: 3, cx: w.x, cy: 1.8, cz: w.z + 4 });
    });
    expect(w.print).toBe(0);
    run(f, TUNING.boss.phase2.printHold + 0.05, (fsm) => {
      placeWeakpoints(fsm);
      Object.assign(fsm.input, { crystalHeld: true, revealRadius: 7, cx: w.x, cy: 1.8, cz: w.z + 4 });
    });
    expect(w.printed).toBe(true);
    expect(sink.printed).toBe(1);
    expect(f.hitWeakpoint(w.index, 1)).toBe(true);
  });

  it('printed points un-print after printedLife', () => {
    const f = new EditorFSM(TUNING, 'normal');
    f.jumpTo(2);
    run(f, TUNING.boss.transitionTime + 0.8 + TUNING.boss.phase2.drawIn, (fsm) => {
      parkPlayer(fsm);
      placeWeakpoints(fsm);
    });
    const w = f.wps[f.p2Active]!;
    run(f, TUNING.boss.phase2.printHold + 0.1, (fsm) => {
      placeWeakpoints(fsm);
      Object.assign(fsm.input, { crystalHeld: true, revealRadius: 7, cx: w.x, cy: 1.8, cz: w.z + 3 });
    });
    expect(w.printed).toBe(true);
    run(f, TUNING.boss.phase2.printedLife + 0.1, (fsm) => {
      parkPlayer(fsm);
      fsm.input.crystalHeld = false;
    });
    expect(w.printed).toBe(false);
    expect(w.exposed).toBe(false);
  });

  it('phase 3 sets blank page, core only opens during bows, 3 hits kill → dying → defeated', () => {
    const sink = new RecSink();
    const f = new EditorFSM(TUNING, 'normal', sink);
    f.jumpTo(3);
    run(f, TUNING.boss.transitionTime + 0.05, parkPlayer);
    expect(f.blank).toBe(1);
    const core = f.wps[CORE_INDEX]!;
    expect(core.maxHp).toBe(TUNING.boss.phase3.hitsToKill);
    expect(f.hitWeakpoint(CORE_INDEX, 1)).toBe(false);
    let hits = 0;
    run(f, 80, (fsm) => {
      parkPlayer(fsm);
      if (fsm.wps[CORE_INDEX]!.exposed) {
        expect(fsm.bowT).toBeGreaterThan(0);
        if (fsm.hitWeakpoint(CORE_INDEX, 1)) hits++;
        // one hit per bow
        expect(fsm.hitWeakpoint(CORE_INDEX, 1)).toBe(false);
      }
    });
    expect(hits).toBe(3);
    expect(sink.log).toContain('dying');
    expect(sink.defeated).toBe(1);
    expect(f.state).toBe('dead');
    expect(sink.log.indexOf('dying')).toBeLessThan(sink.log.indexOf('defeated'));
  });
});

describe('EditorFSM — attacks', () => {
  it('drag sweeps erase the lane progressively and hit a player standing in it once', () => {
    const sink = new RecSink();
    const f = new EditorFSM(TUNING, 'normal', sink);
    f.jumpTo(1);
    run(f, TUNING.boss.transitionTime + 0.05);
    // Player stands still in the lane the next drag will aim at.
    f.input.px = 0;
    f.input.pz = 4;
    run(f, 1.0 + TUNING.boss.phase1.telegraph + TUNING.boss.phase1.travel + 0.3);
    expect(sink.erases).toBeGreaterThan(10);
    expect(sink.playerHits).toBe(1);
  });

  it('a player who steps out of the telegraphed lane is not hit', () => {
    const sink = new RecSink();
    const f = new EditorFSM(TUNING, 'normal', sink);
    f.jumpTo(1);
    run(f, TUNING.boss.transitionTime + 0.05);
    f.input.px = 0;
    f.input.pz = 4;
    // let the lane get chosen, then sidestep 3 m
    let stepped = false;
    run(f, 1.0 + TUNING.boss.phase1.telegraph + TUNING.boss.phase1.travel + 0.3, (fsm) => {
      if (!stepped && fsm.attacks.some((a) => a.active && a.stage === 'telegraph')) {
        fsm.input.px = 3.5;
        stepped = true;
      }
    });
    expect(stepped).toBe(true);
    expect(sink.playerHits).toBe(0);
  });

  it('erased lanes spawn ghosts in phase 1; stabs can spawn scribblers in phase 2', () => {
    const sink = new RecSink();
    const f = new EditorFSM(TUNING, 'normal', sink);
    f.jumpTo(1);
    run(f, 20, parkPlayer);
    expect(sink.spawns.filter((k) => k === 'smudge').length).toBeGreaterThan(2);
    f.jumpTo(2);
    run(f, 40, parkPlayer);
    expect(sink.spawns).toContain('scribbler');
  });

  it('phase 3 sweeps come faster than phase 1', () => {
    const count = (phase: BossPhase) => {
      let n = 0;
      const sink = new (class extends NullSink {
        override onAttack(_a: Attack, s: string): void {
          if (s === 'telegraph') n++;
        }
      })();
      const f = new EditorFSM(TUNING, 'normal', sink);
      f.jumpTo(phase);
      run(f, TUNING.boss.transitionTime + 20, parkPlayer);
      return n;
    };
    expect(count(3)).toBeGreaterThan(count(1));
    expect(TUNING.boss.phase3.telegraph).toBeLessThan(TUNING.boss.phase1.telegraph);
  });

  it('lanes stay inside the arena', () => {
    const f = new EditorFSM(TUNING, 'normal');
    f.jumpTo(1);
    const [cx, cz, r] = TUNING.boss.arena;
    const rng = makeRng(4);
    run(f, 40, (fsm) => {
      fsm.input.px = cx + (rng() - 0.5) * r * 1.4;
      fsm.input.pz = cz + (rng() - 0.5) * r * 1.4;
      for (const a of fsm.attacks) {
        if (!a.active) continue;
        expect(Math.hypot(a.bx - cx, a.bz - cz)).toBeLessThanOrEqual(r + 0.01);
      }
    });
  });

  it('distSqToSegment', () => {
    expect(distSqToSegment(0, 1, -1, 0, 1, 0)).toBeCloseTo(1);
    expect(distSqToSegment(3, 0, -1, 0, 1, 0)).toBeCloseTo(4);
    expect(distSqToSegment(0, 0, 2, 2, 2, 2)).toBeCloseTo(8);
  });
});

describe('EditorFSM — difficulty & pacing', () => {
  it('story mode has fewer hp and longer telegraphs', () => {
    const n = new EditorFSM(TUNING, 'normal');
    const s = new EditorFSM(TUNING, 'story');
    n.start();
    s.start();
    expect(s.wps[0]!.maxHp).toBeLessThan(n.wps[0]!.maxHp);
    expect(s.wps[CORE_INDEX]!.maxHp).toBeLessThanOrEqual(n.wps[CORE_INDEX]!.maxHp);
    n.jumpTo(1);
    s.jumpTo(1);
    run(n, TUNING.boss.transitionTime + 1.1);
    run(s, TUNING.boss.transitionTime + 1.1);
    const tn = n.attacks.find((a) => a.active)!;
    const ts = s.attacks.find((a) => a.active)!;
    expect(ts.telegraph).toBeGreaterThan(tn.telegraph);
  });

  /**
   * A plausible first-timer bot: reacts late, misses ~40% of windows, needs time to walk to
   * sketched points. Normal must land in the 2–2.5 min PLAN target (±10 s slack).
   */
  function botFight(difficulty: 'story' | 'normal', seed: number): { time: number; sink: RecSink } {
    const sink = new RecSink();
    const f = new EditorFSM(TUNING, difficulty, sink, seed);
    const rng = makeRng(seed * 31 + 7);
    const decided = new Map<string, number>(); // window key → time to hit (or -1 skip)
    let walk = 0;
    f.start();
    let t = 0;
    while (f.state !== 'dead' && t < 400) {
      t += DT;
      parkPlayer(f);
      placeWeakpoints(f);
      f.input.crystalHeld = false;
      f.input.revealRadius = 3;
      if (f.state === 'phase') {
        if (f.phase === 2 && f.p2Active >= 0) {
          const w = f.wps[f.p2Active]!;
          if (w.drawIn >= 1 && !w.printed) {
            walk += DT;
            if (walk > 2.8) {
              Object.assign(f.input, { crystalHeld: true, revealRadius: 7, cx: w.x, cy: 1.8, cz: w.z + 4 });
            }
          } else walk = 0;
        }
        for (const w of f.wps) {
          if (!w.exposed) continue;
          const key = `${w.index}:${w.phase === 2 ? `${w.hp}p${sink.printed}` : f.attacksThisPhase}:${f.sweepsDone}`;
          if (!decided.has(key)) {
            const hitChance = w.phase === 1 ? 0.6 : w.phase === 2 ? 0.9 : 0.55;
            const react = w.phase === 2 ? 0.7 : 0.6 + rng() * 0.5;
            decided.set(key, rng() < hitChance ? t + react : -1);
          }
          const at = decided.get(key)!;
          if (at > 0 && t >= at) {
            f.hitWeakpoint(w.index, 1);
            decided.set(key, w.phase === 2 ? t + 0.35 : -1);
          }
        }
      }
      f.step(DT);
    }
    return { time: f.fightTime, sink };
  }

  it('normal fight takes ~2–2.5 minutes for a plausible player', () => {
    const times: number[] = [];
    for (const seed of [1, 2, 3, 4, 5]) {
      const { time, sink } = botFight('normal', seed);
      expect(sink.defeated).toBe(1);
      times.push(time);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    expect(avg).toBeGreaterThan(110);
    expect(avg).toBeLessThan(160);
  });

  it('story fight is shorter than normal', () => {
    const n = botFight('normal', 9).time;
    const s = botFight('story', 9).time;
    expect(s).toBeLessThan(n);
  });
});
