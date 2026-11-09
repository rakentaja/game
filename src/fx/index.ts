/**
 * FX wiring: ink splashes, paper tears, crystal halo, screen shake and hit-stop, driven by `fx:*`
 * and gameplay events. `installFx(ctx, render)` returns the system; it updates itself through
 * `render.onFrame` on real time (VFX keep running through hit-stop).
 */
import type * as THREE from 'three';
import type { GameContext } from '../core/types';
import { TUNING } from '../data/tuning';
import type { InkRenderer } from '../render/renderer';
import { CrystalHalo } from './CrystalHalo';
import { ImpactFlash } from './ImpactFlash';
import { InkSplash } from './InkSplash';
import { PaperTear } from './PaperTear';
import { SlowMo, TimeFreeze } from './shake';

export { CrystalHalo } from './CrystalHalo';
export { ImpactFlash } from './ImpactFlash';
export { InkSplash } from './InkSplash';
export { PaperTear } from './PaperTear';
export { ScreenShake, SlowMo, TimeFreeze } from './shake';

export class FxSystem {
  readonly splash: InkSplash;
  readonly tear: PaperTear;
  readonly halo: CrystalHalo;
  readonly freeze = new TimeFreeze();
  readonly slow = new SlowMo();
  readonly flash = new ImpactFlash();
  private readonly offs: (() => void)[] = [];
  private lastFlash = -1e9;
  private clock = 0;

  constructor(
    readonly render: InkRenderer,
    readonly time: { scale: number },
  ) {
    const scale = render.qualityProfile.fxScale;
    this.splash = new InkSplash(render.shared, Math.max(8, Math.round(TUNING.fx.splashPool * scale)));
    this.tear = new PaperTear(Math.max(16, Math.round(TUNING.fx.tearPool * scale)));
    this.halo = new CrystalHalo(render.shared);
    this.halo.target = render.reveal.center;
    render.scene.add(this.splash.mesh, this.tear.mesh, this.halo.mesh, this.flash.mesh);
    this.offs.push(render.onFrame((dt) => this.update(dt)));
  }

  update(dt: number): void {
    this.clock += dt;
    this.freeze.update(dt, this.time);
    this.slow.update(dt, this.time);
    this.flash.update();
    this.tear.update(dt);
    const C = TUNING.crystal;
    const r = this.render.reveal.radius;
    const s = Math.min(1, Math.max(0, (r - C.radiusDim) / Math.max(0.01, C.radiusHeld - C.radiusDim)));
    this.halo.update(dt, s);
  }

  shake(intensity: number, duration: number): void {
    this.render.shake.add(intensity, duration);
  }

  hitStop(seconds: number): void {
    if (this.render.reduceMotion) seconds *= 0.5;
    this.freeze.hold(seconds, this.time);
  }

  /** Real-time slow motion (Ink Parry). */
  slowMo(scale: number, seconds: number): void {
    this.slow.start(scale, seconds, this.time);
  }

  /** One-frame paper-white starburst. Skipped under reduce-motion and kept under 3 Hz. */
  impactFlash(x: number, y: number, z: number, size: number): void {
    if (this.render.reduceMotion) return;
    if (this.clock - this.lastFlash < TUNING.combatPlus.flashMinGap) return;
    this.lastFlash = this.clock;
    this.flash.fire(x, y, z, size);
  }

  /** Bolt kill: paper shreds thrown along the bolt. */
  tearThrough(x: number, y: number, z: number, dirX: number, dirZ: number, big: boolean): void {
    this.tear.burst(
      x,
      y,
      z,
      big ? 22 : 12,
      big ? 5 : 3.8,
      TUNING.fx.tearLife,
      big ? 0.2 : 0.15,
      dirX,
      dirZ,
      0.55,
    );
  }

  /** Bolt impact: wet splat + a few droplets. */
  impact(p: THREE.Vector3 | readonly number[], critical: boolean): void {
    const [x, y, z] = toXYZ(p);
    this.splash.burst(
      x,
      y,
      z,
      critical ? 1.3 : 0.8,
      TUNING.fx.splashLife * (critical ? 1.3 : 1),
      critical ? 5 : 3,
    );
  }

  /** Ghost death: the paper rips apart and the ink drains out. */
  rip(p: THREE.Vector3 | readonly number[], big = false): void {
    const [x, y, z] = toXYZ(p);
    this.tear.burst(x, y + 0.8, z, big ? 26 : 16, big ? 4.2 : 3.2, TUNING.fx.tearLife, big ? 0.22 : 0.16);
    this.splash.burst(x, y + 0.6, z, big ? 1.6 : 1.1, TUNING.fx.splashLife * 1.2, 4);
  }

  dispose(): void {
    for (const o of this.offs) o();
    this.splash.mesh.removeFromParent();
    this.tear.mesh.removeFromParent();
    this.halo.mesh.removeFromParent();
    this.flash.mesh.removeFromParent();
  }
}

function toXYZ(p: THREE.Vector3 | readonly number[]): [number, number, number] {
  if (Array.isArray(p)) return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
  const v = p as THREE.Vector3;
  _xyz[0] = v.x;
  _xyz[1] = v.y;
  _xyz[2] = v.z;
  return _xyz;
}
const _xyz: [number, number, number] = [0, 0, 0];

/** Subscribe FX to the event bus. */
export function installFx(ctx: GameContext, render: InkRenderer): FxSystem {
  const fx = new FxSystem(render, ctx.time);
  const ev = ctx.events;
  const offs = [
    ev.on('fx:shake', (e) => fx.shake(e.intensity, e.duration)),
    ev.on('fx:hitstop', (e) => fx.hitStop(e.duration)),
    ev.on('bolt:hit', (e) => {
      fx.impact(e.position, e.critical);
      fx.shake(e.critical ? 0.32 : 0.14, 0.25);
      const [x, y, z] = e.position;
      const S = TUNING.combatPlus.flashSize;
      fx.impactFlash(x, y, z, e.critical ? S * 1.6 : e.kill ? S * 1.25 : S * 0.8);
      if (e.kill) fx.tearThrough(x, y, z, e.dir?.[0] ?? 0, e.dir?.[1] ?? 0, e.critical);
    }),
    ev.on('combat:parry', () => {
      const P = TUNING.combatPlus.parry;
      fx.slowMo(P.slowScale, P.slowTime);
    }),
    ev.on('enemy:died', (e) => {
      fx.rip(e.position, e.kind === 'blot');
      fx.shake(0.22, 0.3);
      fx.hitStop(0.05);
    }),
    ev.on('player:damaged', () => {
      const p = ctx.player?.position;
      if (p) fx.tear.burst(p.x, p.y + 1.1, p.z, 10, 2.6, TUNING.fx.tearLife, 0.2);
      fx.shake(0.45, 0.35);
      fx.hitStop(0.08);
    }),
  ];
  const dispose = fx.dispose.bind(fx);
  fx.dispose = () => {
    for (const o of offs) o();
    dispose();
  };
  return fx;
}
