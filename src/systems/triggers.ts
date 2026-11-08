import type { EventBus, GameEvents } from '../core/events';
import type { PageId, TriggerDef } from '../core/types';

/**
 * Axis-aligned trigger rects. Fires on *enter* (edge), `once` by default. Every firing emits
 * `trigger:fired {id}` (spawner, checkpoints and level code listen); built-in actions also emit
 * their own event. Allocation-free while nothing fires.
 */
export class Triggers {
  private readonly inside: Uint8Array;
  private readonly spent: Uint8Array;
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

  /** Feed the player position once per sim step. */
  update(x: number, y: number, z: number): void {
    if (!this.enabled) return;
    for (let i = 0; i < this.defs.length; i++) {
      const t = this.defs[i]!;
      const r = t.rect;
      const inn = x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3] ? 1 : 0;
      if (inn && !this.inside[i] && !this.spent[i]) {
        if (t.once !== false) this.spent[i] = 1;
        this.focus[0] = x;
        this.focus[1] = y;
        this.focus[2] = z;
        this.fire(t);
      }
      this.inside[i] = inn;
    }
  }

  private fire(t: TriggerDef): void {
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
