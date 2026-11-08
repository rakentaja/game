import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '../../src/core/events';
import type { PlayerAPI } from '../../src/core/types';
import { Checkpoints } from '../../src/systems/checkpoints';
import { InkWells } from '../../src/world/inkWells';
import { LEVEL2 } from '../../src/world/Level2';

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => mem.set(k, v),
    removeItem: (k: string) => mem.delete(k),
  };
});

describe('Checkpoints', () => {
  it('saves on reach and respawns at the last checkpoint after death', async () => {
    const bus = new EventBus<GameEvents>();
    const tele: number[][] = [];
    const player = {
      teleport: (x: number, y: number, z: number) => tele.push([x, y, z]),
    } as unknown as PlayerAPI;
    let pending: (() => void) | null = null;
    let respawned = '';
    const cp = new Checkpoints(LEVEL2, bus, () => player, {
      setTimeout: (fn) => {
        pending = fn;
        return 0;
      },
      groundY: () => 2.2,
      onRespawn: (id) => (respawned = id),
    });
    const reached: string[] = [];
    bus.on('checkpoint:reached', ({ id }) => reached.push(id));
    bus.emit('trigger:fired', { id: 'p2_terrace' });
    expect(reached).toEqual(['p2_terrace']);
    expect(Checkpoints.resumePoint()).toEqual({ page: 2, id: 'p2_terrace' });

    bus.emit('player:died', {});
    bus.emit('player:died', {}); // double death event → one respawn
    expect(pending).not.toBeNull();
    await (pending as unknown as () => Promise<void>)();
    expect(tele).toEqual([[-2, 2.2, -51]]);
    expect(respawned).toBe('p2_terrace');
    cp.dispose();
  });

  it('records completion with best time', () => {
    Checkpoints.recordCompletion(300);
    const s = Checkpoints.recordCompletion(280);
    expect(s.bestTimeS).toBe(280);
    expect(s.completed).toBe(true);
    expect(s.lastCheckpoint).toBe(null);
  });
});

describe('InkWells', () => {
  it('grants ink once, then refills over time', () => {
    const bus = new EventBus<GameEvents>();
    const w = new InkWells([[0, 0, 30]], bus);
    let got = 0;
    const add = (n: number) => (got += n);
    w.update(0.016, 0.5, 0.5, 0, add);
    w.update(0.016, 0.5, 0.5, 0, add);
    expect(got).toBe(30);
    for (let t = 0; t < 30; t += 0.5) w.update(0.5, 10, 10, 0, add);
    w.update(0.016, 0, 0, 0, add);
    expect(got).toBe(60);
  });
});
