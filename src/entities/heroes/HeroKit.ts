/**
 * Hero class strategy (wave 2). The Player owns locomotion, health, the crystal and the shared
 * input grammar; a HeroKit decides what tap / hold / swipe / double-tap mean:
 *
 *   left drag = move · right tap = attack · right hold = channel/build · right swipe = movement
 *   double-tap right / Q / gamepad LB = ultimate (only when the Splash meter is full)
 *
 * The Inker (today's wizard) is the default kit and runs the original crystal + bolt code paths
 * (`mods.baseCrystal` / `mods.baseBolt`), so it stays behaviour-identical. The other kits are lazy
 * chunks (`registry.ts`).
 *
 * Netcode: every ability is split into "decide" (local input → compact payload) and "do"
 * (payload → visuals + world effects). The local path emits a serializable `hero:action` and then
 * runs the same `perform()` a remote puppet runs from that event (`applyRemoteAction`).
 */
import type * as THREE from 'three';
import type { EventBus, GameEvents } from '../../core/events';
import type {
  BeatAPI,
  CollisionAPI,
  DamageSource,
  HeroId,
  PlayerSlot,
  RevealAPI,
  Settings,
  SfxId,
  TargetRegistry,
} from '../../core/types';
import type { Tuning } from '../../data/tuning';

export type HeroAction = GameEvents['hero:action']['action'];
export type HeroData = Record<string, number | number[] | string>;
export type HeroActionEvent = GameEvents['hero:action'];

/** A spot that can be printed (unprinted sketch, boss weak point). */
export interface PrintSpot {
  x: number;
  z: number;
}

/**
 * What a kit may touch. The local Player builds one around itself; co-op builds one around a
 * RemotePlayer puppet; tests pass a plain object.
 */
export interface HeroHost {
  readonly pid: PlayerSlot;
  readonly position: THREE.Vector3;
  readonly facing: THREE.Vector3;
  readonly crystalPos: THREE.Vector3;
  readonly events: EventBus<GameEvents>;
  readonly tuning: Tuning;
  readonly settings: Settings;
  readonly reveal: RevealAPI;
  readonly collision: CollisionAPI;
  readonly targets: TargetRegistry | null;
  /** Sim seconds (monotonic, from the host's step). */
  readonly time: number;
  /** Players in the session (1 = solo: kits enable their solo assists). */
  readonly playerCount: number;
  /**
   * This machine resolves world effects (damage, stun, pins, lures). False only for the online
   * co-op GUEST's own kit: its actions are resolved by the host's puppet of it and replicated back.
   * Reveal (ink) is per-machine, so kits add reveal sources whatever this says. Default true.
   */
  readonly authority?: boolean;
  beat(): BeatAPI | null;
  /** Scene node kits add their VFX to (null in headless tests). */
  scene(): THREE.Object3D | null;
  /** Render shared uniforms (InkSplash etc.), null headless. */
  shared(): Record<string, THREE.IUniform> | null;
  t(key: string): string;
  /** All-or-nothing ink spend; true if paid. */
  spend(n: number): boolean;
  addEnergy(n: number): void;
  readonly energy: number;
  /** Restore torn pages (Colorist gold flat). */
  heal(pages: number): void;
  /** Unprinted sketches + printable boss weak points near the player. */
  printables(): readonly PrintSpot[];
  sfx(id: SfxId, volume?: number, rate?: number, at?: readonly [number, number, number]): void;
  /** Inker Spot Black: fire `n` bolts in a ring (combat.ts). */
  fireRing?(n: number): void;
  /** Extra max ink (India). */
  setMaxInkBonus?(n: number): void;
  /** Model visibility / sketch look while a kit effect runs (Penciller erase-step). */
  setSketched?(on: boolean): void;
}

/**
 * Per-hero knobs the Player / Combat read at use time. Defaults = the original wizard, so the
 * Inker without perks is the game as it was.
 */
export class HeroMods {
  /** Hold = the Inker's crystal (radius 3 → 7, drains ink, prints). */
  baseCrystal = true;
  /** Tap = combat.ts ink bolts. */
  baseBolt = true;
  /** Crystal idle radius override (m); null = tuning.crystal.radiusIdle. */
  radiusIdle: number | null = null;
  /** Crystal held radius cap (m); null = tuning.crystal.radiusHeld. */
  radiusHeld: number | null = null;
  /** Multiplier on the crystal's ink drain. */
  holdCostMul = 1;
  /** Dash trail reveal life override (Bleed). */
  dashTrailLife: number | null = null;
  /** Dash i-frames override (Penciller erase-step). */
  dashIFrames: number | null = null;
  /** Extra bolt damage when the target stands at the mask edge (Chiaroscuro). */
  edgeBonus = 0;
  /** Bolt splats leave mini reveal puddles (Wet Edge). */
  wetEdge = false;
  /** Bolts pass through targets (Splash Page). */
  pierce = false;
  /** Reveal radius floor while > 0 seconds left (Splash Page full-screen ink). */
  revealBoostR = 0;
  revealBoostT = 0;
  /** Damage sources the hero ignores (Penciller walks erased ground). */
  ignore: DamageSource | null = null;

  reset(): void {
    Object.assign(this, new HeroMods());
  }
}

export interface PerkDef {
  id: string;
}

/** The strategy interface. Every hook is optional except identity + perform. */
export interface HeroKit {
  readonly id: HeroId;
  readonly mods: HeroMods;
  /** Run-scoped perks picked so far. */
  readonly perks: ReadonlySet<string>;
  /** True while the kit is driven by `hero:action` events instead of input. */
  remote: boolean;
  attach(host: HeroHost): void;
  /** Local input (only called when not remote). `dirX/dirZ` = world swipe dir for swipes. */
  onTap(): void;
  onHoldStart(): void;
  onHoldTick(dt: number): void;
  onRelease(heldS: number): void;
  onSwipe(fromX: number, fromZ: number, dirX: number, dirZ: number): void;
  onUltimate(): void;
  /** Passive hooks. */
  onKill?(x: number, z: number, kind: string): void;
  /** Return true if the kit absorbed the hit (Letterer balloon). */
  onDamage?(amount: number, source: DamageSource, from?: THREE.Vector3): boolean;
  /** Holding near a printable spot powers the print light (non-Inker kits). */
  wantsPrintLight?(holding: boolean): boolean;
  /** Sim step. The Player steps local kits; co-op steps remote puppets itself. */
  update(dt: number): void;
  render(alpha: number, frameDt: number, camera?: THREE.Camera | null): void;
  /** Apply a perk (run-scoped). */
  applyPerk(id: string): void;
  resetPerks(): void;
  /** Replay a (remote) action. `world` = also apply world effects (damage, stun, reveal). */
  perform(action: HeroAction, data: HeroData, world: boolean): void;
  dispose(): void;
}

/**
 * Co-op puppet path: replay a received `hero:action` on the partner's kit (visuals always; world
 * effects only on the authority, i.e. the host). Ignores events for another hero.
 */
export function applyRemoteAction(kit: HeroKit, ev: HeroActionEvent, world = false): boolean {
  if (ev.hero !== kit.id) return false;
  kit.perform(ev.action, ev.data ?? {}, world);
  return true;
}

/** Shared plumbing for kits: host, perk set, local emit → perform. */
export abstract class KitBase implements HeroKit {
  abstract readonly id: HeroId;
  readonly mods = new HeroMods();
  readonly perks = new Set<string>();
  remote = false;
  protected host!: HeroHost;
  protected offs: (() => void)[] = [];
  private payload: HeroActionEvent = { pid: 0, hero: 'inker', action: 'tap' };

  attach(host: HeroHost): void {
    this.host = host;
    this.configure();
  }

  /** Set `mods` for this hero (called on attach and after a perk reset). */
  protected configure(): void {}

  onTap(): void {}
  onHoldStart(): void {}
  onHoldTick(_dt: number): void {}
  onRelease(_heldS: number): void {}
  onSwipe(_fx: number, _fz: number, _dx: number, _dz: number): void {}
  onUltimate(): void {}
  update(_dt: number): void {}
  render(_alpha: number, _frameDt: number, _camera?: THREE.Camera | null): void {}

  applyPerk(id: string): void {
    this.perks.add(id);
    this.perkApplied(id);
  }

  protected perkApplied(_id: string): void {}

  has(id: string): boolean {
    return this.perks.has(id);
  }

  resetPerks(): void {
    this.perks.clear();
    this.mods.reset();
    this.configure();
  }

  /** Default print light: holding within reach of an unprinted sketch / weak point. */
  wantsPrintLight(holding: boolean): boolean {
    if (!holding) return false;
    const H = this.host;
    const r = H.tuning.heroes.printLight.reach;
    const px = H.position.x;
    const pz = H.position.z;
    for (const s of H.printables()) {
      const dx = s.x - px;
      const dz = s.z - pz;
      if (dx * dx + dz * dz <= r * r) return true;
    }
    return false;
  }

  abstract perform(action: HeroAction, data: HeroData, world: boolean): void;

  /**
   * `world` effects that need world authority (damage, stun, pins, lures): false on the online
   * guest's own kit, whose `perform(…, world=true)` still runs its own-wizard effects.
   */
  protected resolves(world: boolean): boolean {
    return world && this.host.authority !== false;
  }

  /** Local ability: broadcast it, then run it (with world effects). */
  protected act(action: HeroAction, data: HeroData): void {
    const p = this.payload;
    p.pid = this.host.pid;
    p.hero = this.id;
    p.action = action;
    p.data = data;
    this.host.events.emit('hero:action', p);
    this.perform(action, data, true);
  }

  dispose(): void {
    for (const o of this.offs) o();
    this.offs.length = 0;
  }
}

/** Round to cm for compact payloads. */
export const q2 = (v: number): number => Math.round(v * 100) / 100;
