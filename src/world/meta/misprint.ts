/**
 * Misprint Zones: data-driven rects (LevelDef.misprints) where the press slips — plate
 * misregistration and the halftone line screen are boosted while the player stands inside.
 * Blends smoothly; writes the renderer's `misprint` multipliers (1 = neutral).
 */
import type { LevelDef } from '../../core/types';
import { TUNING } from '../../data/tuning';

export interface MisprintTarget {
  misprint: { misreg: number; halftone: number };
}

export class MisprintZones {
  private misreg = 1;
  private halftone = 1;

  constructor(
    private readonly zones: NonNullable<LevelDef['misprints']>,
    private readonly target: MisprintTarget | null,
  ) {}

  /** Target multipliers at (x,z): the strongest zone containing the point, else neutral. */
  sample(x: number, z: number): { misreg: number; halftone: number } {
    let m = 1;
    let h = 1;
    for (const zn of this.zones) {
      const r = zn.rect;
      if (x < r[0] || x > r[2] || z < r[1] || z > r[3]) continue;
      m = Math.max(m, zn.misreg);
      h = Math.max(h, zn.halftone);
    }
    return { misreg: m, halftone: h };
  }

  update(dt: number, x: number, z: number): void {
    if (!this.target) return;
    let m = 1;
    let h = 1;
    for (const zn of this.zones) {
      const r = zn.rect;
      if (x < r[0] || x > r[2] || z < r[1] || z > r[3]) continue;
      if (zn.misreg > m) m = zn.misreg;
      if (zn.halftone > h) h = zn.halftone;
    }
    const k = 1 - Math.exp(-dt * TUNING.worldMeta.misprint.blend);
    this.misreg += (m - this.misreg) * k;
    this.halftone += (h - this.halftone) * k;
    this.target.misprint.misreg = this.misreg;
    this.target.misprint.halftone = this.halftone;
  }

  get current(): { misreg: number; halftone: number } {
    return { misreg: this.misreg, halftone: this.halftone };
  }

  dispose(): void {
    if (!this.target) return;
    this.target.misprint.misreg = 1;
    this.target.misprint.halftone = 1;
  }
}
