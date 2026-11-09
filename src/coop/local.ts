/**
 * `?local2p=1`: a second wizard on the same screen (keyboard IJKL/U/O/H/N or a second gamepad),
 * used to validate the multi-player refactors offline. Both wizards are real `Player`s with their
 * own ink, combat, crystal (RevealSystem crystal 1), hero kit, Splash meter and perks; the camera
 * frames both. `?hero2=letterer` picks player 2's hero (default: the Inker). Pair combos resolve
 * here (this machine is the world authority).
 */
import * as THREE from 'three';
import type { HeroId, PageId, PlayerAPI } from '../core/types';
import { PAL } from '../data/palette';
import { installCombos } from '../entities/heroes/combos';
import { isHeroId } from '../entities/heroes/perks';
import { loadKit } from '../entities/heroes/registry';
import { type LoadedCharacter, Player } from '../entities/Player';
import type { RevealSystem } from '../render/reveal/RevealSystem';
import { Combat } from '../systems/combat';
import { InkEnergy } from '../systems/ink-energy';
import { PartnerHud } from '../ui/hud/partner';
import { PartnerBus } from './bus';
import { ComboEffects } from './combos';
import { SecondInput } from './input2';
import { levelHooks, placeOthers } from './level';
import { captureRamps } from './look';
import { autoplayFor, loadWizardModel } from './model';
import { PickupRouter } from './pickups';
import { crystalView, installCoopTargeting } from './puppet';
import { CoopRules, type Member } from './rules';
import type { CoopHost, CoopSession } from './types';

const _mid = new THREE.Vector3();

/** `?hero2=` (player 2's hero in local 2P), else the Inker. */
export function hero2Flag(search = typeof location !== 'undefined' ? location.search : ''): HeroId {
  const v = new URLSearchParams(search).get('hero2');
  return isHeroId(v) ? v : 'inker';
}

export async function startLocal2p(host: CoopHost, hero2: HeroId = hero2Flag()): Promise<LocalCoop> {
  const [model, make] = await Promise.all([loadWizardModel(), loadKit(hero2)]);
  const lc = new LocalCoop(host, model);
  lc.p2.setKit(make());
  return lc;
}

export class LocalCoop implements CoopSession {
  readonly kind = 'local' as const;
  readonly authority = true;
  readonly p2: Player;
  readonly input2 = new SecondInput();
  readonly energy2: InkEnergy;
  readonly combat2: Combat;
  readonly rules: CoopRules;
  readonly bus: PartnerBus;
  private hud: PartnerHud | null = null;
  private router: PickupRouter;
  private bot: { dispose(): void } | null = null;
  private offs: (() => void)[] = [];
  private lastDash = 0;
  private stetWas = false;
  /** Pair combos between the two local heroes (this machine resolves them). */
  readonly combos: ComboEffects;

  constructor(
    private readonly host: CoopHost,
    model: LoadedCharacter | null,
  ) {
    const ctx = host.ctx;
    const reveal = ctx.reveal as RevealSystem;
    reveal.setDual(true);
    this.bus = new PartnerBus(ctx.events);
    this.energy2 = new InkEnergy(this.bus, ctx.tuning);
    this.p2 = new Player(
      {
        events: this.bus,
        tuning: ctx.tuning,
        settings: ctx.settings,
        input: this.input2,
        collision: ctx.collision,
        reveal: crystalView(reveal),
        render: ctx.render,
        stats: ctx.stats,
        view: host.rig,
        beat: () => ctx.beat,
        // hero kits: player 2's kit targets, draws and sounds like player 1's
        targets: ctx.targets,
        audio: ctx.audio,
        scene: () => ctx.render.scene,
        shared: () => ctx.render.shared ?? null,
        t: (k) => ctx.t(k),
        playerCount: () => ctx.players?.length ?? 2,
      },
      this.energy2,
    );
    this.p2.slot = 1;
    // what player 2 can print with a non-Inker kit: the same spots as player 1
    this.p2.printSpots = () => host.player.printSpots?.() ?? [];
    host.player.slot = 0;
    if (model) {
      this.p2.setModel(model.scene, model.animations);
      captureRamps(this.p2.object, PAL.teal);
    }
    captureRamps(host.player.object);
    ctx.render.scene.add(this.p2.object);
    this.combat2 = new Combat(
      {
        events: this.bus,
        tuning: ctx.tuning,
        settings: ctx.settings,
        input: this.input2,
        targets: ctx.targets,
        collision: ctx.collision,
        stats: ctx.stats,
        seed: 11,
        audio: ctx.audio,
        beat: () => ctx.beat,
      },
      this.p2,
      this.energy2,
    );
    this.combat2.projectiles = host.enemies.projectiles;
    host.enemies.deps.getPlayers = () => ctx.players ?? [];
    host.enemies.deps.crystals = [reveal, crystalView(reveal)];
    installCoopTargeting(host.enemies);
    ctx.render.scene.add(this.combat2.object);
    ctx.players = [host.player, this.p2];
    const members: Member[] = [
      { api: host.player, body: host.player, slot: 0, addInk: (n) => host.energy.add(n) },
      { api: this.p2, body: this.p2, slot: 1, addInk: (n) => this.energy2.add(n) },
    ];
    this.rules = new CoopRules(ctx, members, {
      authority: true,
      path: () => host.level()?.def.path ?? null,
      triggers: () => host.level()?.triggers ?? null,
      spread: () => {
        const f = host.editor()?.fsm;
        return f ? { on: f.spread, x: f.gutterX } : null;
      },
    });
    this.router = new PickupRouter(ctx, host.pickups, [
      { api: host.player, add: (n) => host.energy.add(n) },
      { api: this.p2, add: (n) => this.energy2.add(n) },
    ]);
    if (typeof document !== 'undefined') {
      this.hud = new PartnerHud((k, v) => ctx.t(k, v), document.getElementById('ui-root') ?? document.body);
    }
    this.combos = new ComboEffects(ctx, host.enemies);
    this.offs.push(
      installCombos(
        ctx.events,
        () => ctx.time.simTime,
        (x, z) => ctx.collision.groundHeight(x, z),
        (h) => this.combos.play(h, true),
      ),
    );
    if (host.heroes) this.offs.push(host.heroes.addLocal(this.p2));
    this.offs.push(
      // which wizard dashed? the payload starts where the dasher stands
      ctx.events.on('player:dash', (e) => {
        const [ax, , az] = e.from;
        const [bx, , bz] = e.to;
        const d1 = Math.hypot(host.player.position.x - ax, host.player.position.z - az);
        const d2 = Math.hypot(this.p2.position.x - ax, this.p2.position.z - az);
        this.lastDash = d2 < d1 ? 1 : 0;
        this.rules.partnerDash(this.lastDash as 0 | 1, ax, az, bx, bz);
      }),
      ctx.events.on('caption:effect', (e) => {
        if (e.effect === 'inkDrought') this.energy2.drain(ctx.tuning.worldMeta.captions.inkDrought);
      }),
    );
    ctx.events.emit('coop:players', { count: 2 });
    ctx.events.emit('coop:peer', { state: 'joined', pid: 1 });
    host.enemies.setPlayerCount(2, true);
    if (typeof document !== 'undefined') document.documentElement.dataset.coop = 'local';
  }

  stepPlayers(dt: number): void {
    this.input2.poll();
    this.p2.step(dt);
  }

  stepCombat(dt: number): void {
    this.combat2.step(dt);
  }

  stepPickups(dt: number): void {
    this.router.step(dt);
  }

  preWorld(_dt: number): void {}

  postStep(dt: number): void {
    this.rules.step(dt);
    this.combos.step(dt);
  }

  sight(): boolean {
    return this.p2.kit.id === 'penciller';
  }

  frame(alpha: number, frameDt: number): void {
    const host = this.host;
    const cam = host.ctx.render.camera;
    this.p2.render(alpha, frameDt);
    this.p2.faceCamera(cam);
    this.combat2.render(alpha);
    this.combos.frame(frameDt);
    const hud = this.hud;
    if (!hud) return;
    const stet = !!host.editor()?.fsm.stet.active;
    if (stet && !this.stetWas) hud.banner(host.ctx.t('coop.run.stetHint'), 3);
    this.stetWas = stet;
    const r = host.ctx.render.renderer.domElement;
    const T = host.ctx.tuning;
    hud.update(
      frameDt,
      {
        name: host.ctx.t('coop.run.player2'),
        pages: this.p2.pages,
        maxPages: T.player.maxPages,
        ink: this.energy2.value,
        inkMax: this.energy2.max,
        tier: null,
        rtt: Number.NaN,
        status: this.rules.down.has(1)
          ? host.ctx.t('coop.run.downed')
          : this.rules.atExit(0) !== this.rules.atExit(1)
            ? host.ctx.t('coop.run.waitExit')
            : null,
        partner: this.p2.renderPosition,
        downed: this.downedView(),
        strain: this.rules.strain,
        reduceMotion: host.ctx.settings.reduceMotion,
        splash: this.p2.splash.value,
      },
      cam,
      r.clientWidth || innerWidth,
      r.clientHeight || innerHeight,
    );
  }

  private readonly dv = [
    { pos: new THREE.Vector3(), revive: 0, on: false },
    { pos: new THREE.Vector3(), revive: 0, on: false },
  ];
  private downedView() {
    const ps: PlayerAPI[] = [this.host.player, this.p2];
    for (let k = 0; k < 2; k++) {
      const d = this.dv[k]!;
      d.on = this.rules.down.has(k as 0 | 1);
      d.revive = this.rules.revive[k]!;
      d.pos.copy(ps[k]!.position);
    }
    return this.dv;
  }

  cameraFocus(out: THREE.Vector3): number | null {
    const a = this.host.player.renderPosition;
    const b = this.p2.renderPosition;
    _mid.copy(a).add(b).multiplyScalar(0.5);
    out.copy(_mid);
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    return 1 + Math.min(0.7, Math.max(0, (d - 5) / 22));
  }

  onPageStart(_page: PageId): void {
    this.p2.object.visible = true;
    const lvl = this.host.level();
    if (lvl) {
      lvl.coop = levelHooks(this.host.ctx);
      placeOthers(this.host.ctx, lvl);
    }
    this.bot?.dispose();
    this.bot = autoplayFor(this.host, this.input2, this.p2);
  }

  onPageTeardown(): void {
    this.bot?.dispose();
    this.bot = null;
    this.combat2.clear();
    this.combos.clear();
  }

  handlePageComplete(_page: PageId): boolean {
    return false;
  }

  setHudVisible(v: boolean): void {
    this.hud?.setVisible(v);
  }

  dispose(): void {
    const ctx = this.host.ctx;
    for (const o of this.offs) o();
    this.offs.length = 0;
    this.bot?.dispose();
    this.rules.dispose();
    this.combos.dispose();
    this.input2.dispose();
    this.p2.dispose();
    this.combat2.object.removeFromParent();
    this.hud?.dispose();
    (ctx.reveal as RevealSystem).setDual(false);
    this.host.enemies.deps.getPlayers = this.host.enemies.deps.crystals = undefined;
    installCoopTargeting(this.host.enemies, false);
    ctx.players = [this.host.player];
    ctx.events.emit('coop:players', { count: 1 });
    if (typeof document !== 'undefined') delete document.documentElement.dataset.coop;
  }
}
