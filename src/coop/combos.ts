/**
 * Pair-combo EFFECTS (co-op chunk). `entities/heroes/combos.ts` only detects; this resolves what a
 * combo does (design reference "Pair combos"):
 *
 *   inkThePencils  panel  the loop prints as a solid ink panel: revealed + ghosts inside slowed
 *                  bridge an open pencil line prints as an inked strip; ghosts on it stumble
 *   soundAndLight  split  a bolt through a flying word splits into one bolt per letter
 *                  burst  a word landing in the ink bursts into a 3 m reveal (+ a hit)
 *   overprint      double damage ×2 where the colour flat overlaps the ink
 *                  freeze a fill on the 7 m circle keeps it inked; ghosts inside freeze
 *   speedLines     grind  a dash along a ruler line inks the whole line, letters fire to both sides
 *   coloringBook   fill   a sprayed loop fills with the colour: big reveal + the colour's effect
 *   chromaticChorus color the word takes the flat's colour (+ its effect); blast = 3-colour SFX blast
 *
 * Split by authority (docs/COOP.md): `play(h, world)` always draws + inks (reveal is per machine);
 * `world` (host / local 2P) also hits, stuns, opens damage zones and cuts the panel — the panel
 * cut then reaches the guest through the host's shared-cut scheduling.
 */
import '../ui/i18n/heroes';
import * as THREE from 'three';
import type { Damageable, GameContext } from '../core/types';
import type { EnemySystem } from '../entities/enemies/EnemySystem';
import type { ComboHit, ComboId } from '../entities/heroes/combos';
import { C, HeroFx } from '../entities/heroes/fx';

type Ghost = Damageable & { kind?: string };

const COLS = [C.teal, C.salmon, C.gold];
const _from = new THREE.Vector3();
const _p: [number, number, number] = [0, 0, 0];

interface Zone {
  x: number;
  z: number;
  r: number;
  t: number;
}
interface Burn {
  id: number;
  t: number;
  dmg: number;
  x: number;
  z: number;
}

/** Combo → i18n key of its panel-cut word (lazy heroes dictionary). */
export const comboWord = (c: ComboId | string): string => `heroes.combo.${c}`;

export class ComboEffects {
  private fx: HeroFx | null = null;
  private readonly zones: Zone[] = [];
  private readonly burns: Burn[] = [];
  private lastCut = -1e9;
  private time = 0;
  /** Combos played so far, by id (tests / e2e). */
  readonly counts = new Map<string, number>();
  private readonly mul = (x: number, z: number) => this.damageAt(x, z);
  private findId = -1;
  private found: Damageable | null = null;
  private readonly scanId = (t: Damageable) => {
    if (t.id === this.findId) this.found = t;
  };

  constructor(
    private readonly ctx: GameContext,
    private readonly enemies: EnemySystem | null,
  ) {}

  private vfx(): HeroFx | null {
    if (this.fx) return this.fx;
    const scene = this.ctx.render?.scene;
    if (!scene || typeof document === 'undefined') return null;
    this.fx = new HeroFx(scene);
    return this.fx;
  }

  private get T() {
    return this.ctx.tuning.heroes.combos.fx;
  }

  private y(x: number, z: number): number {
    return this.ctx.collision.groundHeight(x, z);
  }

  /** Every live ghost within `r` of (x, z) (weak points excluded unless `all`). */
  private each(x: number, z: number, r: number, fn: (t: Damageable) => void, all = false): void {
    this.ctx.targets.forEach((t) => {
      if (!t.alive || (!all && (t as Ghost).kind === undefined)) return;
      const dx = t.position.x - x;
      const dz = t.position.z - z;
      const rr = r + t.radius;
      if (dx * dx + dz * dz <= rr * rr) fn(t);
    });
  }

  private strike(t: Damageable, dmg: number, x: number, z: number): void {
    _from.set(x, t.position.y, z);
    t.hit(dmg * this.ctx.tuning.bolt.damage, _from);
  }

  /** Ink a segment with reveal sources every `step` m (per machine). */
  private inkLine(seg: readonly number[], r: number, life: number, step: number): void {
    const [ax, az, bx, bz] = seg as [number, number, number, number];
    const L = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.min(6, Math.ceil(L / step)));
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      this.ctx.reveal.addSource(ax + (bx - ax) * k, az + (bz - az) * k, r, life);
    }
    this.vfx()?.lines.segment(C.ink, 0.12, life, ax, az, bx, bz, this.y(ax, az) + 0.02);
  }

  /** Is (x, z) within `w` of the segment? */
  private static nearSeg(x: number, z: number, s: readonly number[], w: number): boolean {
    const [ax, az, bx, bz] = s as [number, number, number, number];
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    let k = l2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    k = Math.min(1, Math.max(0, k));
    const ex = ax + dx * k - x;
    const ez = az + dz * k - z;
    return ex * ex + ez * ez <= w * w;
  }

  /**
   * Resolve one combo on this machine. `world`: also apply the gameplay (host / local 2P);
   * `cut`: emit the panel cut (the authority; online it is then scheduled for both machines).
   */
  play(h: ComboHit, world: boolean, cut = world): void {
    const T = this.T;
    const rv = this.ctx.reveal;
    const fx = this.vfx();
    const gy = this.y(h.x, h.z);
    this.counts.set(h.combo, (this.counts.get(h.combo) ?? 0) + 1);
    const col = COLS[(h.col ?? 2) % 3] ?? C.gold;
    switch (h.kind) {
      case 'panel': {
        const r = Math.min(T.panel.maxR, Math.max(T.panel.minR, (h.r ?? 2) + 0.6));
        rv.addSource(h.x, h.z, r, T.panel.life);
        fx?.discs.spawn(h.x, gy, h.z, r, C.ink, 1, T.panel.life);
        if (world) this.each(h.x, h.z, r, (t) => t.stun?.(T.panel.slow));
        break;
      }
      case 'bridge': {
        const s = h.seg ?? [h.x - 1, h.z, h.x + 1, h.z];
        this.inkLine(s, T.bridge.width, T.bridge.life, T.bridge.step);
        if (world)
          this.each(h.x, h.z, 12, (t) => {
            if (ComboEffects.nearSeg(t.position.x, t.position.z, s, T.bridge.width)) t.stun?.(T.bridge.stun);
          });
        break;
      }
      case 'split': {
        const s = h.seg ?? [h.x, h.z, h.x, h.z];
        const n = T.split.letters;
        const word = 'KAPOW';
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          fx?.air.spawn(
            word[i % word.length]!,
            h.x + Math.cos(a),
            gy + 1.2,
            h.z + Math.sin(a),
            0.6,
            C.red,
            0.6,
          );
        }
        if (!world) break;
        // one bolt per letter: the nearest distinct ghosts around the word
        const hitIds = new Set<number>();
        for (let i = 0; i < n; i++) {
          let best: Damageable | null = null;
          let bd = T.split.range * T.split.range;
          this.each(
            h.x,
            h.z,
            T.split.range,
            (t) => {
              if (hitIds.has(t.id) || !t.revealed) return;
              const d = (t.position.x - h.x) ** 2 + (t.position.z - h.z) ** 2;
              if (d < bd) {
                bd = d;
                best = t;
              }
            },
            true,
          );
          const b = best as Damageable | null;
          if (!b) break;
          hitIds.add(b.id);
          this.strike(b, T.split.damage, s[0], s[1]);
          fx?.lines.segment(C.red, 0.05, 0.4, h.x, h.z, b.position.x, b.position.z, gy + 0.05);
        }
        break;
      }
      case 'burst': {
        rv.addSource(h.x, h.z, T.burst.radius, T.burst.life);
        fx?.discs.spawn(h.x, gy, h.z, T.burst.radius, C.salmon, 2, 0.8);
        // the burst inks first: the hit waits for the mask to catch up
        if (world)
          this.each(h.x, h.z, T.burst.radius, (t) => this.later(t.id, T.burst.damage, h.x, h.z, 0.1));
        break;
      }
      case 'double': {
        const r = h.r ?? 2.5;
        fx?.discs.spawn(h.x, gy, h.z, r, col, 4, T.double.life);
        if (world) this.addZone(h.x, h.z, r, T.double.life);
        break;
      }
      case 'freeze': {
        const r = h.r ?? 7;
        rv.addSource(h.x, h.z, r, T.freeze.life);
        fx?.discs.spawn(h.x, gy, h.z, r, col, 1, T.freeze.life);
        if (world) this.each(h.x, h.z, r, (t) => t.stun?.(T.freeze.stun));
        break;
      }
      case 'grind': {
        const s = h.seg ?? [h.x - 1, h.z, h.x + 1, h.z];
        this.inkLine(s, T.grind.radius, T.grind.life, T.grind.step);
        const dx = s[2] - s[0];
        const dz = s[3] - s[1];
        const L = Math.hypot(dx, dz) || 1;
        for (let i = 0; i < 6; i++) {
          const k = (i + 0.5) / 6;
          const side = i % 2 ? 1 : -1;
          const x = s[0] + dx * k - (dz / L) * side * 1.2;
          const z = s[1] + dz * k + (dx / L) * side * 1.2;
          fx?.flat.spawn(
            'WHOOSH'[i]!,
            x,
            this.y(x, z),
            z,
            0.7,
            C.cream,
            T.grind.life * 0.6,
            Math.atan2(dx, dz),
          );
        }
        if (world)
          this.each(h.x, h.z, L / 2 + T.grind.radius, (t) => {
            if (ComboEffects.nearSeg(t.position.x, t.position.z, s, T.grind.radius))
              this.later(
                t.id,
                T.grind.damage,
                t.position.x - (dz / L) * 0.5,
                t.position.z + (dx / L) * 0.5,
                0.1,
              );
          });
        break;
      }
      case 'fill': {
        const r = Math.min(T.fill.maxR, Math.max(T.fill.minR, (h.r ?? 2) + 0.4));
        rv.addSource(h.x, h.z, r, T.fill.life);
        fx?.discs.spawn(h.x, gy, h.z, r, col, 1, T.fill.life);
        if (world) this.colorEffect(h.col ?? 2, h.x, h.z, r, T.fill.slow, T.fill.burn, T.fill.ink);
        break;
      }
      case 'color': {
        fx?.discs.spawn(h.x, gy, h.z, T.color.radius, col, 2, 0.7);
        if (world) this.colorEffect(h.col ?? 2, h.x, h.z, T.color.radius, T.color.slow, T.color.damage, 2);
        break;
      }
      case 'blast': {
        rv.addSource(h.x, h.z, T.blast.radius, T.blast.life);
        for (let k = 0; k < 3; k++)
          fx?.discs.spawn(
            h.x + (k - 1) * 0.25,
            gy,
            h.z + (k === 1 ? 0.25 : -0.1),
            T.blast.radius,
            COLS[k]!,
            2,
            0.9,
          );
        // the blast stuns first (stunned = hittable, even before the ink lands)
        if (world)
          this.each(
            h.x,
            h.z,
            T.blast.radius,
            (t) => {
              t.stun?.(0.3);
              this.strike(t, T.blast.damage, h.x, h.z);
            },
            true,
          );
        break;
      }
      default:
        break;
    }
    _p[0] = h.x;
    _p[1] = gy + 0.5;
    _p[2] = h.z;
    this.ctx.events.emit('sfx:play', { id: 'panel_stinger', volume: 0.6, position: _p });
    // chorus colour hits are small and frequent; everything else earns a panel cut (≤ 1 / 2.5 s)
    if (cut && h.kind !== 'color' && this.time - this.lastCut >= 2.5) {
      this.lastCut = this.time;
      this.ctx.events.emit('fx:panelCut', {
        word: comboWord(h.combo),
        focus: [h.x, gy + 1, h.z],
        reason: `combo:${h.combo}`,
      });
    }
  }

  /** Teal slows, salmon burns (a hit now + two later), gold drops bonus ink. */
  private colorEffect(
    col: number,
    x: number,
    z: number,
    r: number,
    slow: number,
    dmg: number,
    ink: number,
  ): void {
    const c = col % 3;
    this.each(x, z, r, (t) => {
      if (c === 0) t.stun?.(slow);
      else if (c === 1) {
        for (let i = 0; i < 3; i++) this.later(t.id, dmg / 3, x, z, 0.1 + i * 0.8);
      } else {
        t.stun?.(slow * 0.3);
        const p = t.position;
        this.ctx.events.emit('ink:drop', {
          position: [p.x, this.y(p.x, p.z), p.z],
          amount: ink,
          kind: ((t as Ghost).kind ?? 'smudge') as never,
          bonus: true,
        });
      }
    });
  }

  /** A hit `delay` s from now; it keeps waiting (≤ 0.45 s) for the target to become hittable. */
  private later(id: number, dmg: number, x: number, z: number, delay: number): void {
    if (this.burns.length < 48) this.burns.push({ id, t: delay, dmg, x, z });
  }

  private addZone(x: number, z: number, r: number, life: number): void {
    if (this.zones.length >= 6) this.zones.shift();
    this.zones.push({ x, z, r, t: life });
    if (this.enemies) this.enemies.damageMul = this.mul;
  }

  /** Overprint: ×mul inside a live zone that is also inked. */
  damageAt(x: number, z: number): number {
    for (const q of this.zones) {
      const dx = x - q.x;
      const dz = z - q.z;
      if (dx * dx + dz * dz <= q.r * q.r && this.ctx.reveal.isRevealed(x, z)) return this.T.double.mul;
    }
    return 1;
  }

  step(dt: number): void {
    this.time += dt;
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const q = this.zones[i]!;
      q.t -= dt;
      if (q.t <= 0) this.zones.splice(i, 1);
    }
    if (!this.zones.length && this.enemies?.damageMul === this.mul) this.enemies.damageMul = null;
    for (let i = this.burns.length - 1; i >= 0; i--) {
      const b = this.burns[i]!;
      b.t -= dt;
      if (b.t > 0) continue;
      this.found = null;
      this.findId = b.id;
      this.ctx.targets.forEach(this.scanId);
      const t = this.found as Damageable | null;
      if (t?.alive && !t.revealed && b.t > -0.45) continue;
      this.burns.splice(i, 1);
      if (t?.alive && t.revealed) this.strike(t, b.dmg, b.x, b.z);
    }
  }

  frame(dt: number): void {
    this.fx?.update(dt);
  }

  /** Page change: zones and pending burns don't carry over. */
  clear(): void {
    this.zones.length = 0;
    this.burns.length = 0;
    if (this.enemies?.damageMul === this.mul) this.enemies.damageMul = null;
  }

  dispose(): void {
    this.clear();
    this.fx?.dispose();
    this.fx = null;
  }
}
