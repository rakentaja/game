import type { EventBus, GameEvents } from '../core/events';
import type { PageId, TriggerDef } from '../core/types';

/**
 * Axis-aligned trigger rects. Fires on *enter* (edge), `once` by default. Every firing emits
 * `trigger:fired {id}` (spawner, checkpoints and level code listen); built-in actions also emit
 * their own event. Allocation-free while nothing fires.
 */
export class Triggers {
  private readonly inside: Uint8Array;
  /** @internal co-op page save reads / restores it */
  readonly spent: Uint8Array;
  private readonly focus: [number, number, number] = [0, 0, 0];
  enabled = true;

  constructor(
    readonly defs: readonly TriggerDef[],
    private readonly events: EventBus<GameEvents>,
    private readonly page: PageId,
  ) {
    this.inside = new Uint8Array(defs.length);
    this.spent = new Uint8Array(defs.length);
  }

  /**
   * Co-op: per-player "inside the page-end rect" (index = slot), refreshed by `updateAll`.
   * The HUD reads it for the "waiting for your partner" hint.
   */
  readonly atExit = new Uint8Array(2);

  /** Feed the player position once per sim step. */
  update(x: number, y: number, z: number): void {
    this.pts[0] = x;
    this.pts[1] = y;
    this.pts[2] = z;
    this.updateAll(this.pts, 1);
  }

  private readonly pts = new Float32Array(6);

  /**
   * Co-op: feed every player (`pts` = x,y,z triples, `n` players). Regular triggers fire when
   * ANY player enters; a `pageEnd` trigger only fires once ALL `n` players are inside it.
   */
  updateAll(pts: ArrayLike<number>, n: number): void {
    if (!this.enabled) return;
    for (let i = 0; i < this.defs.length; i++) {
      const t = this.defs[i]!;
      const r = t.rect;
      const all = t.action?.type === 'pageEnd';
      let inn = all ? 1 : 0;
      let fx = 0;
      let fy = 0;
      let fz = 0;
      for (let k = 0; k < n; k++) {
        const x = pts[k * 3]!;
        const z = pts[k * 3 + 2]!;
        const ink = x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3];
        if (all && k < 2) this.atExit[k] = ink ? 1 : 0;
        if (ink && !fx && !fz) {
          fx = x;
          fy = pts[k * 3 + 1]!;
          fz = z;
        }
        if (all && !ink) inn = 0;
        else if (!all && ink) inn = 1;
      }
      if (inn && !this.inside[i] && !this.spent[i]) {
        if (t.once !== false) this.spent[i] = 1;
        this.focus[0] = fx;
        this.focus[1] = fy;
        this.focus[2] = fz;
        this.fire(t);
      }
      this.inside[i] = inn;
    }
  }

  /** @internal (co-op replicas call it) */
  fire(t: TriggerDef): void {
    const a = t.action;
    if (a) {
      switch (a.type) {
        case 'panelCut':
          this.events.emit('fx:panelCut', { word: a.word, focus: [...this.focus], reason: t.id });
          break;
        case 'tutorial':
          this.events.emit('tutorial:hint', { hint: a.hint, show: true });
          break;
        case 'pageEnd':
          this.events.emit('page:complete', { page: this.page });
          break;
        case 'music':
          this.events.emit('music:intensity', { layer: a.layer, level: a.level });
          break;
        default:
          break;
      }
    }
    this.events.emit('trigger:fired', { id: t.id });
  }

  /** Fire a trigger by id from code (cinematics, tests). Ignores `once`/spent state. */
  fireById(id: string): void {
    const t = this.defs.find((d) => d.id === id);
    if (t) this.fire(t);
  }

  hasFired(id: string): boolean {
    const i = this.defs.findIndex((d) => d.id === id);
    return i >= 0 && this.spent[i] === 1;
  }

  /**
   * After a respawn: re-arm encounter triggers (spawn / music / panel cut) so fights replay;
   * checkpoints, tutorials and page ends stay spent. `inside` is recomputed on the next update.
   */
  rearmEncounters(): void {
    for (let i = 0; i < this.defs.length; i++) {
      const ty = this.defs[i]!.action?.type;
      if (ty === 'spawn' || ty === 'music' || ty === 'panelCut') this.spent[i] = 0;
      this.inside[i] = 1; // don't re-fire for the rect we respawn inside of
    }
  }

  reset(): void {
    this.spent.fill(0);
    this.inside.fill(0);
  }
}
