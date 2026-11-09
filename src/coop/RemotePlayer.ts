/**
 * The partner's wizard on THIS machine (online co-op). Each client is authoritative for its own
 * wizard, so this is a replica: `position` is the NEWEST replicated state (host contact tests use
 * it, with a slightly smaller radius — favor the victim), while the visible body is a regular
 * `Player` driven toward the interpolated state through a puppet input, so it walks, dashes and
 * lights its crystal with the real animation set. Damage and ink are forwarded to the owner.
 */
import * as THREE from 'three';
import { EventBus, type GameEvents } from '../core/events';
import type { DamageSource, GameContext, HeroId, PlayerAPI, PlayerSlot, RevealAPI } from '../core/types';
import { PAL, type Ramp } from '../data/palette';
import { applyRemoteAction, type HeroActionEvent, type HeroHost } from '../entities/heroes/HeroKit';
import { isHeroId } from '../entities/heroes/perks';
import { loadKit } from '../entities/heroes/registry';
import { type LoadedCharacter, Player } from '../entities/Player';
import { INTERP_DEFAULTS, type InterpSample, SnapshotInterpolator } from '../net/interp';
import { PuppetInput } from './input2';
import { captureRamps, setSketchLook } from './look';
import { emptyWiz, WF, type WizState } from './wire';

const _s: InterpSample = { x: 0, y: 0, z: 0, yaw: 0, extrapolated: false };

export interface RemoteHooks {
  /** Something on this machine hurt the partner (ghost contact on the host). */
  damage(amount: number, source: DamageSource): void;
  /** Ink for the partner (pickups / grants resolved here). */
  grant(amount: number): void;
  /** Pages for the partner (their Colorist gold flat, resolved here). */
  heal?(pages: number): void;
}

export class RemotePlayer implements PlayerAPI {
  readonly remote = true;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly facing = new THREE.Vector3(0, 0, 1);
  readonly crystalPos = new THREE.Vector3();
  readonly contactShrink: number;
  /** Interpolated (render) position. */
  readonly renderPosition = new THREE.Vector3();
  readonly body: Player;
  readonly state: WizState = emptyWiz();
  readonly interp = new SnapshotInterpolator({ ...INTERP_DEFAULTS, minDelayMs: 60 });
  /** Seconds since the last state arrived. */
  silentS = 0;
  /** 1 = present, fades to 0 after a disconnect. */
  presence = 1;
  hooks: RemoteHooks | null = null;
  private readonly input = new PuppetInput();
  private lastDash = -1;
  private lastCast = -1;
  private haveState = false;
  private sketch = false;
  private readonly bus = new EventBus<GameEvents>();
  private readonly dummyCenter = new THREE.Vector3();
  /** The partner's hero (lobby pick). Its kit is a lazy chunk; actions wait for it. */
  hero: HeroId = 'inker';
  private kitReady = true;
  private readonly pendingActs: { ev: HeroActionEvent; world: boolean }[] = [];
  private readonly pendingPerks: string[] = [];
  private disposed = false;

  constructor(
    private readonly ctx: GameContext,
    readonly slot: PlayerSlot,
    character: LoadedCharacter | null,
    tint: Ramp | null = PAL.teal,
  ) {
    this.contactShrink = ctx.tuning.coop.net.contactShrink;
    const real = ctx.reveal;
    const dummy = this.dummyCenter;
    // the body's crystal must not drive the real reveal (crystal 1 is set from replicated state);
    // its dash trail still inks the shared page
    const reveal: RevealAPI = {
      center: dummy,
      radius: 0,
      targetRadius: 0,
      blankPage: 0,
      uniforms: real.uniforms,
      addSource: (x, z, r, life) => real.addSource(x, z, r, life),
      removeSource: (h) => real.removeSource(h),
      eraseStrip: () => {},
      revealAt: (x, z) => real.revealAt(x, z),
      isRevealed: (x, z) => real.isRevealed(x, z),
      update: () => {},
      reset: () => {},
    };
    this.body = new Player(
      {
        events: this.bus,
        tuning: ctx.tuning,
        settings: ctx.settings,
        input: this.input,
        collision: ctx.collision,
        reveal,
        render: ctx.render,
        // the partner's hero kit plays here (puppet): it targets, draws and sounds like a local one
        targets: ctx.targets,
        audio: ctx.audio,
        scene: () => ctx.render.scene,
        shared: () => ctx.render.shared ?? null,
        t: (k) => ctx.t(k),
        beat: () => ctx.beat,
        playerCount: () => ctx.players?.length ?? 2,
      },
      {
        value: 100,
        max: 100,
        drain: (n: number) => n,
        add: () => 0,
        reset: () => {},
      },
    );
    this.body.godMode = true;
    this.body.slot = slot;
    // kit side effects reach the real game (hero:print, ink drops, lures, shakes, panel cuts, sfx);
    // the body's own player events stay on its private bus. Ink / pages go to their owner.
    const kh = this.body.host as { -readonly [K in keyof HeroHost]: HeroHost[K] };
    Object.defineProperty(kh, 'events', { value: ctx.events, configurable: true });
    kh.addEnergy = (n) => {
      if (n > 0) this.hooks?.grant(n);
    };
    kh.heal = (n) => this.hooks?.heal?.(n);
    kh.spend = () => true;
    if (character) {
      this.body.setModel(character.scene, character.animations);
      captureRamps(this.body.object, tint);
    }
    this.body.object.name = `partner-${slot}`;
    ctx.render.scene.add(this.body.object);
  }

  // ── PlayerAPI ──
  get object(): THREE.Object3D {
    return this.body.object;
  }
  get pages(): number {
    return this.state.pages;
  }
  get energy(): number {
    return this.state.energy;
  }
  get invulnerable(): boolean {
    return (this.state.flags & (WF.invuln | WF.downed)) !== 0 || (this.state.flags & WF.alive) === 0;
  }
  get crystalHeld(): boolean {
    return (this.state.flags & WF.held) !== 0;
  }
  get downed(): boolean {
    return (this.state.flags & WF.downed) !== 0 || this.presence < 1;
  }
  get crystalRadius(): number {
    return this.state.cr;
  }
  damage(amount: number, source: DamageSource): void {
    if (this.invulnerable || amount <= 0) return;
    this.hooks?.damage(amount, source);
  }
  addEnergy(amount: number): void {
    if (amount > 0) this.hooks?.grant(amount);
  }
  teleport(): void {
    // the partner owns its position
  }
  setControllable(): void {}
  playClip(name: string, loop?: boolean): void {
    this.body.playClip(name, loop);
  }

  /** Play the partner's hero (lobby pick): loads its kit chunk; actions queue meanwhile. */
  setHero(id: string): Promise<void> {
    const hero: HeroId = isHeroId(id) ? id : 'inker';
    this.hero = hero;
    if (this.body.kit.id === hero) {
      this.body.kit.remote = true;
      return Promise.resolve();
    }
    this.kitReady = false;
    return loadKit(hero).then((make) => {
      if (this.disposed || this.hero !== hero) return;
      const kit = make();
      kit.remote = true;
      this.body.setKit(kit);
      this.kitReady = true;
      for (const p of this.pendingPerks.splice(0)) this.applyPerk(p);
      for (const a of this.pendingActs.splice(0)) this.applyAction(a.ev, a.world);
    });
  }

  /**
   * A replicated `hero:action` of the partner: replay it on the puppet kit. `world` = this machine
   * resolves its world effects (the host). The payload is copied (senders reuse theirs).
   */
  applyAction(ev: HeroActionEvent, world: boolean): void {
    const copy: HeroActionEvent = {
      pid: ev.pid,
      hero: ev.hero,
      action: ev.action,
      data: { ...(ev.data ?? {}) },
    };
    if (!this.kitReady) {
      if (this.pendingActs.length < 32) this.pendingActs.push({ ev: copy, world });
      return;
    }
    applyRemoteAction(this.body.kit, copy, world);
  }

  /** The partner picked a page perk: their puppet kit plays it too. */
  applyPerk(perk: string): void {
    if (!this.kitReady) {
      this.pendingPerks.push(perk);
      return;
    }
    const k = this.body.kit;
    if (!k.perks.has(perk)) k.applyPerk(perk);
  }

  /** New run: the partner's perks reset with it. */
  resetPerks(): void {
    this.pendingPerks.length = 0;
    this.body.kit.resetPerks();
  }

  /** A replicated state arrived. `time` is in host-clock ms. */
  push(s: WizState, time: number): void {
    const st = this.state;
    Object.assign(st, s);
    this.position.set(s.x, s.y, s.z);
    this.velocity.set(s.vx, 0, s.vz);
    this.facing.set(Math.sin(s.yaw), 0, Math.cos(s.yaw));
    this.crystalPos.set(s.cx, s.cy, s.cz);
    this.interp.noteSnapshot(time);
    this.interp.push(0, time, s.x, s.y, s.z, s.yaw, [s.vx, 0, s.vz]);
    this.silentS = 0;
    if (!this.haveState) {
      this.haveState = true;
      this.body.teleport(s.x, s.y, s.z, s.yaw);
      this.lastDash = s.dashSerial;
      this.lastCast = s.castSerial;
    }
  }

  /** Sim step: steer the visual body toward the interpolated state. `hostNow` in host ms. */
  step(dt: number, hostNow: number): void {
    this.silentS += dt;
    const inp = this.input.state;
    inp.move.set(0, 0);
    inp.dashPressed = false;
    if (this.haveState && this.interp.sample(0, hostNow, _s)) {
      this.renderPosition.set(_s.x, _s.y, _s.z);
      const b = this.body.position;
      const dx = _s.x - b.x;
      const dz = _s.z - b.z;
      const d = Math.hypot(dx, dz);
      if (d > 2.2) this.body.teleport(_s.x, _s.y, _s.z, _s.yaw);
      else if (d > 0.05) {
        // default view basis (forward -Z, right +X): screen move = (dx, -dz)
        const k = Math.min(1, d / 0.45);
        inp.move.set((dx / d) * k, (-dz / d) * k);
      }
      const st = this.state;
      if (st.dashSerial !== this.lastDash) {
        this.lastDash = st.dashSerial;
        inp.dashPressed = true;
        inp.dashDir.set(Math.sin(_s.yaw), -Math.cos(_s.yaw));
      }
      if (st.castSerial !== this.lastCast) {
        this.lastCast = st.castSerial;
        this.body.castTap(null);
      }
      inp.crystalHeld = this.crystalHeld && this.presence >= 1;
    }
    this.body.speedMul = this.downed ? this.ctx.tuning.coop.downed.speedMul * 1.4 : 1.15;
    this.body.step(dt);
    // remote kits are not stepped by their Player (it skips them): rulers fly, words land, flats tick
    if (this.body.kit.remote) this.body.kit.update(dt);
    const sk = (this.state.flags & WF.downed) !== 0;
    if (sk !== this.sketch) {
      this.sketch = sk;
      setSketchLook(this.body.object, sk);
    }
  }

  render(alpha: number, frameDt: number, cam: THREE.Camera): void {
    this.body.render(alpha, frameDt);
    this.body.faceCamera(cam);
    // disconnected: the partner is slowly erased back into the paper
    const p = this.presence;
    const o = this.body.object;
    o.visible = p > 0.02;
    if (p < 1) {
      o.scale.set(1, Math.max(0.05, p), 1);
      o.position.y -= (1 - p) * 0.6;
    } else o.scale.set(1, 1, 1);
  }

  dispose(): void {
    this.disposed = true;
    this.body.dispose();
  }
}
