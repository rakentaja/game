/**
 * THE INKER — today's wizard (default kit, initial bundle). Tap / hold / swipe run the original
 * combat.ts bolts, Player crystal and dash unchanged (`mods.baseBolt/baseCrystal`); this kit only
 * adds the wave-2 layer on top:
 *
 *  - Feathering (passive): kills leave a 1.5 m ink puddle that keeps the ground revealed for 3 s.
 *  - SPLASH PAGE (ultimate): full-screen reveal for 4 s, bolts pierce.
 *  - Perks: P1 Bleed / Drybrush · P2 Chiaroscuro / Wet Edge · P3 Spot Black / India.
 */
import { type HeroAction, type HeroData, KitBase, q2 } from './HeroKit';

export class InkerKit extends KitBase {
  readonly id = 'inker' as const;
  private ultT = 0;
  private holdAcc = 0;
  private holdData = { x: 0, z: 0, r: 0 };

  protected override configure(): void {
    // all base verbs on; perks layer on top of the tuning defaults
  }

  protected override perkApplied(id: string): void {
    const I = this.host.tuning.heroes.inker;
    const m = this.mods;
    if (id === 'bleed') m.dashTrailLife = I.bleedTrailLife;
    else if (id === 'drybrush') {
      m.holdCostMul = I.drybrush.costMul;
      m.radiusHeld = I.drybrush.radius;
    } else if (id === 'chiaroscuro') m.edgeBonus = I.chiaroscuro.bonus;
    else if (id === 'wetEdge') m.wetEdge = true;
    else if (id === 'india') this.host.setMaxInkBonus?.(I.indiaInk);
  }

  override resetPerks(): void {
    super.resetPerks();
    this.host?.setMaxInkBonus?.(0);
  }

  // Feathering
  onKill(x: number, z: number): void {
    const F = this.host.tuning.heroes.inker.feather;
    this.host.reveal.addSource(x, z, F.radius, F.life);
  }

  /** Bolt aim point for the next `onTap` (combat sets it). */
  aimX: number | null = null;
  aimZ: number | null = null;

  /** Combat fired a bolt (base verb): announce it (co-op, Sound & Light). */
  override onTap(): void {
    const H = this.host;
    const f = H.facing;
    const r = H.tuning.bolt.maxRange;
    this.act('tap', {
      from: [q2(H.position.x), q2(H.position.z)],
      to: [q2(this.aimX ?? H.position.x + f.x * r), q2(this.aimZ ?? H.position.z + f.z * r)],
    });
    this.aimX = this.aimZ = null;
  }

  override onHoldStart(): void {
    this.holdAcc = 1; // broadcast the first tick right away
  }

  /** Crystal circles are broadcast at a low rate so combos (Ink the Pencils, Overprint) can see them. */
  override onHoldTick(dt: number): void {
    this.holdAcc += dt * this.host.tuning.heroes.inker.holdHz;
    if (this.holdAcc < 1) return;
    this.holdAcc = 0;
    const d = this.holdData;
    d.x = q2(this.host.crystalPos.x);
    d.z = q2(this.host.crystalPos.z);
    d.r = q2(this.host.reveal.radius);
    this.act('hold', d);
  }

  override onRelease(heldS: number): void {
    if (!this.has('spotBlack') || heldS < this.host.tuning.heroes.inker.spotBlack.minHold) return;
    this.act('release', { x: q2(this.host.position.x), z: q2(this.host.position.z), held: q2(heldS) });
  }

  override onSwipe(fromX: number, fromZ: number, dirX: number, dirZ: number): void {
    // the dash itself is the base verb; announce it for co-op / combos
    this.act('swipe', { from: [q2(fromX), q2(fromZ)], dir: [q2(dirX), q2(dirZ)] });
  }

  override onUltimate(): void {
    this.act('ultimate', { x: q2(this.host.position.x), z: q2(this.host.position.z) });
  }

  perform(action: HeroAction, data: HeroData, world: boolean): void {
    const H = this.host;
    const I = H.tuning.heroes.inker;
    if (action === 'release' && world) {
      H.fireRing?.(I.spotBlack.bolts);
      H.sfx('bolt_fire', 1, 0.8);
    } else if (action === 'ultimate') {
      this.ultT = I.ultimate.time;
      if (!world) return;
      this.mods.pierce = true;
      this.mods.revealBoostR = I.ultimate.radius;
      this.mods.revealBoostT = I.ultimate.time;
      H.sfx('panel_stinger', 1, 0.9);
      const x = typeof data.x === 'number' ? data.x : H.position.x;
      const z = typeof data.z === 'number' ? data.z : H.position.z;
      H.events.emit('fx:panelCut', { word: 'splash', focus: [x, H.position.y + 1, z], reason: 'ultimate' });
    } else if (action === 'swipe' && world && this.remote) {
      // remote puppet: lay the dash trail on this screen too
      const f = data.from as number[] | undefined;
      const d = data.dir as number[] | undefined;
      if (f && d) {
        const D = H.tuning.dash;
        for (let k = 0; k <= D.distance; k += D.trailSpacing)
          H.reveal.addSource(f[0]! + d[0]! * k, f[1]! + d[1]! * k, D.trailRadius, D.trailLife);
      }
    }
  }

  override update(dt: number): void {
    if (this.ultT > 0) {
      this.ultT -= dt;
      if (this.ultT <= 0) this.mods.pierce = false;
    }
  }
}
