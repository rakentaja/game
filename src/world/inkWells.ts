import type { EventBus, GameEvents } from '../core/events';
import type { Vec3T } from '../core/types';
import { TUNING } from '../data/tuning';

export interface WellState {
  x: number;
  z: number;
  energy: number;
  /** 0 = drained, 1 = full. */
  charge: number;
}

/**
 * Ink wells: walk into one to drink its ink. Drained wells refill over `world.wellRefill` so a
 * print can never be softlocked by an empty tank. Visuals read `wells[i].charge`.
 */
export class InkWells {
  readonly wells: WellState[];
  private readonly pickupMsg = {
    id: 'ink_pickup' as const,
    position: [0, 0, 0] as [number, number, number],
    volume: 0.9,
  };

  constructor(
    defs: readonly Vec3T[],
    private readonly events: EventBus<GameEvents>,
  ) {
    this.wells = defs.map(([x, z, energy]) => ({ x, z, energy, charge: 1 }));
  }

  /** Returns energy granted this step (0 most steps). */
  update(dt: number, px: number, pz: number, py: number, addEnergy: (n: number) => void): number {
    const W = TUNING.world;
    const r2 = W.wellRadius * W.wellRadius;
    let granted = 0;
    for (const w of this.wells) {
      if (w.charge < 1) w.charge = Math.min(1, w.charge + dt / W.wellRefill);
      const dx = px - w.x;
      const dz = pz - w.z;
      if (w.charge >= 1 && dx * dx + dz * dz <= r2) {
        w.charge = 0;
        granted += w.energy;
        addEnergy(w.energy);
        this.pickupMsg.position[0] = w.x;
        this.pickupMsg.position[1] = py;
        this.pickupMsg.position[2] = w.z;
        this.events.emit('sfx:play', this.pickupMsg);
      }
    }
    return granted;
  }

  refillAll(): void {
    for (const w of this.wells) w.charge = 1;
  }
}
