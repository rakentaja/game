import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '../../src/core/events';
import type { SketchObjectDef } from '../../src/core/types';
import { TUNING } from '../../src/data/tuning';
import { type CrystalSample, SketchObjects } from '../../src/systems/sketch-objects';

const DT = 1 / 60;
const bridge: SketchObjectDef = {
  id: 'b',
  type: 'bridge',
  at: [0, 0, -10],
  rotY: 0,
  unlocks: [-1, -14, 1, -6],
  ambushTrigger: 'ambush',
};
const door: SketchObjectDef = { id: 'd', type: 'bossDoor', at: [0, 0, -30], rotY: 0, requires: 'cleared' };

function setup() {
  const bus = new EventBus<GameEvents>();
  const unlocked: string[] = [];
  const ev: string[] = [];
  bus.on('trigger:fired', ({ id }) => ev.push(`trigger:${id}`));
  bus.on('sketch:printed', ({ id }) => ev.push(`printed:${id}`));
  bus.on('fx:panelCut', () => ev.push('cut'));
  const so = new SketchObjects(bus, { collision: { unlock: (id) => unlocked.push(id) } });
  so.add(bridge);
  so.add(door);
  return { bus, so, unlocked, ev };
}

const held = (x: number, z: number, radius = TUNING.crystal.radiusHeld): CrystalSample => ({
  held: true,
  x,
  z,
  radius,
});

describe('SketchObjects', () => {
  it('prints after exactly holdToPrint seconds of a wide, in-range hold', () => {
    const { so, unlocked, ev } = setup();
    const steps = Math.round(TUNING.sketch.holdToPrint / DT);
    for (let i = 0; i < steps - 1; i++) so.update(DT, held(0, -4));
    expect(so.isPrinted('b')).toBe(false);
    expect(so.progress('b')).toBeGreaterThan(0.98);
    so.update(DT, held(0, -4));
    expect(so.isPrinted('b')).toBe(true);
    expect(unlocked).toEqual(['b']);
    expect(ev).toEqual(['trigger:ambush', 'printed:b', 'cut']);
  });

  it('needs the crystal held, wide enough, and close enough', () => {
    const { so } = setup();
    for (let i = 0; i < 200; i++) so.update(DT, { held: false, x: 0, z: -9, radius: 7 });
    for (let i = 0; i < 200; i++) so.update(DT, held(0, -9, TUNING.crystal.radiusIdle));
    for (let i = 0; i < 200; i++) so.update(DT, held(0, 5));
    expect(so.progress('b')).toBe(0);
    expect(SketchObjects.inReach(bridge, held(0, -9))).toBe(true);
    expect(SketchObjects.inReach(bridge, held(0, -2.5))).toBe(false);
  });

  it('progress decays when the hold breaks and ambush fires only once', () => {
    const { so, ev } = setup();
    for (let i = 0; i < 60; i++) so.update(DT, held(0, -6));
    const mid = so.progress('b');
    expect(mid).toBeCloseTo(0.5, 1);
    for (let i = 0; i < 60; i++) so.update(DT, { held: false, x: 0, z: -6, radius: 3 });
    expect(so.progress('b')).toBeCloseTo(mid - TUNING.sketch.decayPerSec, 2);
    for (let i = 0; i < 30; i++) so.update(DT, held(0, -6));
    expect(ev.filter((e) => e === 'trigger:ambush').length).toBe(1);
  });

  it('`requires` keeps a sketch dormant until its trigger fires', () => {
    const { so, bus } = setup();
    for (let i = 0; i < 200; i++) so.update(DT, held(0, -27));
    expect(so.progress('d')).toBe(0);
    bus.emit('trigger:fired', { id: 'cleared' });
    for (let i = 0; i < 125; i++) so.update(DT, held(0, -27));
    expect(so.isPrinted('d')).toBe(true);
  });

  it('resetUnprinted clears progress and re-arms the ambush; printed stays printed', () => {
    const { so, ev } = setup();
    for (let i = 0; i < 30; i++) so.update(DT, held(0, -6));
    so.printNow('d', true);
    so.resetUnprinted();
    expect(so.progress('b')).toBe(0);
    expect(so.isPrinted('d')).toBe(true);
    so.update(DT, held(0, -6));
    expect(ev.filter((e) => e === 'trigger:ambush').length).toBe(2);
  });

  it('weak points can be added/removed at runtime (boss)', () => {
    const { so } = setup();
    so.add({ id: 'wp0', type: 'weakpoint', at: [5, 4, 5], rotY: 0 });
    expect(so.count).toBe(3);
    expect(() => so.add({ id: 'wp0', type: 'weakpoint', at: [0, 0, 0], rotY: 0 })).toThrow();
    so.remove('wp0');
    expect(so.count).toBe(2);
  });
});
