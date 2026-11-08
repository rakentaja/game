import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '../../src/core/events';
import type { TriggerDef } from '../../src/core/types';
import { Triggers } from '../../src/systems/triggers';

const defs: TriggerDef[] = [
  { id: 'cp', rect: [0, 0, 2, 2], action: { type: 'checkpoint' } },
  { id: 'spawn', rect: [10, 0, 12, 2], action: { type: 'spawn' } },
  { id: 'hint', rect: [20, 0, 22, 2], action: { type: 'tutorial', hint: 'dash' } },
  { id: 'again', rect: [30, 0, 32, 2], once: false, action: { type: 'music', layer: 'combat', level: 0.5 } },
  { id: 'end', rect: [40, 0, 42, 2], action: { type: 'pageEnd' } },
  { id: 'cut', rect: [50, 0, 52, 2], action: { type: 'panelCut', word: 'krak' } },
];

function setup() {
  const bus = new EventBus<GameEvents>();
  const fired: string[] = [];
  const log: string[] = [];
  bus.on('trigger:fired', ({ id }) => fired.push(id));
  bus.on('tutorial:hint', (p) => log.push(`hint:${p.hint}`));
  bus.on('page:complete', (p) => log.push(`end:${p.page}`));
  bus.on('music:intensity', (p) => log.push(`music:${p.level}`));
  bus.on('fx:panelCut', (p) => log.push(`cut:${p.word}:${p.focus.join(',')}`));
  return { bus, fired, log, t: new Triggers(defs, bus, 2) };
}

describe('Triggers', () => {
  it('fires on enter only, once by default', () => {
    const { t, fired } = setup();
    t.update(-1, 0, -1);
    expect(fired).toEqual([]);
    t.update(1, 0, 1);
    t.update(1.5, 0, 1.5);
    expect(fired).toEqual(['cp']);
    t.update(-5, 0, 0);
    t.update(1, 0, 1);
    expect(fired).toEqual(['cp']);
  });

  it('once:false re-fires on each new entry', () => {
    const { t, fired } = setup();
    t.update(31, 0, 1);
    t.update(31, 0, 1.2);
    t.update(25, 0, 1);
    t.update(31, 0, 1);
    expect(fired).toEqual(['again', 'again']);
  });

  it('built-in actions emit their events alongside trigger:fired', () => {
    const { t, log } = setup();
    t.update(21, 0, 1);
    t.update(41, 0, 1);
    t.update(31, 0, 1);
    t.update(51, 3, 1);
    expect(log).toEqual(['hint:dash', 'end:2', 'music:0.5', 'cut:krak:51,3,1']);
  });

  it('rearmEncounters replays spawns but not checkpoints/tutorials', () => {
    const { t, fired } = setup();
    t.update(1, 0, 1);
    t.update(11, 0, 1);
    t.update(21, 0, 1);
    t.rearmEncounters();
    t.update(-9, 0, -9);
    t.update(1, 0, 1);
    t.update(11, 0, 1);
    t.update(21, 0, 1);
    expect(fired).toEqual(['cp', 'spawn', 'hint', 'spawn']);
    expect(t.hasFired('hint')).toBe(true);
  });

  it('fireById ignores spent state', () => {
    const { t, fired } = setup();
    t.fireById('spawn');
    t.fireById('spawn');
    expect(fired).toEqual(['spawn', 'spawn']);
  });
});
