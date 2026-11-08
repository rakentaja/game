import type { EventBus, GameEvents } from '../core/events';
import type { RevealAPI, SketchObjectDef } from '../core/types';
import { TUNING } from '../data/tuning';

/** What the print check needs each step (filled by the caller from player + reveal). */
export interface CrystalSample {
  held: boolean;
  x: number;
  z: number;
  /** Current animated reveal radius (m). */
  radius: number;
}

/** Visual side of a sketch (three.js lives in src/world/sketchVisual.ts). */
export interface SketchVisual {
  setProgress(t: number): void;
  /** Called once when the print completes. */
  stamp(): void;
  update(dt: number, time: number): void;
  /** Dormant sketches (`requires` not met) draw faint, without the reach ring. */
  setEnabled?(on: boolean): void;
  dispose(): void;
}

export type SketchVisualFactory = (def: SketchObjectDef) => SketchVisual | null;

export interface SketchUnlocker {
  unlock(id: string, deck?: boolean): void;
}

interface Entry {
  def: SketchObjectDef;
  t: number;
  printed: boolean;
  enabled: boolean;
  ambushed: boolean;
  wasActive: boolean;
  visual: SketchVisual | null;
  revealHandle: number;
}

/**
 * Dashed pencil objects that become real when the crystal is held wide (≥ requiredRadius) over
 * them for `holdToPrint` seconds. Progress decays slowly when the hold breaks. Starting a print
 * springs the ambush (`trigger:fired` with the sketch's ambushTrigger). On completion: stamp FX,
 * permanent reveal source, collision unlock, `sketch:printed`.
 *
 * `sketch:progress` payloads are a reused object — read them synchronously, don't keep them.
 */
export class SketchObjects {
  private readonly list: Entry[] = [];
  private readonly progressMsg = { id: '', t: 0 };
  private time = 0;
  private offTrigger: (() => void) | null = null;

  constructor(
    private readonly events: EventBus<GameEvents>,
    private readonly opts: {
      collision?: SketchUnlocker | null;
      reveal?: RevealAPI | null;
      visuals?: SketchVisualFactory | null;
      /** Ground Y for FX focus points. */
      groundY?: (x: number, z: number) => number;
    } = {},
  ) {
    this.offTrigger = events.on('trigger:fired', ({ id }) => {
      for (const e of this.list)
        if (e.def.requires === id && !e.enabled) {
          e.enabled = true;
          e.visual?.setEnabled?.(true);
        }
    });
  }

  add(def: SketchObjectDef): void {
    if (this.list.some((e) => e.def.id === def.id)) throw new Error(`sketch ${def.id} exists`);
    this.list.push({
      def,
      t: 0,
      printed: false,
      enabled: !def.requires,
      ambushed: false,
      wasActive: false,
      visual: this.opts.visuals?.(def) ?? null,
      revealHandle: -1,
    });
    if (def.requires) this.list[this.list.length - 1]!.visual?.setEnabled?.(false);
  }

  remove(id: string): void {
    const i = this.list.findIndex((e) => e.def.id === id);
    if (i < 0) return;
    const e = this.list[i]!;
    e.visual?.dispose();
    if (e.revealHandle >= 0) this.opts.reveal?.removeSource(e.revealHandle);
    this.list.splice(i, 1);
  }

  enable(id: string, on = true): void {
    const e = this.find(id);
    if (e) {
      e.enabled = on;
      e.visual?.setEnabled?.(on);
    }
  }

  /** 0..1 progress, or -1 if unknown. */
  progress(id: string): number {
    return this.find(id)?.t ?? -1;
  }

  isPrinted(id: string): boolean {
    return this.find(id)?.printed ?? false;
  }

  isEnabled(id: string): boolean {
    return this.find(id)?.enabled ?? false;
  }

  get count(): number {
    return this.list.length;
  }

  /** Can this crystal sample print sketch `def` right now? (pure; used by update + tests) */
  static inReach(def: SketchObjectDef, c: CrystalSample): boolean {
    const S = TUNING.sketch;
    if (!c.held || c.radius < S.requiredRadius * S.radiusSlack) return false;
    const dx = def.at[0] - c.x;
    const dz = def.at[2] - c.z;
    const reach = Math.min(c.radius, S.requiredRadius);
    return dx * dx + dz * dz <= reach * reach;
  }

  update(dt: number, c: CrystalSample): void {
    this.time += dt;
    const S = TUNING.sketch;
    for (const e of this.list) {
      e.visual?.update(dt, this.time);
      if (e.printed || !e.enabled) continue;
      const active = SketchObjects.inReach(e.def, c);
      const before = e.t;
      if (active) {
        e.t = Math.min(1, e.t + dt / S.holdToPrint);
        if (!e.ambushed && e.def.ambushTrigger) {
          e.ambushed = true;
          this.events.emit('trigger:fired', { id: e.def.ambushTrigger });
        }
        if (!e.wasActive) this.events.emit('sfx:play', { id: 'sketch_loop', volume: 0.6 });
      } else if (e.t > 0) {
        e.t = Math.max(0, e.t - S.decayPerSec * dt);
      }
      e.wasActive = active;
      if (e.t !== before) {
        e.visual?.setProgress(e.t);
        this.progressMsg.id = e.def.id;
        this.progressMsg.t = e.t;
        this.events.emit('sketch:progress', this.progressMsg);
      }
      if (e.t >= 1 - 1e-6) this.print(e);
    }
  }

  /** Force-print (debug, cinematics, restoring a save). `silent` skips FX. */
  printNow(id: string, silent = false): void {
    const e = this.find(id);
    if (e && !e.printed) this.print(e, silent);
  }

  private print(e: Entry, silent = false): void {
    e.printed = true;
    e.t = 1;
    const d = e.def;
    e.visual?.setProgress(1);
    e.visual?.stamp();
    this.opts.collision?.unlock(d.id, d.type === 'bridge');
    if (this.opts.reveal) {
      e.revealHandle = this.opts.reveal.addSource(d.at[0], d.at[2], TUNING.sketch.printedRevealRadius, 1e9);
    }
    this.events.emit('sketch:printed', { id: d.id });
    if (silent) return;
    const y = this.opts.groundY?.(d.at[0], d.at[2]) ?? d.at[1];
    const pos: [number, number, number] = [d.at[0], y, d.at[2]];
    this.events.emit('sfx:play', { id: 'sketch_done', position: pos });
    this.events.emit('fx:shake', { intensity: d.type === 'weakpoint' ? 0.25 : 0.5, duration: 0.3 });
    this.events.emit('fx:hitstop', { duration: 0.07 });
    if (d.type !== 'weakpoint')
      this.events.emit('fx:panelCut', { word: 'krak', focus: pos, reason: `print:${d.id}` });
  }

  /** After a respawn: unprinted sketches lose progress and can ambush again. */
  resetUnprinted(): void {
    for (const e of this.list) {
      if (e.printed) continue;
      e.t = 0;
      e.ambushed = false;
      e.wasActive = false;
      e.visual?.setProgress(0);
    }
  }

  private find(id: string): Entry | undefined {
    return this.list.find((e) => e.def.id === id);
  }

  dispose(): void {
    this.offTrigger?.();
    this.offTrigger = null;
    for (const e of this.list) {
      e.visual?.dispose();
      if (e.revealHandle >= 0) this.opts.reveal?.removeSource(e.revealHandle);
    }
    this.list.length = 0;
  }
}
