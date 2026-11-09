/**
 * Pair combos (lazy chunk; only co-op needs it). Every combo reads something a hero *leaves in
 * the world* for a few seconds — loops, lines, words, flats, dash trails, crystal circles — never
 * two presses that must land together, so it works under lag. Detection is pure: feed it the
 * `hero:action` stream (`ingest`) and it returns / emits `hero:combo`.
 *
 *   inkThePencils   Inker crystal over a Penciller loop → solid ink panel (open line → bridge)
 *   soundAndLight   Inker bolt through a flying word → split; word landing in the mask → 3 m burst
 *   overprint       Colorist flat ∩ Inker mask → ×2 damage; bucket on the 7 m mask → freeze circle
 *   speedLines      Letterer WHOOSH along a Penciller construction line → grind rail
 *   coloringBook    Colorist spray inside a Penciller loop → the loop fills as a colour flat
 *   chromaticChorus Letterer on-beat words through flats take colour; 3 colours in a row → blast
 *
 * Effects are wave 3 (co-op side); `ComboHit.data` carries what they need.
 */
import type { EventBus, GameEvents } from '../../core/events';
import type { HeroId, PlayerSlot } from '../../core/types';
import { TUNING } from '../../data/tuning';
import { type LoopResult, makeLoopResult, pointInLoop } from '../../systems/combat';
import type { HeroActionEvent } from './HeroKit';
import { distSqSeg } from './util';

export type ComboId =
  | 'inkThePencils'
  | 'soundAndLight'
  | 'overprint'
  | 'speedLines'
  | 'coloringBook'
  | 'chromaticChorus';

export interface ComboHit {
  combo: ComboId;
  x: number;
  z: number;
  /** Variant: 'panel' | 'bridge' | 'split' | 'burst' | 'double' | 'freeze' | 'grind' | 'fill' | 'blast'. */
  kind: string;
  /** Colour index (0 teal, 1 salmon, 2 gold) where it applies. */
  col?: number;
  /** Area radius (panel / fill / overprint / burst), m. */
  r?: number;
  /** The line it runs along (bridge / grind / split): a → b. */
  seg?: [number, number, number, number];
}

interface Base {
  pid: PlayerSlot;
  hero: HeroId;
  t: number;
}
interface Circle extends Base {
  x: number;
  z: number;
  r: number;
}
interface Loop extends Base {
  loop: LoopResult;
}
interface Seg extends Base {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}
interface Word extends Seg {
  beat: boolean;
  /** When it lands (sim time). */
  land: number;
}
interface Flat extends Circle {
  col: number;
}
interface Spray extends Base {
  x: number;
  z: number;
  col: number;
}

const segHitsCircle = (s: Seg, x: number, z: number, r: number) =>
  distSqSeg(x, z, s.ax, s.az, s.bx, s.bz) <= r * r;

function segsCross(a: Seg, b: Seg, slack: number): boolean {
  const rX = a.bx - a.ax;
  const rZ = a.bz - a.az;
  const sX = b.bx - b.ax;
  const sZ = b.bz - b.az;
  const den = rX * sZ - rZ * sX;
  if (Math.abs(den) > 1e-9) {
    const t = ((b.ax - a.ax) * sZ - (b.az - a.az) * sX) / den;
    const u = ((b.ax - a.ax) * rZ - (b.az - a.az) * rX) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return true;
  }
  const s2 = slack * slack;
  return (
    distSqSeg(b.ax, b.az, a.ax, a.az, a.bx, a.bz) <= s2 ||
    distSqSeg(b.bx, b.bz, a.ax, a.az, a.bx, a.bz) <= s2 ||
    distSqSeg(a.ax, a.az, b.ax, b.az, b.bx, b.bz) <= s2 ||
    distSqSeg(a.bx, a.bz, b.ax, b.az, b.bx, b.bz) <= s2
  );
}

export class ComboDetector {
  readonly crystals: Circle[] = [];
  readonly loops: Loop[] = [];
  readonly lines: Seg[] = [];
  readonly words: Word[] = [];
  readonly flats: Flat[] = [];
  readonly sprays: Spray[] = [];
  readonly bolts: Seg[] = [];
  readonly dashes: Seg[] = [];
  /** Letterer: colours of the last on-beat words (Chromatic Chorus). */
  readonly chorus: number[] = [];

  /** Last time each combo variant fired (the same artifacts must not re-trigger every tick). */
  private last = new Map<string, number>();

  constructor(private ttl = TUNING.heroes.combos.ttl) {}

  /** Feed one action at sim time `now`; returns the combos it completes. */
  ingest(e: HeroActionEvent, now: number): ComboHit[] {
    this.expire(now);
    const d = e.data ?? {};
    const base: Base = { pid: e.pid, hero: e.hero, t: now };
    const out: ComboHit[] = [];
    const num = (k: string) => Number(d[k] ?? 0);
    const arr = (k: string) => (Array.isArray(d[k]) ? (d[k] as number[]) : null);
    switch (e.hero) {
      case 'inker':
        if (e.action === 'hold') this.addCrystal({ ...base, x: num('x'), z: num('z'), r: num('r') }, out);
        else if (e.action === 'tap') {
          const f = arr('from');
          const to = arr('to');
          if (f && to) this.addBolt({ ...base, ax: f[0]!, az: f[1]!, bx: to[0]!, bz: to[1]! }, now, out);
        }
        break;
      case 'penciller': {
        const pts = arr('pts');
        if (e.action === 'hold' && d.kind === 'loop' && pts) {
          const loop = makeLoopResult(pts.length / 2);
          for (let i = 0; i + 1 < pts.length; i += 2) {
            loop.px[loop.count] = pts[i]!;
            loop.pz[loop.count++] = pts[i + 1]!;
          }
          loop.cx = num('cx');
          loop.cz = num('cz');
          loop.area = num('area');
          this.addLoop({ ...base, loop }, out);
        } else if (e.action === 'release' && pts) {
          for (let i = 0; i + 3 < pts.length; i += 2)
            this.addLine({ ...base, ax: pts[i]!, az: pts[i + 1]!, bx: pts[i + 2]!, bz: pts[i + 3]! }, out);
        } else if (e.action === 'tap') {
          const f = arr('from');
          const to = arr('to');
          if (f && to) this.addLine({ ...base, ax: f[0]!, az: f[1]!, bx: to[0]!, bz: to[1]! }, out);
        }
        break;
      }
      case 'letterer':
        if (e.action === 'tap') {
          const f = arr('from');
          const to = arr('to');
          if (f && to) {
            const len = Math.hypot(to[0]! - f[0]!, to[1]! - f[1]!);
            const land = now + len / TUNING.heroes.letterer.speed;
            this.addWord(
              { ...base, ax: f[0]!, az: f[1]!, bx: to[0]!, bz: to[1]!, beat: !!num('beat'), land },
              out,
            );
          }
        } else if (e.action === 'swipe') this.addDash(this.dashSeg(base, d), out);
        break;
      case 'colorist':
        if (e.action === 'hold')
          this.addFlat({ ...base, x: num('x'), z: num('z'), r: num('r'), col: num('col') }, out);
        else if (e.action === 'tap') {
          const to = arr('to');
          if (to) this.addSpray({ ...base, x: to[0]!, z: to[1]!, col: num('col') }, out);
        }
        break;
    }
    if (!out.length) return out;
    return out.filter((h) => {
      if (h.combo === 'chromaticChorus') return true;
      const k = `${h.combo}:${h.kind}`;
      if (now - (this.last.get(k) ?? -1e9) < this.ttl * 0.5) return false;
      this.last.set(k, now);
      return true;
    });
  }

  private dashSeg(base: Base, d: Record<string, unknown>): Seg {
    const f = (d.from as number[]) ?? [0, 0];
    const dir = (d.dir as number[]) ?? [0, 1];
    const L = TUNING.dash.distance;
    return { ...base, ax: f[0]!, az: f[1]!, bx: f[0]! + dir[0]! * L, bz: f[1]! + dir[1]! * L };
  }

  // ───────── rules ─────────

  private addCrystal(c: Circle, out: ComboHit[]): void {
    push(this.crystals, c);
    for (const l of this.loops) if (l.pid !== c.pid) this.inkPencils(c, l, out);
    this.inkLine(c, out);
    for (const f of this.flats) if (f.pid !== c.pid) this.overprint(c, f, false, out);
    for (const w of this.words) if (w.pid !== c.pid) this.wordInMask(w, c, out);
  }

  private addLoop(l: Loop, out: ComboHit[]): void {
    push(this.loops, l);
    for (const c of this.crystals) if (c.pid !== l.pid) this.inkPencils(c, l, out);
    for (const s of this.sprays) if (s.pid !== l.pid) this.coloringBook(s, l, out);
  }

  private addLine(s: Seg, out: ComboHit[]): void {
    push(this.lines, s);
    for (const c of this.crystals) if (c.pid !== s.pid) this.inkLine(c, out);
    for (const d of this.dashes) if (d.pid !== s.pid) this.grind(d, s, out);
  }

  private addBolt(b: Seg, now: number, out: ComboHit[]): void {
    push(this.bolts, b);
    const R = TUNING.heroes.combos.wordRadius;
    for (const w of this.words) {
      if (w.pid === b.pid || w.land < now) continue; // only words still in the air
      if (segsCross(b, w, R))
        out.push({
          combo: 'soundAndLight',
          x: (w.ax + w.bx) / 2,
          z: (w.az + w.bz) / 2,
          kind: 'split',
          seg: [w.ax, w.az, w.bx, w.bz],
        });
    }
  }

  private addWord(w: Word, out: ComboHit[]): void {
    push(this.words, w);
    for (const c of this.crystals) if (c.pid !== w.pid) this.wordInMask(w, c, out);
    const R = TUNING.heroes.combos.wordRadius;
    for (const b of this.bolts)
      if (b.pid !== w.pid && segsCross(b, w, R))
        out.push({ combo: 'soundAndLight', x: w.bx, z: w.bz, kind: 'split', seg: [w.ax, w.az, w.bx, w.bz] });
    if (!w.beat) return;
    // Chromatic Chorus: an on-beat word through a partner's flat takes its colour
    let col = -1;
    for (const f of this.flats) if (f.pid !== w.pid && segHitsCircle(w, f.x, f.z, f.r)) col = f.col;
    if (col < 0) return;
    this.chorus.push(col);
    if (this.chorus.length > 3) this.chorus.shift();
    if (this.chorus.length === 3 && new Set(this.chorus).size === 3) {
      out.push({ combo: 'chromaticChorus', x: w.bx, z: w.bz, kind: 'blast' });
      this.chorus.length = 0;
    } else out.push({ combo: 'chromaticChorus', x: w.bx, z: w.bz, kind: 'color', col });
  }

  private addFlat(f: Flat, out: ComboHit[]): void {
    push(this.flats, f);
    for (const c of this.crystals) if (c.pid !== f.pid) this.overprint(c, f, true, out);
  }

  private addSpray(s: Spray, out: ComboHit[]): void {
    push(this.sprays, s);
    for (const l of this.loops) if (l.pid !== s.pid) this.coloringBook(s, l, out);
  }

  private addDash(d: Seg, out: ComboHit[]): void {
    push(this.dashes, d);
    for (const l of this.lines) if (l.pid !== d.pid) this.grind(d, l, out);
  }

  private inkPencils(c: Circle, l: Loop, out: ComboHit[]): void {
    const dx = l.loop.cx - c.x;
    const dz = l.loop.cz - c.z;
    if (dx * dx + dz * dz > c.r * c.r) return;
    out.push({
      combo: 'inkThePencils',
      x: l.loop.cx,
      z: l.loop.cz,
      kind: 'panel',
      r: Math.sqrt(Math.max(0, l.loop.area) / Math.PI),
    });
  }

  /** An open pencil line mostly inside the crystal prints as a bridge / ramp. */
  private inkLine(c: Circle, out: ComboHit[]): void {
    let inside = 0;
    let total = 0;
    let sx = 0;
    let sz = 0;
    let first: Seg | null = null;
    let lastS: Seg | null = null;
    for (const s of this.lines) {
      if (s.pid === c.pid || s.hero !== 'penciller') continue;
      total++;
      const mx = (s.ax + s.bx) / 2;
      const mz = (s.az + s.bz) / 2;
      if ((mx - c.x) ** 2 + (mz - c.z) ** 2 <= c.r * c.r) {
        inside++;
        sx += mx;
        sz += mz;
        first ??= s;
        lastS = s;
      }
    }
    if (total >= 2 && inside / total >= 0.5 && first && lastS)
      out.push({
        combo: 'inkThePencils',
        x: sx / inside,
        z: sz / inside,
        kind: 'bridge',
        seg: [first.ax, first.az, lastS.bx, lastS.bz],
      });
  }

  private overprint(c: Circle, f: Flat, bucket: boolean, out: ComboHit[]): void {
    const d = Math.hypot(f.x - c.x, f.z - c.z);
    if (d > c.r + f.r) return;
    const big = bucket && c.r >= TUNING.crystal.radiusHeld * 0.9 && d <= c.r;
    out.push(
      big
        ? { combo: 'overprint', x: c.x, z: c.z, kind: 'freeze', col: f.col, r: c.r }
        : { combo: 'overprint', x: f.x, z: f.z, kind: 'double', col: f.col, r: f.r },
    );
  }

  private wordInMask(w: Word, c: Circle, out: ComboHit[]): void {
    if ((w.bx - c.x) ** 2 + (w.bz - c.z) ** 2 > c.r * c.r) return;
    out.push({ combo: 'soundAndLight', x: w.bx, z: w.bz, kind: 'burst' });
  }

  private grind(d: Seg, l: Seg, out: ComboHit[]): void {
    const G = TUNING.heroes.combos.grindDist;
    const g2 = G * G;
    if (distSqSeg(d.ax, d.az, l.ax, l.az, l.bx, l.bz) > g2) return;
    if (distSqSeg(d.bx, d.bz, l.ax, l.az, l.bx, l.bz) > g2) return;
    const dl = Math.hypot(d.bx - d.ax, d.bz - d.az) || 1;
    const ll = Math.hypot(l.bx - l.ax, l.bz - l.az) || 1;
    const cos = ((d.bx - d.ax) * (l.bx - l.ax) + (d.bz - d.az) * (l.bz - l.az)) / (dl * ll);
    if (Math.abs(cos) < 0.8) return;
    out.push({
      combo: 'speedLines',
      x: (l.ax + l.bx) / 2,
      z: (l.az + l.bz) / 2,
      kind: 'grind',
      seg: [l.ax, l.az, l.bx, l.bz],
    });
  }

  private coloringBook(s: Spray, l: Loop, out: ComboHit[]): void {
    if (!pointInLoop(s.x, s.z, l.loop)) return;
    out.push({
      combo: 'coloringBook',
      x: l.loop.cx,
      z: l.loop.cz,
      kind: 'fill',
      col: s.col,
      r: Math.sqrt(Math.max(0, l.loop.area) / Math.PI),
    });
  }

  private expire(now: number): void {
    const ttl = this.ttl;
    for (const list of [
      this.crystals,
      this.loops,
      this.lines,
      this.flats,
      this.sprays,
      this.bolts,
      this.dashes,
    ] as Base[][])
      while (list.length && now - list[0]!.t > ttl) list.shift();
    while (this.words.length && now - this.words[0]!.land > ttl) this.words.shift();
  }
}

function push<T>(list: T[], v: T, max = 24): void {
  list.push(v);
  if (list.length > max) list.shift();
}

/**
 * Wire a detector to the bus: every completed combo becomes `hero:combo` (and goes to `onHit`,
 * the co-op effect resolver, first).
 */
export function installCombos(
  events: EventBus<GameEvents>,
  clock: () => number,
  groundY: (x: number, z: number) => number = () => 0,
  onHit?: (h: ComboHit) => void,
): () => void {
  const det = new ComboDetector();
  return events.on('hero:action', (e) => {
    for (const h of det.ingest(e, clock())) {
      onHit?.(h);
      events.emit('hero:combo', { combo: h.combo, kind: h.kind, position: [h.x, groundY(h.x, h.z), h.z] });
    }
  });
}
