/**
 * Who the ink flies to in co-op. InkPickups magnetises toward ONE player, so the router picks a
 * recipient: the standing, not-full wizard nearest to the latest ink drop (sticky for a moment
 * so droplets don't flip-flop mid-flight).
 */
import * as THREE from 'three';
import type { GameContext, PlayerAPI } from '../core/types';
import type { InkPickups } from '../systems/ink-energy';

export interface InkRecipient {
  api: PlayerAPI;
  /** Credit `n` ink; returns the amount accepted. */
  add(n: number): number;
}

export class PickupRouter {
  private cur = 0;
  private stickT = 0;
  private readonly drop = new THREE.Vector3();
  private hasDrop = false;
  private off: () => void;

  constructor(
    private readonly ctx: GameContext,
    private readonly pickups: InkPickups,
    readonly recipients: InkRecipient[],
  ) {
    this.off = ctx.events.on('enemy:died', (e) => {
      this.drop.set(e.position[0], e.position[1], e.position[2]);
      this.hasDrop = true;
      this.stickT = 0;
    });
  }

  private ok(r: InkRecipient | undefined): boolean {
    return !!r && !r.api.downed && r.api.energy < this.ctx.tuning.energy.max - 0.01;
  }

  step(dt: number): void {
    const rs = this.recipients;
    this.stickT -= dt;
    if (rs.length > 1 && (this.stickT <= 0 || !this.ok(rs[this.cur]))) {
      let best = this.cur;
      let bd = Infinity;
      for (let i = 0; i < rs.length; i++) {
        const r = rs[i]!;
        if (!this.ok(r)) continue;
        const p = r.api.position;
        const ref = this.hasDrop ? this.drop : p;
        const d = Math.hypot(p.x - ref.x, p.z - ref.z) + (r.api.energy / this.ctx.tuning.energy.max) * 2;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      this.cur = Math.min(best, rs.length - 1);
      this.stickT = 1.2;
    }
    const r = rs[Math.min(this.cur, rs.length - 1)];
    if (!r) return;
    this.pickups.step(dt, r.api, (n) => r.add(n));
  }

  dispose(): void {
    this.off();
  }
}
