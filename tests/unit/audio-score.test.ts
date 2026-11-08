import { describe, expect, it, vi } from 'vitest';
import { install } from '../../src/audio/install';
import type { Instruments } from '../../src/audio/music/instruments';
import { bossPhase, type Intensity, LAYERS, type LayerName, TRACKS } from '../../src/audio/music/tracks';
import { EventBus, type GameEvents } from '../../src/core/events';
import type { AudioAPI, GameContext, SfxId } from '../../src/core/types';
import { DEFAULT_SETTINGS } from '../../src/core/types';

type Note = { kind: string; t: number; midi?: number[]; vel: number };

function fakeInst(log: Note[]): Instruments {
  const rec =
    (kind: string) =>
    (_d: unknown, t: number, m: number | readonly number[], ...rest: number[]) =>
      log.push({
        kind,
        t,
        midi: typeof m === 'number' ? [m] : [...m],
        vel: rest[rest.length > 1 ? 1 : 0] ?? 0,
      });
  return {
    pad: rec('pad'),
    choir: rec('choir'),
    musicBox: (_d: unknown, t: number, m: number, vel: number) =>
      log.push({ kind: 'musicBox', t, midi: [m], vel }),
    pluck: (_d: unknown, t: number, m: number, _dur: number, vel: number) =>
      log.push({ kind: 'pluck', t, midi: [m], vel }),
    bass: (_d: unknown, t: number, m: number, _dur: number, vel: number) =>
      log.push({ kind: 'bass', t, midi: [m], vel }),
    brass: (_d: unknown, t: number, m: readonly number[], _dur: number, vel: number) =>
      log.push({ kind: 'brass', t, midi: [...m], vel }),
    hit: (_d: unknown, id: string, t: number, vel: number) => log.push({ kind: `hit:${id}`, t, vel }),
    drone: () => () => {},
  } as unknown as Instruments;
}

function run(name: keyof typeof TRACKS, int: Intensity, loops = 2): Note[] {
  const def = TRACKS[name];
  const log: Note[] = [];
  const out = Object.fromEntries(LAYERS.map((l) => [l, {}])) as Record<LayerName, AudioNode>;
  let seed = 1;
  const sec16 = 60 / def.bpm / 4;
  const total = def.loopBars * 16 * loops;
  for (let step = 0; step < total; step++) {
    const inLoop = step % (def.loopBars * 16);
    def.step({
      t: step * sec16,
      step,
      bar: inLoop >> 4,
      s16: inLoop & 15,
      loop: Math.floor(step / (def.loopBars * 16)),
      sec16,
      inst: fakeInst(log),
      out,
      int,
      rnd: () => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return (seed >>> 8) / 16777216;
      },
    });
  }
  return log;
}

const D_MINOR = new Set([2, 4, 5, 7, 9, 10, 0, 1]); // D E F G A Bb C + C# (harmonic V)

describe('generative score', () => {
  it('title states the full leitmotif in D minor every loop', () => {
    const log = run('title', { explore: 0.5, combat: 0, boss: 0 });
    const mel = log.filter((n) => n.kind === 'musicBox');
    expect(mel.length).toBeGreaterThan(40);
    for (const n of mel) expect(D_MINOR.has(n.midi![0]! % 12)).toBe(true);
    // the call: A A A D
    expect(mel.slice(0, 4).map((n) => n.midi![0]! % 12)).toEqual([9, 9, 9, 2]);
  });

  it('cover is in D major (F#, C#, B instead of F, C, Bb)', () => {
    const mel = run('cover', { explore: 0, combat: 0, boss: 0 }).filter((n) => n.kind === 'musicBox');
    const pcs = new Set(mel.map((n) => n.midi![0]! % 12));
    expect(pcs.has(6)).toBe(true);
    expect(pcs.has(5)).toBe(false);
    expect(pcs.has(10)).toBe(false);
  });

  it('explore percussion only plays when combat rises', () => {
    const calm = run('explore', { explore: 0.6, combat: 0, boss: 0 });
    const fight = run('explore', { explore: 0.6, combat: 1, boss: 0 });
    const perc = (l: Note[]) =>
      l.filter((n) => n.kind.startsWith('hit:taiko') || n.kind === 'hit:frame').length;
    expect(perc(calm)).toBe(0);
    expect(perc(fight)).toBeGreaterThan(100);
    expect(fight.some((n) => n.kind === 'pluck')).toBe(true);
  });

  it('boss gets denser phase by phase', () => {
    const count = (b: number) => run('boss', { explore: 0, combat: 0, boss: b }, 1).length;
    const p1 = count(0.34);
    const p2 = count(0.67);
    const p3 = count(1);
    expect(p2).toBeGreaterThan(p1 * 1.3);
    expect(p3).toBeGreaterThan(p2 * 1.3);
    expect(run('boss', { explore: 0, combat: 0, boss: 1 }, 1).some((n) => n.kind === 'brass')).toBe(true);
    expect(run('boss', { explore: 0, combat: 0, boss: 0.34 }, 1).some((n) => n.kind === 'brass')).toBe(false);
    expect([0, 0.34, 0.67, 1].map(bossPhase)).toEqual([0, 1, 2, 3]);
  });

  it('every track stays in a playable register and on the grid', () => {
    for (const name of Object.keys(TRACKS) as (keyof typeof TRACKS)[]) {
      const def = TRACKS[name];
      const sec16 = 60 / def.bpm / 4;
      for (const n of run(name, { explore: 1, combat: 1, boss: 1 })) {
        for (const m of n.midi ?? []) {
          expect(m).toBeGreaterThanOrEqual(20);
          expect(m).toBeLessThanOrEqual(96);
        }
        expect(Math.abs(n.t / sec16 - Math.round(n.t / sec16))).toBeLessThan(1e-6);
        expect(n.vel).toBeGreaterThanOrEqual(0);
        expect(n.vel).toBeLessThanOrEqual(1);
      }
      const levels = Object.fromEntries(LAYERS.map((l) => [l, -1])) as Record<LayerName, number>;
      def.levels({ explore: 0.5, combat: 0.5, boss: 0.5 }, levels);
      for (const l of LAYERS) expect(levels[l]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('install() event bridge', () => {
  function setup() {
    const calls: [string, ...unknown[]][] = [];
    const loops = { started: 0, stopped: 0 };
    const audio: AudioAPI = {
      unlock: async () => {},
      play: (id: SfxId, o?: { position?: { x: number; y: number; z: number }; volume?: number }) =>
        calls.push(['play', id, o?.position ? [o.position.x, o.position.y, o.position.z] : null, o?.volume]),
      loop: () => {
        loops.started++;
        return () => {
          loops.stopped++;
        };
      },
      setMusic: (t) => calls.push(['music', t]),
      setIntensity: (l, v) => calls.push(['int', l, v]),
      setListener: () => {},
      setVolumes: (v) => calls.push(['vol', v.master, v.music, v.sfx]),
      suspend: () => {},
      resume: () => {},
    } as AudioAPI;
    const events = new EventBus<GameEvents>();
    const settings = { ...DEFAULT_SETTINGS };
    const ctx = { events, settings, audio } as unknown as GameContext;
    const off = install(ctx);
    return { calls, events, settings, off, loops };
  }

  it('routes sfx:play with tuple positions', () => {
    const { calls, events } = setup();
    events.emit('sfx:play', { id: 'bolt_hit', position: [1, 2, 3], volume: 0.5 });
    events.emit('sfx:play', { id: 'ui_click' });
    expect(calls).toContainEqual(['play', 'bolt_hit', [1, 2, 3], 0.5]);
    expect(calls).toContainEqual(['play', 'ui_click', null, undefined]);
  });

  it('applies settings, intensity, boss phases and state music', () => {
    const { calls, events, settings, off } = setup();
    settings.music = 0.3;
    events.emit('settings:changed', { key: 'music' });
    expect(calls).toContainEqual(['vol', settings.master, 0.3, settings.sfx]);
    events.emit('music:intensity', { layer: 'explore', level: 0.8 });
    expect(calls).toContainEqual(['int', 'explore', 0.8]);
    events.emit('boss:phase', { phase: 3 });
    expect(calls).toContainEqual(['int', 'boss', 1]);
    events.emit('state:change', { from: 'title', to: 'playing' });
    expect(calls).toContainEqual(['music', 'explore']);
    off();
    const n = calls.length;
    events.emit('sfx:play', { id: 'ui_click' });
    expect(calls.length).toBe(n);
  });

  it('combat follows max(trigger, fight heat) and the heat drains', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'performance'] });
    try {
      const { calls, events } = setup();
      const combat = () => calls.filter((c) => c[0] === 'int' && c[1] === 'combat').at(-1)?.[2] as number;
      events.emit('enemy:revealed', { id: 1, kind: 'smudge', first: true });
      expect(combat()).toBeCloseTo(0.45, 2);
      events.emit('music:intensity', { layer: 'combat', level: 0.6 });
      expect(combat()).toBeCloseTo(0.6, 2);
      events.emit('music:intensity', { layer: 'combat', level: 0 });
      expect(combat()).toBeGreaterThan(0.4);
      vi.advanceTimersByTime(30000);
      expect(combat()).toBe(0);
      expect(vi.getTimerCount()).toBe(0); // drain timer stops when idle
    } finally {
      vi.useRealTimers();
    }
  });

  it('boss music never runs ahead of the announced phase', () => {
    const { calls, events } = setup();
    const boss = () => calls.filter((c) => c[0] === 'int' && c[1] === 'boss').at(-1)?.[2] as number;
    events.emit('music:intensity', { layer: 'boss', level: 1 }); // arena trigger before the fight
    expect(boss()).toBeLessThan(0.5);
    events.emit('boss:phase', { phase: 2 });
    events.emit('music:intensity', { layer: 'boss', level: 1 });
    expect(boss()).toBeLessThan(0.84);
    events.emit('boss:phase', { phase: 3 });
    expect(boss()).toBe(1);
  });

  it('turns the one-shot sketch request into a loop that stops when printing stops', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    try {
      const { calls, events, loops } = setup();
      events.emit('sfx:play', { id: 'sketch_loop', volume: 0.6 });
      expect(loops.started).toBe(1);
      for (let i = 1; i <= 5; i++) {
        vi.advanceTimersByTime(100);
        events.emit('sketch:progress', { id: 'bridge', t: i * 0.05 });
      }
      expect(loops.stopped).toBe(0);
      vi.advanceTimersByTime(400);
      expect(loops.stopped).toBe(1);
      events.emit('sketch:progress', { id: 'bridge', t: 0.3 }); // resumes after a pause
      expect(loops.started).toBe(2);
      events.emit('sketch:printed', { id: 'bridge' });
      expect(loops.stopped).toBe(2);
      expect(calls.some((c) => c[0] === 'play' && c[1] === 'sketch_loop')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('plays the comic stinger on panel cuts', () => {
    const { calls, events } = setup();
    events.emit('fx:panelCut', { word: 'krak', focus: [0, 0, 0], reason: 'crit' });
    expect(calls).toContainEqual(['play', 'panel_stinger', null, undefined]);
  });
});
