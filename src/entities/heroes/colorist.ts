/**
 * THE COLORIST (lazy chunk) — works inside existing ink, but makes it last. Tiny 1.2 m halo
 * (2.5 m solo, so she can still find ghosts on her own).
 *
 *  tap    spray, cycling teal (slows) → salmon (burns) → gold (extra ink drop). A ghost carrying
 *         all three colours bursts: Full Registration.
 *  hold   Fill Bucket: the inked area you stand in becomes a colour flat that stays inked for 10 s
 *         (teal flats slow, salmon flats burn, gold flats heal 1 page / 4 s).
 *  swipe  Misregistration dash: leaves 3 offset colour decoys for 1.5 s (ghosts that touch one
 *         are confused).
 *  passive Halftone: ghost deaths inside a flat refund ink.
 *  ult    FOUR-COLOR PROCESS: every flat spreads 50 % and gives the ghosts inside all three colours.
 */
import type * as THREE from 'three';
import type { Damageable } from '../../core/types';
import { C, figure, HeroFx } from './fx';
import { type HeroAction, type HeroData, KitBase, q2 } from './HeroKit';
import { byId, DelayedHits, type Ghost, inRadius, nearest, strike } from './util';

/** Spray colours in cycle order. */
export const SPRAY = ['teal', 'salmon', 'gold'] as const;
export type SprayColor = (typeof SPRAY)[number];
const SLOT: Record<SprayColor, number> = { teal: C.teal, salmon: C.salmon, gold: C.gold };

export const nextColor = (i: number): number => (i + 1) % 3;

/** Colour marks on one ghost: sim time each colour was last applied (-1 = never). */
export interface Marks {
  t: [number, number, number];
}

/** Full Registration: `need` distinct colours applied within `window` seconds of `now`. */
export function registered(m: Marks, now: number, window: number, need = 3): boolean {
  let n = 0;
  for (let i = 0; i < 3; i++) if (m.t[i]! >= 0 && now - m.t[i]! <= window) n++;
  return n >= need;
}

export interface Flat {
  active: boolean;
  /** This machine resolves the flat's ghost effects (slow / burn). */
  world: boolean;
  x: number;
  z: number;
  r: number;
  col: number; // 0 teal, 1 salmon, 2 gold
  until: number;
  disc: number;
  src: number;
}

const MAX_SPRAYS = 4;

export class ColoristKit extends KitBase {
  readonly id = 'colorist' as const;
  private fx: HeroFx | null = null;
  /** Next spray colour (0 teal, 1 salmon, 2 gold). */
  color = 0;
  readonly marks = new Map<number, Marks>();
  private gold = new Map<number, number>();
  readonly flats: Flat[] = [];
  private sprays: {
    active: boolean;
    x: number;
    z: number;
    tx: number;
    tz: number;
    tid: number;
    col: number;
    world: boolean;
    disc: number;
  }[] = [];
  private decoys: {
    mesh: THREE.Mesh | null;
    x: number;
    z: number;
    until: number;
    hit: Set<number>;
    world: boolean;
  }[] = [];
  private cd = 0;
  private time = 0;
  private holdT = 0;
  private filled = false;
  private healAcc = 0;
  private tickAcc = 0;
  private hits = new DelayedHits(() => this.host);
  /** Registration bursts so far (tests / HUD). */
  bursts = 0;

  protected override configure(): void {
    const m = this.mods;
    m.baseCrystal = false;
    m.baseBolt = false;
    m.radiusIdle = this.haloRadius();
    if (!this.flats.length)
      for (let i = 0; i < this.host.tuning.heroes.colorist.bucket.max; i++)
        this.flats.push({
          active: false,
          world: false,
          x: 0,
          z: 0,
          r: 0,
          col: 0,
          until: 0,
          disc: -1,
          src: -1,
        });
    if (!this.sprays.length)
      for (let i = 0; i < MAX_SPRAYS; i++)
        this.sprays.push({
          active: false,
          x: 0,
          z: 0,
          tx: 0,
          tz: 0,
          tid: -1,
          col: 0,
          world: false,
          disc: -1,
        });
    if (!this.decoys.length)
      for (let i = 0; i < this.host.tuning.heroes.colorist.decoys.count; i++)
        this.decoys.push({ mesh: null, x: 0, z: 0, until: -1, hit: new Set(), world: false });
    if (!this.offs.length)
      this.offs.push(
        this.host.events.on('enemy:died', (e) =>
          this.onGhostDied(e.id, e.position[0], e.position[2], e.kind),
        ),
      );
  }

  private haloRadius(): number {
    const K = this.host.tuning.heroes.colorist;
    return this.host.playerCount <= 1 ? K.soloHalo : K.halo;
  }

  private vfx(): HeroFx | null {
    if (this.fx) return this.fx;
    const parent = this.host.scene();
    if (!parent) return null;
    this.fx = new HeroFx(parent);
    const cols = [C.teal, C.salmon, C.gold];
    for (let i = 0; i < this.decoys.length; i++) {
      const m = figure(cols[i % 3]!);
      this.decoys[i]!.mesh = m;
      this.fx.root.add(m);
    }
    return this.fx;
  }

  /** Is (x, z) inside an active flat? Returns its colour index or -1. */
  flatAt(x: number, z: number): number {
    for (const f of this.flats) {
      if (!f.active || f.until <= this.time) continue;
      const dx = x - f.x;
      const dz = z - f.z;
      if (dx * dx + dz * dz <= f.r * f.r) return f.col;
    }
    return -1;
  }

  // ───────── input ─────────

  override onTap(): void {
    const H = this.host;
    const K = H.tuning.heroes.colorist;
    if (this.cd > 0) return;
    if (!H.spend(K.cost)) {
      H.sfx('ui_click', 0.5, 0.6);
      return;
    }
    this.cd = K.cooldown;
    const px = H.position.x;
    const pz = H.position.z;
    const t = nearest(H, px, pz, K.sprayRange, 'revealed');
    const col = this.color;
    this.color = nextColor(this.color);
    this.act('tap', {
      col,
      tid: t ? t.id : -1,
      from: [q2(px), q2(pz)],
      to: [q2(t ? t.position.x : px + H.facing.x * 4), q2(t ? t.position.z : pz + H.facing.z * 4)],
    });
  }

  override onHoldStart(): void {
    this.holdT = 0;
    this.filled = false;
  }

  override onHoldTick(dt: number): void {
    const H = this.host;
    const B = H.tuning.heroes.colorist.bucket;
    this.holdT += dt;
    if (this.filled || this.holdT < B.charge) return;
    this.filled = true;
    if (!H.spend(this.has('colorHold') ? B.cost / 2 : B.cost)) {
      H.sfx('ui_click', 0.5, 0.6);
      return;
    }
    const x = H.position.x;
    const z = H.position.z;
    const inInk = H.reveal.revealAt(x, z) > 0.5;
    const r = inInk ? Math.max(B.radius, Math.min(H.reveal.radius, 7)) : this.haloRadius();
    // the flat takes the colour you last sprayed
    this.act('hold', { x: q2(x), z: q2(z), r: q2(r), col: (this.color + 2) % 3 });
  }

  override onSwipe(fromX: number, fromZ: number, dirX: number, dirZ: number): void {
    this.act('swipe', { from: [q2(fromX), q2(fromZ)], dir: [q2(dirX), q2(dirZ)] });
  }

  override onUltimate(): void {
    this.act('ultimate', { x: q2(this.host.position.x), z: q2(this.host.position.z) });
  }

  // ───────── do ─────────

  perform(action: HeroAction, data: HeroData, world: boolean): void {
    const H = this.host;
    if (action === 'tap') {
      const f = data.from as number[];
      const to = data.to as number[];
      const s = this.sprays.find((x) => !x.active) ?? this.sprays[0]!;
      s.active = true;
      s.x = f[0]!;
      s.z = f[1]!;
      s.tx = to[0]!;
      s.tz = to[1]!;
      s.tid = Number(data.tid ?? -1);
      s.col = Number(data.col) % 3;
      s.world = this.resolves(world);
      const v = this.vfx();
      s.disc = v ? v.discs.spawn(s.x, H.position.y + 1, s.z, 0.35, SLOT[SPRAY[s.col]!], 0, 2) : -1;
      H.sfx('scribble_fire', 0.6, 1.3 + s.col * 0.15);
    } else if (action === 'hold') {
      this.addFlat(Number(data.x), Number(data.z), Number(data.r), Number(data.col) % 3, world);
    } else if (action === 'swipe') {
      const f = data.from as number[];
      const d = data.dir as number[];
      this.dropDecoys(f[0]!, f[1]!, d[0]!, d[1]!, world);
    } else if (action === 'ultimate') {
      this.fourColor(world);
    }
  }

  private stepSprays(dt: number): void {
    const H = this.host;
    const K = H.tuning.heroes.colorist;
    for (const s of this.sprays) {
      if (!s.active) continue;
      const t = s.tid >= 0 ? byId(H, s.tid) : null;
      if (t?.alive) {
        s.tx = t.position.x;
        s.tz = t.position.z;
      }
      const dx = s.tx - s.x;
      const dz = s.tz - s.z;
      const d = Math.hypot(dx, dz);
      const st = K.speed * dt;
      if (d > st) {
        s.x += (dx / d) * st;
        s.z += (dz / d) * st;
        if (s.disc >= 0) this.fx?.discs.move(s.disc, s.x, H.position.y + 1, s.z);
        continue;
      }
      s.active = false;
      if (s.disc >= 0) this.fx?.discs.kill(s.disc);
      this.fx?.discs.spawn(
        s.tx,
        H.collision.groundHeight(s.tx, s.tz),
        s.tz,
        0.8,
        SLOT[SPRAY[s.col]!],
        0,
        0.6,
      );
      if (!s.world) continue;
      if (t?.alive && t.revealed) this.applyColor(t, s.col, true);
      if (this.has('overspray'))
        inRadius(H, s.tx, s.tz, K.overspray, (o) => {
          if (o !== t && (o as Ghost).kind !== undefined && o.revealed) this.applyColor(o, s.col, false);
        });
    }
  }

  /** Apply a spray colour (and its status) to a ghost; may trigger Full Registration. */
  applyColor(t: Damageable, col: number, direct: boolean): void {
    const H = this.host;
    const K = H.tuning.heroes.colorist;
    let m = this.marks.get(t.id);
    if (!m) {
      m = { t: [-1, -1, -1] };
      if (this.marks.size > 48) this.marks.clear();
      this.marks.set(t.id, m);
    }
    const cols = this.has('gradient') && direct ? 2 : 1;
    for (let k = 0; k < cols; k++) {
      const c = (col + k) % 3;
      m.t[c] = this.time;
      if (c === 0) t.stun?.(K.slow);
      else if (c === 1)
        for (let i = 1; i <= K.burn.ticks; i++)
          this.hits.add(t.id, i * K.burn.every, K.burn.damage, t.position.x, t.position.z);
      else this.gold.set(t.id, this.time + 4);
    }
    if (direct) strike(t, K.damage, H.position.x, H.position.z);
    if (t.alive && registered(m, this.time, K.registration.window, this.has('duotone') ? 2 : 3))
      this.registration(t);
  }

  private registration(t: Damageable): void {
    const H = this.host;
    const R = H.tuning.heroes.colorist.registration;
    this.bursts++;
    this.marks.delete(t.id);
    const x = t.position.x;
    const z = t.position.z;
    const y = t.position.y;
    const v = this.fx;
    if (v) {
      v.discs.spawn(x + 0.25, y, z, R.radius, C.teal, 2, 0.7);
      v.discs.spawn(x - 0.2, y, z + 0.2, R.radius * 0.9, C.salmon, 2, 0.7);
      v.discs.spawn(x, y, z - 0.25, R.radius * 0.8, C.gold, 2, 0.7);
    }
    strike(t, R.damage, H.position.x, H.position.z);
    inRadius(H, x, z, R.radius, (o) => {
      if (o !== t && o.revealed && (o as Ghost).kind !== undefined) strike(o, R.splash, x, z);
    });
    H.sfx('panel_stinger', 0.7, 1.3, [x, y + 1, z]);
    H.events.emit('fx:shake', { intensity: 0.25, duration: 0.2 });
    H.events.emit('fx:hitstop', { duration: 0.07 });
  }

  private onGhostDied(id: number, x: number, z: number, kind: string): void {
    const H = this.host;
    const K = H.tuning.heroes.colorist;
    if ((this.gold.get(id) ?? -1) > this.time) {
      this.gold.delete(id);
      H.events.emit('ink:drop', {
        position: [x, H.collision.groundHeight(x, z), z],
        amount: K.goldInk * (this.has('goldLeaf') ? 2 : 1),
        kind: kind as never,
        bonus: true,
      });
    }
    // Halftone refunds the Colorist's own ink: only her own (local) kit pays it
    if (!this.remote && this.flatAt(x, z) >= 0) H.addEnergy(K.halftoneInk);
    this.marks.delete(id);
  }

  addFlat(x: number, z: number, r: number, col: number, world: boolean): Flat {
    const H = this.host;
    const B = H.tuning.heroes.colorist.bucket;
    const life = B.life + (this.has('trapping') ? B.trapping : 0);
    let f = this.flats.find((q) => !q.active || q.until <= this.time);
    if (!f) {
      f = this.flats[0]!;
      for (const q of this.flats) if (q.until < f.until) f = q;
    }
    if (f.src >= 0) H.reveal.removeSource(f.src);
    if (f.disc >= 0) this.fx?.discs.kill(f.disc);
    f.active = true;
    f.world = this.resolves(world);
    f.x = x;
    f.z = z;
    f.r = r;
    f.col = col;
    f.until = this.time + life;
    const v = this.vfx();
    f.disc = v ? v.discs.spawn(x, H.collision.groundHeight(x, z), z, r, SLOT[SPRAY[col]!], 1, life) : -1;
    // the flat keeps its area inked on every machine (reveal is per machine)
    f.src = H.reveal.addSource(x, z, r, life);
    H.sfx('sketch_done', 0.5, 1.4, [x, H.position.y, z]);
    return f;
  }

  private stepFlats(dt: number): void {
    const H = this.host;
    const K = H.tuning.heroes.colorist;
    this.tickAcc += dt;
    const tick = this.tickAcc >= 1;
    if (tick) this.tickAcc = 0;
    let onGold = false;
    for (const f of this.flats) {
      if (!f.active) continue;
      if (f.until <= this.time) {
        f.active = false;
        f.src = -1;
        continue;
      }
      if (f.col === 2 && !this.remote) {
        // gold heals the Colorist's own wizard (her own machine)
        const dx = H.position.x - f.x;
        const dz = H.position.z - f.z;
        if (dx * dx + dz * dz <= f.r * f.r) onGold = true;
      }
      if (!tick || f.col === 2 || !f.world) continue;
      inRadius(H, f.x, f.z, f.r, (t) => {
        if ((t as Ghost).kind === undefined) return;
        if (f.col === 0) t.stun?.(0.3);
        else if (t.revealed) strike(t, K.burn.damage, f.x, f.z);
      });
    }
    if (onGold) {
      this.healAcc += dt;
      const every = this.has('goldLeaf') ? K.goldHealEvery / 2 : K.goldHealEvery;
      if (this.healAcc >= every) {
        this.healAcc = 0;
        H.heal(1);
        H.sfx('ink_pickup', 0.6, 1.2);
      }
    } else this.healAcc = 0;
  }

  private dropDecoys(fx: number, fz: number, dx: number, dz: number, world: boolean): void {
    const H = this.host;
    const D = H.tuning.heroes.colorist.decoys;
    this.vfx();
    const px = -dz;
    const pz = dx;
    for (let i = 0; i < this.decoys.length; i++) {
      const d = this.decoys[i]!;
      const o = (i - 1) * D.offset;
      d.x = fx + px * o - dx * 0.3 * i;
      d.z = fz + pz * o - dz * 0.3 * i;
      d.until = this.time + D.life;
      d.hit.clear();
      d.world = this.resolves(world);
      // decoys draw aggro: enemy targeting reads them while they stand (host / solo only)
      if (d.world) H.events.emit('hero:lure', { x: d.x, z: d.z, seconds: D.life });
      if (d.mesh) {
        d.mesh.visible = true;
        d.mesh.position.set(d.x, H.collision.groundHeight(d.x, d.z) + 0.85, d.z);
      }
    }
    H.reveal.addSource(fx, fz, 1.4, D.life);
    H.sfx('dash', 0.5, 1.3);
  }

  private stepDecoys(): void {
    const H = this.host;
    for (const d of this.decoys) {
      if (d.until < 0) continue;
      if (d.until <= this.time) {
        d.until = -1;
        if (d.mesh) d.mesh.visible = false;
        continue;
      }
      // ghosts that reach a decoy swing at paper: a short confusion
      if (!d.world) continue;
      inRadius(H, d.x, d.z, 0.9, (t) => {
        if ((t as Ghost).kind === undefined || d.hit.has(t.id)) return;
        d.hit.add(t.id);
        t.stun?.(0.6);
      });
    }
  }

  /** Decoy positions currently drawing aggro (enemy targeting may read this). */
  decoyAt(i: number): { x: number; z: number } | null {
    const d = this.decoys[i];
    return d && d.until > this.time ? d : null;
  }

  private fourColor(world: boolean): void {
    const H = this.host;
    const mul = H.tuning.heroes.colorist.fourColor;
    let any = false;
    for (const f of this.flats) {
      if (!f.active || f.until <= this.time) continue;
      any = true;
      this.addFlat(f.x, f.z, f.r * mul, f.col, world);
    }
    if (!any) this.addFlat(H.position.x, H.position.z, this.haloRadius() * 2 * mul, 2, world);
    H.events.emit('fx:panelCut', {
      word: 'fourColor',
      focus: [H.position.x, H.position.y + 1, H.position.z],
      reason: 'ultimate',
    });
    if (!this.resolves(world)) return;
    for (const f of this.flats) {
      if (!f.active) continue;
      inRadius(H, f.x, f.z, f.r, (t) => {
        if ((t as Ghost).kind === undefined) return;
        t.stun?.(0.4); // stunned = hittable, even if the mask hasn't caught up
        const m = this.marks.get(t.id) ?? { t: [-1, -1, -1] as [number, number, number] };
        m.t[0] = m.t[1] = m.t[2] = this.time;
        this.marks.set(t.id, m);
        if (t.alive) this.registration(t);
      });
    }
  }

  override update(dt: number): void {
    this.time += dt;
    if (this.cd > 0) this.cd -= dt;
    this.mods.radiusIdle = this.haloRadius();
    this.stepSprays(dt);
    this.stepFlats(dt);
    this.stepDecoys();
    this.hits.update(dt);
  }

  override render(_alpha: number, frameDt: number): void {
    this.fx?.update(frameDt);
  }

  override dispose(): void {
    super.dispose();
    for (const f of this.flats) if (f.src >= 0) this.host.reveal.removeSource(f.src);
    this.fx?.dispose();
    this.fx = null;
    this.hits.clear();
  }
}
