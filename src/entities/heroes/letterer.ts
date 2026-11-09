/**
 * THE LETTERER (lazy chunk) — reveals only where letters are.
 *
 *  tap    throws a sound-effect word at the nearest ghost. On the beat (±120 ms) words grow:
 *         POW → KAPOW → KA-BLAMM! (+letters, +damage, +reveal). Letters are ink: they reveal
 *         1.2 m in flight and lie on the ground as reveal patches for 3 s.
 *  hold   speech-balloon shield soaking shots; release = "SHHH!" shove that silences Scribblers 2 s.
 *  swipe  WHOOSH dash dropping its letters as reveal stepping-stones.
 *  passive Caption Box: off-screen threats get a "MEANWHILE…" arrow at the screen edge.
 *  ult    SFX STORM: your longest word of the run drops as giant letters.
 */
import * as THREE from 'three';
import type { Damageable } from '../../core/types';
import '../../ui/i18n/heroes';
import { C, HeroFx } from './fx';
import { type HeroAction, type HeroData, KitBase, q2 } from './HeroKit';
import { byId, DelayedHits, type Ghost, inRadius, nearest } from './util';

export const WORDS = ['POW', 'KAPOW', 'KA-BLAMM!'] as const;
const WORD_COL = [C.gold, C.salmon, C.red];
const MAX_WORDS = 3;
const LETTER_GAP = 0.55;

/** Tier of a throw: base (0, or 1 with All Caps) + consecutive on-beat throws, capped at 2. */
export function wordTier(chain: number, base: number): number {
  return Math.min(2, Math.max(0, base + chain));
}

interface Word {
  active: boolean;
  x: number;
  z: number;
  tx: number;
  tz: number;
  tid: number;
  tier: number;
  text: string;
  col: number;
  world: boolean;
  air: number[];
  revealAcc: number;
}

const _v = new THREE.Vector3();

export class LettererKit extends KitBase {
  readonly id = 'letterer' as const;
  private fx: HeroFx | null = null;
  private words: Word[] = [];
  private chain = 0;
  /** Longest word thrown this run (SFX Storm). */
  longest = 'POW';
  /** Shots the balloon can still soak this hold. */
  soak = 0;
  private balloon = -1;
  private holding = false;
  private time = 0;
  private hits = new DelayedHits(() => this.host);
  private storm: { ch: string; x: number; z: number; t: number; done: boolean; world: boolean }[] = [];
  private caption: HTMLElement | null = null;
  private captionAcc = 0;
  /** Last thrown tier (tests / HUD). */
  lastTier = -1;

  protected override configure(): void {
    const m = this.mods;
    m.baseCrystal = false;
    m.baseBolt = false;
    m.radiusIdle = 0;
    if (!this.words.length)
      for (let i = 0; i < MAX_WORDS; i++)
        this.words.push({
          active: false,
          x: 0,
          z: 0,
          tx: 0,
          tz: 0,
          tid: -1,
          tier: 0,
          text: '',
          col: 0,
          world: false,
          air: [],
          revealAcc: 0,
        });
  }

  override resetPerks(): void {
    super.resetPerks();
    this.longest = 'POW';
    this.chain = 0;
  }

  private vfx(): HeroFx | null {
    if (this.fx) return this.fx;
    const parent = this.host.scene();
    if (!parent) return null;
    this.fx = new HeroFx(parent);
    return this.fx;
  }

  private get letterLife(): number {
    const L = this.host.tuning.heroes.letterer;
    return this.has('kerning') ? L.kerning : L.letterLife;
  }

  // ───────── input ─────────

  override onTap(): void {
    const H = this.host;
    const L = H.tuning.heroes.letterer;
    if (!H.spend(L.cost)) {
      H.sfx('ui_click', 0.5, 0.6);
      return;
    }
    const onBeat = !!H.beat()?.onBeat(L.beatWindowMs);
    if (onBeat) this.chain++;
    else if (!this.has('offBeat')) this.chain = 0;
    const tier = wordTier(this.chain, this.has('allCaps') ? 1 : 0);
    this.lastTier = tier;
    if (onBeat) H.events.emit('combat:onBeat', { action: 'bolt' });
    const px = H.position.x;
    const pz = H.position.z;
    const t = nearest(H, px, pz, L.throwRange, 'ghost') ?? nearest(H, px, pz, L.throwRange, 'revealed');
    const range = L.throwRange * 0.7;
    this.act('tap', {
      tier,
      beat: onBeat ? 1 : 0,
      tid: t ? t.id : -1,
      from: [q2(px), q2(pz)],
      to: [q2(t ? t.position.x : px + H.facing.x * range), q2(t ? t.position.z : pz + H.facing.z * range)],
    });
  }

  override onHoldStart(): void {
    const H = this.host;
    const B = H.tuning.heroes.letterer.balloon;
    if (!H.spend(B.cost)) return;
    this.act('hold', { x: q2(H.position.x), z: q2(H.position.z) });
  }

  override onRelease(_heldS: number): void {
    if (!this.holding) return;
    this.act('release', { x: q2(this.host.position.x), z: q2(this.host.position.z) });
  }

  override onSwipe(fromX: number, fromZ: number, dirX: number, dirZ: number): void {
    this.act('swipe', { from: [q2(fromX), q2(fromZ)], dir: [q2(dirX), q2(dirZ)] });
  }

  override onUltimate(): void {
    const H = this.host;
    this.act('ultimate', {
      word: this.longest,
      x: q2(H.position.x),
      z: q2(H.position.z),
      dir: [q2(H.facing.x), q2(H.facing.z)],
    });
  }

  /** The balloon soaks hits while held. */
  onDamage(): boolean {
    if (!this.holding || this.soak <= 0) return false;
    this.soak--;
    const H = this.host;
    H.sfx('bolt_hit', 0.7, 1.8);
    H.events.emit('fx:shake', { intensity: 0.12, duration: 0.12 });
    if (this.soak <= 0 && this.balloon >= 0) this.fx?.discs.kill(this.balloon);
    return true;
  }

  // ───────── do ─────────

  perform(action: HeroAction, data: HeroData, world: boolean): void {
    const H = this.host;
    const L = H.tuning.heroes.letterer;
    if (action === 'tap') {
      const tier = Math.max(0, Math.min(2, Number(data.tier) | 0));
      const f = data.from as number[];
      const to = data.to as number[];
      const text = String(data.text ?? WORDS[tier]);
      this.launch(text, tier, f[0]!, f[1]!, to[0]!, to[1]!, Number(data.tid ?? -1), world);
      if (text.replace(/[^A-Z]/g, '').length > this.longest.replace(/[^A-Z]/g, '').length)
        this.longest = text;
      H.sfx('bolt_fire', 0.9, 1.25 - tier * 0.15);
      if (Number(data.beat)) H.sfx('panel_stinger', 0.25, 1.5);
    } else if (action === 'hold') {
      this.holding = true;
      this.soak = L.balloon.soak;
      const fx = this.vfx();
      if (fx)
        this.balloon = fx.discs.spawn(H.position.x, H.position.y + 0.05, H.position.z, 1.1, C.cream, 3, 60);
      H.sfx('crystal_on', 0.5, 1.4);
    } else if (action === 'release') {
      this.holding = false;
      if (this.balloon >= 0) this.fx?.discs.kill(this.balloon);
      this.balloon = -1;
      this.shove(Number(data.x), Number(data.z), world);
    } else if (action === 'swipe') {
      const f = data.from as number[];
      const d = data.dir as number[];
      this.whoosh(f[0]!, f[1]!, d[0]!, d[1]!, world);
    } else if (action === 'ultimate') {
      const d = data.dir as number[];
      this.sfxStorm(String(data.word ?? this.longest), Number(data.x), Number(data.z), d[0]!, d[1]!, world);
    }
  }

  private launch(
    text: string,
    tier: number,
    fx: number,
    fz: number,
    tx: number,
    tz: number,
    tid: number,
    world: boolean,
  ): void {
    const w = this.words.find((x) => !x.active) ?? this.words[0]!;
    if (w.active) this.land(w);
    w.active = true;
    w.x = fx;
    w.z = fz;
    w.tx = tx;
    w.tz = tz;
    w.tid = tid;
    w.tier = tier;
    w.text = text;
    w.col = WORD_COL[tier] ?? C.gold;
    w.world = this.resolves(world);
    w.revealAcc = 1e9;
    w.air.length = 0;
    const v = this.vfx();
    if (v) {
      const y = this.host.position.y + 1.3;
      const sz = 0.55 + tier * 0.12;
      for (let i = 0; i < text.length; i++) w.air.push(v.air.spawn(text[i]!, fx, y, fz, sz, w.col, 8));
    }
  }

  private stepWords(dt: number): void {
    const H = this.host;
    const L = H.tuning.heroes.letterer;
    const speed = L.speed * (this.has('italics') ? L.italics : 1);
    for (const w of this.words) {
      if (!w.active) continue;
      if (w.tid >= 0 && this.has('italics')) {
        // italics: words lean into their target
        const t = this.findTarget(w.tid);
        if (t?.alive) {
          w.tx = t.position.x;
          w.tz = t.position.z;
        }
      }
      const dx = w.tx - w.x;
      const dz = w.tz - w.z;
      const d = Math.hypot(dx, dz);
      const s = speed * dt;
      const ux = d > 1e-4 ? dx / d : 0;
      const uz = d > 1e-4 ? dz / d : 0;
      if (d > s) {
        w.x += ux * s;
        w.z += uz * s;
      } else {
        w.x = w.tx;
        w.z = w.tz;
      }
      // letters reveal a little ink in flight (sparse sources: 16-slot budget)
      w.revealAcc += s;
      // (reveal is per machine: every copy of the word inks, only the resolving one hits)
      if (w.revealAcc >= 1.8) {
        w.revealAcc = 0;
        H.reveal.addSource(w.x, w.z, L.flightReveal, 0.4);
      }
      const v = this.fx;
      if (v) {
        const y = H.position.y + 1.3 + Math.sin(this.time * 9) * 0.06;
        const sz = 0.55 + w.tier * 0.12;
        for (let i = 0; i < w.air.length; i++) {
          const o = (i - (w.air.length - 1) / 2) * sz * 0.8;
          v.air.place(w.air[i]!, w.x - uz * o, y + (i % 2) * 0.12, w.z + ux * o, sz);
        }
      }
      if (d <= s) this.land(w);
    }
  }

  private findTarget(id: number): Damageable | null {
    return byId(this.host, id);
  }

  private land(w: Word): void {
    w.active = false;
    const H = this.host;
    const L = H.tuning.heroes.letterer;
    const v = this.fx;
    for (const i of w.air) v?.air.kill(i);
    w.air.length = 0;
    // letters lie on the ground, perpendicular to the throw
    const dx = w.tx - w.x || H.facing.x;
    const dz = w.tz - w.z || H.facing.z;
    const dl = Math.hypot(dx, dz) || 1;
    const px = -dz / dl;
    const pz = dx / dl;
    const n = w.text.length;
    const life = this.letterLife;
    const y = H.collision.groundHeight(w.x, w.z);
    if (v)
      for (let i = 0; i < n; i++) {
        const o = (i - (n - 1) / 2) * LETTER_GAP;
        v.flat.spawn(
          w.text[i]!,
          w.x + px * o,
          y,
          w.z + pz * o,
          0.75 + w.tier * 0.1,
          w.col,
          life,
          Math.atan2(px, pz),
        );
      }
    H.sfx('bolt_hit', 0.8 + w.tier * 0.1, 1.1 - w.tier * 0.15, [w.x, y + 0.5, w.z]);
    // letter-shaped reveal: one patch per ~3 letters
    const patches = Math.max(1, Math.round(n / 3));
    const rr = L.reveal[w.tier] ?? 1.4;
    for (let k = 0; k < patches; k++) {
      const o = patches === 1 ? 0 : ((k / (patches - 1)) * 2 - 1) * ((n - 1) / 2) * LETTER_GAP;
      H.reveal.addSource(w.x + px * o, w.z + pz * o, rr, life);
    }
    if (!w.world) return;
    const dmg = (L.damage[w.tier] ?? 1) + (this.has('boldFace') ? 1 : 0);
    inRadius(H, w.x, w.z, L.hitRadius + w.tier * 0.3, (t) => this.hits.add(t.id, 0.08, dmg, w.x, w.z));
    if (this.has('ellipsis')) {
      const E = L.ellipsis;
      for (let i = 0; i < 3; i++)
        v?.flat.spawn('.', w.x + (i - 1) * 0.35 + dx / dl, y, w.z + dz / dl, 0.6, C.ink, E.delay + 0.3);
      inRadius(H, w.x, w.z, E.radius, (t) => this.hits.add(t.id, E.delay, E.damage, w.x, w.z));
    }
    if (w.tier >= 2) H.events.emit('fx:shake', { intensity: 0.2, duration: 0.18 });
  }

  private shove(x: number, z: number, world: boolean): void {
    const H = this.host;
    const B = H.tuning.heroes.letterer.balloon;
    const v = this.fx;
    const y = H.collision.groundHeight(x, z);
    const text = 'SHHH!';
    if (v)
      for (let i = 0; i < text.length; i++) {
        const a = (i / text.length) * Math.PI * 2;
        v.flat.spawn(text[i]!, x + Math.sin(a) * 1.6, y, z + Math.cos(a) * 1.6, 0.8, C.teal, 1.5, a);
      }
    H.sfx('eraser_sweep', 0.4, 1.7);
    H.reveal.addSource(x, z, 2, 1.5);
    if (!this.resolves(world)) return;
    inRadius(H, x, z, B.shove, (t) => {
      const g = t as Ghost;
      if (g.kind === undefined) return;
      t.stun?.(g.kind === 'scribbler' ? B.silence : B.stun);
      _v.set(x, t.position.y, z);
      if (t.revealed) t.hit(0, _v);
    });
  }

  private whoosh(fx: number, fz: number, dx: number, dz: number, _world: boolean): void {
    const H = this.host;
    const W = H.tuning.heroes.letterer.whoosh;
    const D = H.tuning.dash;
    const text = 'WHOOSH';
    const v = this.fx ?? this.vfx();
    const y = H.collision.groundHeight(fx, fz);
    for (let i = 0; i < text.length; i++) {
      const k = ((i + 0.5) / text.length) * D.distance;
      v?.flat.spawn(text[i]!, fx + dx * k, y, fz + dz * k, 0.7, C.cream, W.life, Math.atan2(dx, dz));
    }
    for (let k = 0; k < 3; k++) {
      const d = ((k + 0.5) / 3) * D.distance;
      H.reveal.addSource(fx + dx * d, fz + dz * d, W.radius, W.life);
    }
  }

  private sfxStorm(word: string, x: number, z: number, dx: number, dz: number, world: boolean): void {
    const S = this.host.tuning.heroes.letterer.storm;
    const letters = word.replace(/[^A-Z!?]/g, '');
    this.storm.length = 0;
    const n = letters.length;
    for (let i = 0; i < n; i++) {
      const k = 2 + i * S.spacing;
      this.storm.push({
        ch: letters[i]!,
        x: x + dx * k,
        z: z + dz * k,
        t: -i * 0.12,
        done: false,
        world: this.resolves(world),
      });
    }
    this.host.events.emit('fx:panelCut', {
      word: 'sfxStorm',
      focus: [x + dx * 4, this.host.position.y + 1, z + dz * 4],
      reason: 'ultimate',
    });
  }

  private stepStorm(dt: number): void {
    if (!this.storm.length) return;
    const H = this.host;
    const S = H.tuning.heroes.letterer.storm;
    let live = false;
    for (const s of this.storm) {
      if (s.done) continue;
      live = true;
      s.t += dt;
      if (s.t < 0.5) continue;
      s.done = true;
      const y = H.collision.groundHeight(s.x, s.z);
      this.fx?.air.spawn(s.ch, s.x, y + 1.3, s.z, 2.6, C.red, S.life);
      this.fx?.discs.spawn(s.x, y, s.z, S.radius * 0.8, C.ink, 0, 1.2);
      H.sfx('boss_roar', 0.25, 2.2, [s.x, y + 1, s.z]);
      H.events.emit('fx:shake', { intensity: 0.3, duration: 0.2 });
      H.reveal.addSource(s.x, s.z, S.radius, S.life);
      if (!s.world) continue;
      inRadius(H, s.x, s.z, S.radius, (t) => this.hits.add(t.id, 0.08, S.damage, s.x, s.z));
    }
    if (!live) this.storm.length = 0;
  }

  override update(dt: number): void {
    this.time += dt;
    this.stepWords(dt);
    this.stepStorm(dt);
    this.hits.update(dt);
    if (this.holding && this.balloon >= 0 && this.fx) {
      const H = this.host;
      this.fx.discs.move(
        this.balloon,
        H.position.x + H.facing.x * 0.6,
        H.position.y + 0.05,
        H.position.z + H.facing.z * 0.6,
        this.soak > 0 ? 1.1 : 0.6,
      );
      this.fx.discs.refresh(this.balloon);
    }
  }

  override render(_alpha: number, frameDt: number, camera?: THREE.Camera | null): void {
    this.fx?.update(frameDt);
    if (!this.remote && camera) this.captionBox(frameDt, camera);
  }

  private capBest: Damageable | null = null;
  private capD = 0;
  private capCam: THREE.Camera | null = null;
  private readonly capScan = (t: Damageable) => {
    if (!t.alive || (t as Ghost).kind === undefined) return;
    const P = this.host.position;
    const d = (t.position.x - P.x) ** 2 + (t.position.z - P.z) ** 2;
    if (d >= this.capD) return;
    _v.copy(t.position).project(this.capCam!);
    if (Math.abs(_v.x) < 0.92 && Math.abs(_v.y) < 0.9 && _v.z < 1) return; // on screen
    this.capD = d;
    this.capBest = t;
  };

  /** Caption Box: point at the nearest off-screen ghost with a "MEANWHILE…" tag. */
  private captionBox(dt: number, cam: THREE.Camera): void {
    this.captionAcc += dt;
    if (this.captionAcc < 0.1) return;
    this.captionAcc = 0;
    if (typeof document === 'undefined') return;
    const H = this.host;
    const R = H.tuning.heroes.letterer.captionRange;
    this.capBest = null;
    this.capD = R * R;
    this.capCam = cam;
    H.targets?.forEach(this.capScan);
    const best = this.capBest as Damageable | null;
    let el = this.caption;
    if (!best) {
      if (el) el.hidden = true;
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.className = 'hero-caption';
      el.setAttribute('aria-hidden', 'true');
      (document.getElementById('ui-root') ?? document.body).append(el);
      this.caption = el;
    }
    el.textContent = H.t('heroes.meanwhile');
    el.hidden = false;
    _v.copy(best.position).project(cam);
    let sx = _v.x;
    let sy = _v.y;
    if (_v.z > 1) {
      sx = -sx;
      sy = -sy;
    }
    const m = Math.max(Math.abs(sx), Math.abs(sy)) || 1;
    sx /= m;
    sy /= m;
    const ang = Math.atan2(-sy, sx);
    el.style.left = `${(0.5 + sx * 0.42) * 100}%`;
    el.style.top = `${(0.5 - sy * 0.4) * 100}%`;
    el.style.setProperty('--a', `${ang}rad`);
  }

  override dispose(): void {
    super.dispose();
    this.fx?.dispose();
    this.fx = null;
    this.caption?.remove();
    this.caption = null;
    this.hits.clear();
  }
}
