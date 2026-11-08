import type * as THREE from 'three';
import type { Damageable, TargetRegistry } from '../core/types';

/**
 * Flat array registry of everything bolts can hit. Swap-remove keeps it dense; `nearest` and
 * `forEach` iterate by index so nothing allocates per frame.
 */
export class Targets implements TargetRegistry {
  private items: Damageable[] = [];

  get size(): number {
    return this.items.length;
  }

  add(t: Damageable): void {
    if (this.items.indexOf(t) === -1) this.items.push(t);
  }

  remove(t: Damageable): void {
    const i = this.items.indexOf(t);
    if (i === -1) return;
    const last = this.items.length - 1;
    this.items[i] = this.items[last]!;
    this.items.length = last;
  }

  nearest(p: THREE.Vector3, maxRange: number): Damageable | null {
    let best: Damageable | null = null;
    let bestD = maxRange * maxRange;
    const items = this.items;
    for (let i = 0; i < items.length; i++) {
      const t = items[i]!;
      if (!t.alive || !t.revealed) continue;
      const dx = t.position.x - p.x;
      const dz = t.position.z - p.z;
      // Measure to the target's edge so big targets (boss weak points) win ties fairly.
      const r = Math.max(0, Math.sqrt(dx * dx + dz * dz) - t.radius);
      const d = r * r;
      if (d <= bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  forEach(fn: (t: Damageable) => void): void {
    const items = this.items;
    for (let i = 0; i < items.length; i++) fn(items[i]!);
  }

  clear(): void {
    this.items.length = 0;
  }
}

export function createTargets(): Targets {
  return new Targets();
}
