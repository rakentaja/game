/**
 * THE PENCILLER (lazy chunk). Has no light at all (crystal radius 0); works anywhere, ink or not.
 *
 *  tap    Construction Line: throws a ruler at the nearest ghost (revealed or not) and PINS it for
 *         2.5 s — a pinned ghost is frozen *and* hittable (Damageable.stun), even outside the ink.
 *         Rulers chip boss weak points.
 *  hold   Trace: the path you walk becomes a pencil line. Closing a loop = Thumbnail Crush: pinned
 *         ghosts inside take 2 damage, ignoring ink. A loop drawn around a sketch prints it
 *         (`hero:print`). Solo assist: every closed loop sparks a short reveal over its area.
 *  swipe  Erase-step: the dash becomes a 0.4 s sketch phase (projectiles, Blots, eraser pass through).
 *  passive Non-photo Blue: walks on erased ground (eraser damage ignored), prints by tracing.
 *  ult    LAYOUT: a 3×3 panel grid freezes every ghost on screen for 3 s.
 */
import type { Damageable } from '../../core/types';
import { detectLoop, type LoopResult, makeLoopResult, pointInLoop } from '../../systems/combat';
import { C, HeroFx, rod } from './fx';
import { type HeroAction, type HeroData, KitBase, q2 } from './HeroKit';
import { byId, type Ghost, inRadius, nearest, strike } from './util';

const MAX_RULERS = 3;

interface Ruler {
  active: boolean;
  x: number;
  z: number;
  tx: number;
  tz: number;
  tid: number;
  pin: number;
  world: boolean;
  bounce: number;
}

export class PencillerKit extends KitBase {
  readonly id = 'penciller' as const;
  private fx: HeroFx | null = null;
  private rulers: Ruler[] = [];
  private rods: ReturnType<typeof rod>[] = [];
  /** Pinned ghost ids → sim time the pin ends. */
  readonly pins = new Map<number, number>();
  // trace
  private xs!: Float32Array;
  private zs!: Float32Array;
  private n = 0;
  private lineId = -1;
  private loop!: LoopResult;
  private scratch!: LoopResult;
  private sketchT = 0;
  private time = 0;
  /** Loops closed this life (tests / bot). */
  loops = 0;

  protected override configure(): void {
    const m = this.mods;
    m.baseCrystal = false;
    m.baseBolt = false;
    m.radiusIdle = 0;
    m.dashIFrames = this.host.tuning.heroes.penciller.eraseStep.iFrames;
    m.ignore = 'eraser';
    const max = this.host.tuning.heroes.penciller.trace.maxPoints;
    if (!this.xs || this.xs.length !== max) {
      this.xs = new Float32Array(max);
      this.zs = new Float32Array(max);
      this.loop = makeLoopResult(max);
      this.scratch = makeLoopResult(max);
    }
    if (!this.rulers.length)
      for (let i = 0; i < MAX_RULERS; i++)
        this.rulers.push({
          active: false,
          x: 0,
          z: 0,
          tx: 0,
          tz: 0,
          tid: -1,
          pin: 0,
          world: false,
          bounce: 0,
        });
  }

  private vfx(): HeroFx | null {
    if (this.fx) return this.fx;
    const parent = this.host.scene();
    if (!parent) return null;
    this.fx = new HeroFx(parent);
    for (let i = 0; i < MAX_RULERS; i++) {
      const r = rod(i === 0 ? C.gold : C.teal);
      this.rods.push(r);
      this.fx.root.add(r);
    }
    return this.fx;
  }

  isPinned(id: number): boolean {
    return (this.pins.get(id) ?? -1) > this.time;
  }

  private get traceLife(): number {
    const T = this.host.tuning.heroes.penciller.trace;
    return this.has('blueline') ? T.blueline : T.life;
  }

  // ───────── input ─────────

  override onTap(): void {
    const H = this.host;
    const P = H.tuning.heroes.penciller.ruler;
    if (!H.spend(P.cost)) {
      H.sfx('ui_click', 0.5, 0.6);
      return;
    }
    const px = H.position.x;
    const pz = H.position.z;
    const t = nearest(H, px, pz, P.range, 'ghost') ?? nearest(H, px, pz, P.range, 'revealed');
    const tx = t ? t.position.x : px + H.facing.x * P.range * 0.6;
    const tz = t ? t.position.z : pz + H.facing.z * P.range * 0.6;
    this.act('tap', {
      tid: t ? t.id : -1,
      from: [q2(px), q2(pz)],
      to: [q2(tx), q2(tz)],
      pin: this.has('longLead') ? P.longLead : P.pin,
    });
  }

  override onHoldStart(): void {
    this.n = 0;
    this.lineId = this.vfx()?.lines.begin(C.teal, 0.05, this.traceLife) ?? -1;
    this.pushTrace(this.host.position.x, this.host.position.z);
  }

  override onHoldTick(): void {
    const H = this.host;
    const sp = H.tuning.heroes.penciller.trace.spacing;
    const lx = this.xs[this.n - 1]!;
    const lz = this.zs[this.n - 1]!;
    const dx = H.position.x - lx;
    const dz = H.position.z - lz;
    if (this.n > 0 && dx * dx + dz * dz < sp * sp) {
      if (this.lineId >= 0) this.fx?.lines.hold(this.lineId);
      return;
    }
    this.pushTrace(H.position.x, H.position.z);
  }

  private pushTrace(x: number, z: number): void {
    const T = this.host.tuning.heroes.penciller.trace;
    if (this.n >= this.xs.length) {
      this.xs.copyWithin(0, 1);
      this.zs.copyWithin(0, 1);
      this.n--;
    }
    this.xs[this.n] = x;
    this.zs[this.n++] = z;
    if (this.lineId >= 0) {
      this.fx?.lines.push(this.lineId, x, this.host.position.y, z);
      this.fx?.lines.hold(this.lineId);
    }
    if (!detectLoop(this.xs, this.zs, this.n, T.closeDist, T.minArea, this.loop)) return;
    const lp = this.loop;
    const pts: number[] = [];
    const step = Math.max(1, Math.ceil(lp.count / 32));
    for (let i = 0; i < lp.count; i += step) pts.push(q2(lp.px[i]!), q2(lp.pz[i]!));
    this.act('hold', { kind: 'loop', pts, cx: q2(lp.cx), cz: q2(lp.cz), area: q2(lp.area) });
    // keep drawing from here
    this.xs[0] = x;
    this.zs[0] = z;
    this.n = 1;
    if (this.lineId >= 0) {
      this.fx?.lines.end(this.lineId);
      this.lineId = this.fx?.lines.begin(C.teal, 0.05, this.traceLife) ?? -1;
      this.fx?.lines.push(this.lineId, x, this.host.position.y, z);
    }
  }

  override onRelease(): void {
    if (this.n >= 3) {
      const pts: number[] = [];
      const step = Math.max(1, Math.ceil(this.n / 24));
      for (let i = 0; i < this.n; i += step) pts.push(q2(this.xs[i]!), q2(this.zs[i]!));
      this.act('release', { kind: 'line', pts });
    }
    this.n = 0;
    this.lineId = -1; // the line fades out on its own life
  }

  override onSwipe(fromX: number, fromZ: number, dirX: number, dirZ: number): void {
    this.act('swipe', { from: [q2(fromX), q2(fromZ)], dir: [q2(dirX), q2(dirZ)] });
  }

  override onUltimate(): void {
    this.act('ultimate', { x: q2(this.host.position.x), z: q2(this.host.position.z) });
  }

  // ───────── do (local + remote) ─────────

  perform(action: HeroAction, data: HeroData, world: boolean): void {
    const H = this.host;
    const P = H.tuning.heroes.penciller;
    if (action === 'tap') {
      const f = data.from as number[];
      const to = data.to as number[];
      this.throwRuler(
        f[0]!,
        f[1]!,
        to[0]!,
        to[1]!,
        Number(data.tid ?? -1),
        Number(data.pin ?? P.ruler.pin),
        world,
        this.has('ricochet') ? 1 : 0,
      );
      H.sfx('dash', 0.5, 1.6);
    } else if (action === 'hold' && data.kind === 'loop') {
      this.loopClosed(data, world);
    } else if (action === 'release' && !this.remote) {
      // the open line just fades; combos read it from the event
    } else if (action === 'release' && this.remote) {
      const pts = data.pts as number[];
      const fx = this.vfx();
      if (fx && pts) {
        const id = fx.lines.begin(C.teal, 0.05, this.traceLife);
        for (let i = 0; i + 1 < pts.length; i += 2) fx.lines.push(id, pts[i]!, H.position.y, pts[i + 1]!);
      }
    } else if (action === 'swipe') {
      const f = data.from as number[];
      const d = data.dir as number[];
      const D = H.tuning.dash;
      this.vfx()?.lines.segment(
        C.pencil,
        0.04,
        1.2,
        f[0]!,
        f[1]!,
        f[0]! + d[0]! * D.distance,
        f[1]! + d[1]! * D.distance,
        H.position.y,
        true,
      );
      if (!this.remote) {
        this.sketchT = P.eraseStep.iFrames;
        H.setSketched?.(true);
      }
      H.sfx('eraser_sweep', 0.35, 1.5);
    } else if (action === 'ultimate') {
      this.layout(Number(data.x), Number(data.z), world);
    }
  }

  private throwRuler(
    fx: number,
    fz: number,
    tx: number,
    tz: number,
    tid: number,
    pin: number,
    world: boolean,
    bounce: number,
  ): void {
    const r = this.rulers.find((x) => !x.active) ?? this.rulers[0]!;
    r.active = true;
    r.x = fx;
    r.z = fz;
    r.tx = tx;
    r.tz = tz;
    r.tid = tid;
    r.pin = pin;
    r.world = world;
    r.bounce = bounce;
    const P = this.host.tuning.heroes.penciller.ruler;
    // construction line (lingers: combos grind it)
    this.vfx()?.lines.segment(C.gold, 0.035, P.lineLife, fx, fz, tx, tz, this.host.position.y, true);
  }

  private stepRulers(dt: number): void {
    const H = this.host;
    const P = H.tuning.heroes.penciller.ruler;
    for (let i = 0; i < MAX_RULERS; i++) {
      const r = this.rulers[i]!;
      const m = this.rods[i];
      if (!r.active) {
        if (m) m.visible = false;
        continue;
      }
      const t = r.tid >= 0 ? byId(H, r.tid) : null;
      if (t?.alive) {
        r.tx = t.position.x;
        r.tz = t.position.z;
      }
      const dx = r.tx - r.x;
      const dz = r.tz - r.z;
      const d = Math.hypot(dx, dz);
      const s = P.speed * dt;
      if (m) {
        m.visible = true;
        m.position.set(r.x, H.position.y + 1, r.z);
        m.rotation.set(0, this.time * 18, 0);
      }
      if (d > s + 0.05) {
        r.x += (dx / d) * s;
        r.z += (dz / d) * s;
        continue;
      }
      r.active = false;
      if (t && r.world) this.pinTarget(t, r.pin, r.bounce);
    }
  }

  private pinTarget(t: Damageable, pin: number, bounce: number): void {
    const H = this.host;
    const P = H.tuning.heroes.penciller.ruler;
    if ((t as Ghost).kind === undefined) {
      // boss weak point: rulers chip it
      if (t.revealed) strike(t, P.wpDamage, H.position.x, H.position.z);
      return;
    }
    t.stun?.(pin);
    this.pins.set(t.id, this.time + pin);
    this.fx?.discs.spawn(t.position.x, t.position.y, t.position.z, 0.9, C.gold, 2, pin);
    H.sfx('bolt_hit', 0.6, 1.4, [t.position.x, t.position.y + 0.6, t.position.z]);
    if (bounce > 0) {
      const n = nearest(H, t.position.x, t.position.z, P.ricochet, 'ghost', t.id);
      if (n)
        this.throwRuler(t.position.x, t.position.z, n.position.x, n.position.z, n.id, pin, true, bounce - 1);
    }
  }

  private loopClosed(data: HeroData, world: boolean): void {
    const H = this.host;
    const P = H.tuning.heroes.penciller;
    const pts = data.pts as number[];
    const lp = this.scratch;
    lp.count = 0;
    for (let i = 0; i + 1 < pts.length && lp.count < lp.px.length; i += 2) {
      lp.px[lp.count] = pts[i]!;
      lp.pz[lp.count++] = pts[i + 1]!;
    }
    const cx = Number(data.cx);
    const cz = Number(data.cz);
    const area = Number(data.area);
    this.loops++;
    const fx = this.vfx();
    if (fx) {
      const id = fx.lines.begin(C.ink, 0.07, 1.4);
      for (let i = 0; i < lp.count; i++) fx.lines.push(id, lp.px[i]!, H.position.y, lp.pz[i]!);
      fx.lines.push(id, lp.px[0]!, H.position.y, lp.pz[0]!);
    }
    H.sfx('sketch_done', 0.7, 1.25, [cx, H.position.y, cz]);
    if (!world) return;
    // Thumbnail Crush
    let crushed = 0;
    const dmg = P.crush.damage + (this.has('crosshatch') ? P.crush.crosshatch : 0);
    const R = Math.sqrt(area / Math.PI) * 2 + 2;
    inRadius(H, cx, cz, R, (t) => {
      const g = t as Ghost;
      if (g.kind === undefined || !pointInLoop(t.position.x, t.position.z, lp)) return;
      if (this.isPinned(t.id)) {
        strike(t, dmg, cx, cz);
        crushed++;
      } else if (this.has('perspective')) {
        t.stun?.(0.5);
        strike(t, P.crush.perspective, cx, cz);
        crushed++;
      }
    });
    if (crushed > 0) {
      if (this.has('kirbyDots')) H.addEnergy(P.crush.kirbyInk * crushed);
      H.events.emit('fx:shake', { intensity: 0.25, duration: 0.2 });
      H.events.emit('fx:hitstop', { duration: 0.06 });
    }
    // solo assist: the loop sparks a short reveal
    if (H.playerCount <= 1) {
      const S = P.soloSpark;
      H.reveal.addSource(cx, cz, Math.min(S.maxR, Math.max(1.2, Math.sqrt(area / Math.PI) + 0.6)), S.life);
    }
    // tracing around a sketch prints it
    for (const s of H.printables()) {
      if (!pointInLoop(s.x, s.z, lp)) continue;
      H.events.emit('hero:print', { pid: H.pid, x: s.x, z: s.z, radius: 1.5 });
      break;
    }
  }

  private layout(x: number, z: number, world: boolean): void {
    const H = this.host;
    const L = H.tuning.heroes.penciller.layout;
    const half = L.size / 2;
    const fx = this.vfx();
    if (fx) {
      const y = H.position.y;
      for (let i = 0; i <= 3; i++) {
        const o = -half + (i * L.size) / 3;
        fx.lines.segment(C.ink, 0.12, L.freeze, x + o, z - half, x + o, z + half, y);
        fx.lines.segment(C.ink, 0.12, L.freeze, x - half, z + o, x + half, z + o, y);
      }
    }
    H.sfx('panel_stinger', 1, 1.1);
    if (!world) return;
    inRadius(H, x, z, L.range, (t) => {
      if ((t as Ghost).kind === undefined) return;
      t.stun?.(L.freeze);
      this.pins.set(t.id, this.time + L.freeze);
    });
    H.events.emit('fx:panelCut', { word: 'layout', focus: [x, H.position.y + 1, z], reason: 'ultimate' });
  }

  override update(dt: number): void {
    this.time += dt;
    this.stepRulers(dt);
    if (this.sketchT > 0) {
      this.sketchT -= dt;
      if (this.sketchT <= 0) this.host.setSketched?.(false);
    }
    if (this.pins.size > 32) for (const [id, until] of this.pins) if (until < this.time) this.pins.delete(id);
  }

  override render(_alpha: number, frameDt: number): void {
    this.fx?.update(frameDt);
  }

  override dispose(): void {
    super.dispose();
    this.fx?.dispose();
    this.fx = null;
    this.rods.length = 0;
  }
}
