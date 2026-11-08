/**
 * Follow camera (PLAN §2.3): 3/4 top-down, critically damped spring, velocity look-ahead,
 * portrait-first framing (keeps a minimum world width visible on tall screens; landscape uses its
 * own FOV), trauma-based shake, FOV kicks, and CatmullRom cinematic rails.
 *
 * Update at render rate with the *interpolated* player position for buttery motion.
 */
import * as THREE from 'three';
import type { EventBus, GameEvents } from '../core/events';
import type { GameContext, Vec3T } from '../core/types';
import type { Tuning } from '../data/tuning';

/** Implicit-Euler critically damped spring on one axis. Stable for any dt. Mutates `s`. */
export function springStep(s: { x: number; v: number }, target: number, omega: number, dt: number): void {
  const f = 1 + 2 * dt * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const detInv = 1 / (f + hhoo);
  const detX = f * s.x + dt * s.v + hhoo * target;
  const detV = s.v + hoo * (target - s.x);
  s.x = detX * detInv;
  s.v = detV * detInv;
}

/** Boom length that keeps `minWidth` metres of world visible horizontally at the focus. */
export function framingDistance(
  aspect: number,
  fovDeg: number,
  baseDistance: number,
  minWidth: number,
  maxDistance: number,
): number {
  const tanH = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2) * aspect;
  const need = minWidth / (2 * Math.max(1e-3, tanH));
  return Math.min(maxDistance, Math.max(baseDistance, need));
}

export interface RailOptions {
  /** Camera positions (world). At least 2. */
  points: Vec3T[];
  /** Look-at points (same count or 1), or omitted to look at the follow target. */
  look?: Vec3T[];
  duration: number;
  /** Optional FOV override during the rail. */
  fov?: number;
  ease?: (t: number) => number;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// Cheap smooth 1D noise for shake (sum of sines with incommensurate rates).
function shakeNoise(t: number, seed: number): number {
  return (
    Math.sin(t * 1.0 + seed) * 0.5 +
    Math.sin(t * 2.31 + seed * 1.7) * 0.3 +
    Math.sin(t * 4.13 + seed * 2.9) * 0.2
  );
}

export class CameraRig {
  /** View basis on the ground plane (unit, Y=0): what "up" and "right" on screen mean in world. */
  readonly forward = new THREE.Vector3(0, 0, -1);
  readonly right = new THREE.Vector3(1, 0, 0);
  /** Current focus point (world), after look-ahead. */
  readonly focus = new THREE.Vector3();
  /** Yaw of the boom around Y (radians). 0 = camera south of target looking north (-Z). */
  yaw = 0;
  reduceMotion = false;
  /** 0..1 trauma; shake amplitude is trauma². */
  trauma = 0;
  railActive = false;
  /** Boom length multiplier target (boss fights pull back); eased internally. */
  zoom = 1;
  private zoomS = { x: 1, v: 0 };

  private sx = { x: 0, v: 0 };
  private sy = { x: 0, v: 0 };
  private sz = { x: 0, v: 0 };
  private lax = { x: 0, v: 0 };
  private laz = { x: 0, v: 0 };
  private fovKick = { x: 0, v: 0 };
  private time = 0;
  private snapped = false;
  private rail: {
    pos: THREE.CatmullRomCurve3;
    look: THREE.CatmullRomCurve3 | null;
    lookFixed: THREE.Vector3 | null;
    t: number;
    opts: RailOptions;
    resolve: () => void;
  } | null = null;
  private blendBack = 0;
  private readonly railPos = new THREE.Vector3();
  private readonly railLook = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private offs: (() => void)[] = [];

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private tuning: Tuning,
    events?: EventBus<GameEvents>,
  ) {
    if (events) {
      this.offs.push(
        events.on('fx:shake', (e) => this.shake(e.intensity)),
        events.on('player:dash', () => this.kick(tuning.camera.dashKickDeg)),
        events.on('player:damaged', () => this.shake(0.55)),
        events.on('fx:panelCut', () => this.shake(0.35)),
      );
    }
    this.updateBasis();
  }

  dispose(): void {
    for (const o of this.offs) o();
    this.offs.length = 0;
  }

  shake(intensity: number): void {
    if (this.reduceMotion) return;
    this.trauma = Math.min(1, this.trauma + intensity);
  }

  /** Brief FOV punch (degrees, positive = wider). */
  kick(deg: number): void {
    if (this.reduceMotion) return;
    this.fovKick.v += deg * 14;
  }

  /** Jump to the target with no spring lag (teleports, respawns, scene start). */
  snap(target: THREE.Vector3): void {
    this.sx.x = target.x;
    this.sy.x = target.y;
    this.sz.x = target.z;
    this.sx.v = this.sy.v = this.sz.v = 0;
    this.lax.x = this.laz.x = this.lax.v = this.laz.v = 0;
    this.snapped = true;
  }

  /** Play a CatmullRom rail; resolves when done (camera then blends back to follow). */
  playRail(opts: RailOptions): Promise<void> {
    this.rail?.resolve();
    const toV = (p: Vec3T) => new THREE.Vector3(p[0], p[1], p[2]);
    const pts = opts.points.map(toV);
    if (pts.length === 1) pts.push(pts[0]!.clone());
    let look: THREE.CatmullRomCurve3 | null = null;
    let lookFixed: THREE.Vector3 | null = null;
    if (opts.look && opts.look.length > 1) look = new THREE.CatmullRomCurve3(opts.look.map(toV));
    else if (opts.look && opts.look.length === 1) lookFixed = toV(opts.look[0]!);
    return new Promise((resolve) => {
      this.rail = {
        pos: new THREE.CatmullRomCurve3(pts, false, 'centripetal'),
        look,
        lookFixed,
        t: 0,
        opts,
        resolve,
      };
      this.railActive = true;
    });
  }

  stopRail(): void {
    if (!this.rail) return;
    const r = this.rail;
    this.rail = null;
    this.railActive = false;
    this.blendBack = this.tuning.camera.railBlendBack;
    r.resolve();
  }

  /**
   * @param dt     real frame delta (s) — camera keeps easing during hit-stop for weight
   * @param target interpolated player position
   * @param vel    player velocity (world, m/s)
   */
  update(dt: number, target: THREE.Vector3, vel: THREE.Vector3): void {
    const C = this.tuning.camera;
    const cam = this.camera;
    dt = Math.min(dt, 1 / 20);
    this.time += dt;
    const aspect = cam.aspect;
    const portrait = aspect < 1;

    // Look-ahead (smoothed separately so direction changes don't whip the camera).
    const speed = Math.hypot(vel.x, vel.z);
    const k = speed > 0.05 ? (C.lookAhead * Math.min(1, speed / this.tuning.player.runSpeed)) / speed : 0;
    springStep(this.lax, vel.x * k, C.lookAheadSpring, dt);
    springStep(this.laz, vel.z * k, C.lookAheadSpring, dt);

    if (!this.snapped) this.snap(target);
    springStep(this.sx, target.x, C.spring, dt);
    springStep(this.sy, target.y, C.spring * 0.6, dt);
    springStep(this.sz, target.z, C.spring, dt);
    // Never let the spring trail more than maxLag (dashes): drag the focus along.
    const lx = this.sx.x - target.x;
    const lz = this.sz.x - target.z;
    const lag = Math.hypot(lx, lz);
    if (lag > C.maxLag) {
      const k = C.maxLag / lag;
      this.sx.x = target.x + lx * k;
      this.sz.x = target.z + lz * k;
    }

    const fovBase = portrait ? C.fovPortrait : C.fovLandscape;
    const pitch = THREE.MathUtils.degToRad(C.pitchDeg);
    let dist = portrait
      ? framingDistance(aspect, fovBase, C.distance, C.portraitMinWidth, C.maxDistance)
      : C.distance;
    // vertical constraint: ground depth projects to depth·sin(pitch) of view-plane height
    const tanV = Math.tan(THREE.MathUtils.degToRad(fovBase) / 2);
    dist = Math.min(C.maxDistance, Math.max(dist, (C.minGroundDepth * Math.sin(pitch)) / (2 * tanV)));
    springStep(this.zoomS, this.zoom, 2.5, dt);
    dist *= this.zoomS.x;
    const bias = portrait ? C.forwardBiasPortrait : C.forwardBiasLandscape;

    this.updateBasis();
    const f = this.forward;
    this.focus.set(
      this.sx.x + this.lax.x + f.x * bias,
      this.sy.x + C.focusHeight,
      this.sz.x + this.laz.x + f.z * bias,
    );
    // Boom: behind (-forward) and up.
    const back = Math.cos(pitch) * dist;
    const up = Math.sin(pitch) * dist;
    const followPos = this.tmp.set(this.focus.x - f.x * back, this.focus.y + up, this.focus.z - f.z * back);
    const followLook = this.tmp2.copy(this.focus);

    springStep(this.fovKick, 0, 18, dt);
    let fov = fovBase + this.fovKick.x;

    if (this.rail) {
      const r = this.rail;
      r.t += dt / Math.max(0.01, r.opts.duration);
      const e = (r.opts.ease ?? easeInOut)(Math.min(1, r.t));
      r.pos.getPointAt(e, this.railPos);
      if (r.look) r.look.getPointAt(e, this.railLook);
      else if (r.lookFixed) this.railLook.copy(r.lookFixed);
      else this.railLook.copy(followLook);
      cam.position.copy(this.railPos);
      cam.lookAt(this.railLook);
      if (r.opts.fov) fov = r.opts.fov;
      if (r.t >= 1) {
        // Keep the last rail pose as the blend origin.
        this.stopRail();
      }
    } else if (this.blendBack > 0) {
      const total = this.tuning.camera.railBlendBack;
      this.blendBack = Math.max(0, this.blendBack - dt);
      const w = easeInOut(1 - this.blendBack / total);
      cam.position.lerpVectors(this.railPos, followPos, w);
      this.railLook.lerp(followLook, w);
      cam.lookAt(this.railLook);
    } else {
      cam.position.copy(followPos);
      cam.lookAt(followLook);
    }

    // Shake: positional + a touch of roll, amplitude trauma².
    if (this.trauma > 0) {
      const a = this.trauma * this.trauma * C.shakeMax;
      const t = this.time * C.shakeFreq;
      cam.position.x += shakeNoise(t, 1.3) * a;
      cam.position.y += shakeNoise(t, 7.1) * a * 0.6;
      cam.position.z += shakeNoise(t, 3.7) * a * 0.5;
      cam.rotateZ(shakeNoise(t, 9.2) * a * 0.12);
      this.trauma = Math.max(0, this.trauma - C.shakeDecay * dt);
    }

    if (Math.abs(cam.fov - fov) > 1e-3) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }

  private updateBasis(): void {
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }
}

/** main.ts wiring: create once, then `rig.update(frameDt, player.renderPosition, player.velocity)`. */
export function installCamera(ctx: GameContext): CameraRig {
  const rig = new CameraRig(ctx.render.camera, ctx.tuning, ctx.events);
  rig.reduceMotion = ctx.settings.reduceMotion;
  ctx.events.on('settings:changed', ({ key }) => {
    if (key === 'reduceMotion') rig.reduceMotion = ctx.settings.reduceMotion;
  });
  return rig;
}
