import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '../../src/core/events';
import {
  type CollisionAPI,
  type Damageable,
  DEFAULT_SETTINGS,
  type InputAPI,
  type InputState,
  type RevealAPI,
  type TargetRegistry,
} from '../../src/core/types';
import { TUNING } from '../../src/data/tuning';
import { ColoristKit, nextColor, registered } from '../../src/entities/heroes/colorist';
import { ComboDetector, installCombos } from '../../src/entities/heroes/combos';
import { applyRemoteAction, type HeroHost, type HeroKit, HeroMods } from '../../src/entities/heroes/HeroKit';
import { InkerKit } from '../../src/entities/heroes/inker';
import { LettererKit, WORDS, wordTier } from '../../src/entities/heroes/letterer';
import { PencillerKit } from '../../src/entities/heroes/penciller';
import { HERO_IDS, PERKS, perkOptions } from '../../src/entities/heroes/perks';
import { SplashMeter } from '../../src/entities/heroes/splash';
import { Player } from '../../src/entities/Player';
import { Combat } from '../../src/systems/combat';
import { InkEnergy } from '../../src/systems/ink-energy';
import { FLAT_DICTIONARIES } from '../../src/ui/i18n';
import { HERO_DICTS } from '../../src/ui/i18n/heroes';

const DT = 1 / 60;

// ───────────────────────────── fakes ─────────────────────────────

class Ghost implements Damageable {
  readonly position: THREE.Vector3;
  radius = 0.4;
  alive = true;
  inked = false;
  stunT = 0;
  hits: number[] = [];
  stuns: number[] = [];
  constructor(
    readonly id: number,
    x: number,
    z: number,
    public hp = 10,
    readonly kind: string | undefined = 'smudge',
  ) {
    this.position = new THREE.Vector3(x, 0, z);
  }
  get revealed(): boolean {
    return this.alive && (this.inked || this.stunT > 0);
  }
  hit(n: number): void {
    if (!this.revealed) return;
    this.hits.push(n);
    this.hp -= n;
    if (this.hp <= 0) this.alive = false;
  }
  stun(s: number): void {
    this.stuns.push(s);
    this.stunT = Math.max(this.stunT, s);
  }
  tick(dt: number): void {
    this.stunT = Math.max(0, this.stunT - dt);
  }
}

function fakeTargets(list: Damageable[]): TargetRegistry {
  return {
    add: (t) => list.push(t),
    remove: (t) => list.splice(list.indexOf(t), 1),
    nearest: (p, max) => {
      let best: Damageable | null = null;
      let bd = max * max;
      for (const t of list) {
        if (!t.alive || !t.revealed) continue;
        const d = (t.position.x - p.x) ** 2 + (t.position.z - p.z) ** 2;
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
      return best;
    },
    forEach: (fn) => {
      for (const t of list.slice()) fn(t);
    },
  };
}

function fakeReveal(): RevealAPI & { sources: number[][] } {
  const sources: number[][] = [];
  return {
    sources,
    center: new THREE.Vector3(),
    radius: 3,
    targetRadius: 3,
    blankPage: 0,
    uniforms: {},
    addSource(x, z, r, life) {
      sources.push([x, z, r, life]);
      return sources.length;
    },
    removeSource() {},
    eraseStrip() {},
    revealAt: () => 0,
    isRevealed: () => false,
    update() {},
    reset() {},
  };
}

const open: CollisionAPI = {
  groundHeight: () => 0,
  resolveCircle: () => false,
  walkable: () => true,
  segmentClear: () => true,
};

interface World {
  host: HeroHost & { energyV: number; healed: number; prints: { x: number; z: number }[] };
  events: EventBus<GameEvents>;
  reveal: ReturnType<typeof fakeReveal>;
  ghosts: Ghost[];
  actions: GameEvents['hero:action'][];
  onBeat: { v: boolean };
}

function world(pid: 0 | 1 = 0, events = new EventBus<GameEvents>(), ghosts: Ghost[] = []): World {
  const reveal = fakeReveal();
  const onBeat = { v: false };
  const actions: GameEvents['hero:action'][] = [];
  events.on('hero:action', (e) => actions.push({ ...e, data: e.data ? { ...e.data } : undefined }));
  const targets = fakeTargets(ghosts);
  const host = {
    pid,
    position: new THREE.Vector3(),
    facing: new THREE.Vector3(0, 0, 1),
    crystalPos: new THREE.Vector3(0, 2, 0),
    events,
    tuning: TUNING,
    settings: { ...DEFAULT_SETTINGS },
    reveal,
    collision: open,
    targets,
    time: 0,
    playerCount: 1,
    energyV: 100,
    healed: 0,
    prints: [] as { x: number; z: number }[],
    get energy() {
      return this.energyV;
    },
    beat: () => ({ bpm: 120, offsetMs: () => 0, onBeat: () => onBeat.v, phase: () => 0 }),
    scene: () => null,
    shared: () => null,
    t: (k: string) => k,
    spend(n: number) {
      if (this.energyV < n) return false;
      this.energyV -= n;
      return true;
    },
    addEnergy(n: number) {
      this.energyV += n;
    },
    heal(n: number) {
      this.healed += n;
    },
    printables() {
      return this.prints;
    },
    sfx() {},
  };
  return { host, events, reveal, ghosts, actions, onBeat };
}

function step(kit: HeroKit, w: World, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    kit.update(DT);
    for (const g of w.ghosts) g.tick(DT);
  }
}

// ───────────────────────────── shared ─────────────────────────────

describe('hero registry + perks', () => {
  it('every hero has three pages of two perks, boss page has none', () => {
    for (const h of HERO_IDS) {
      expect(PERKS[h]).toHaveLength(3);
      expect(perkOptions(h, 1)).toEqual(PERKS[h][0]);
      expect(perkOptions(h, 'boss')).toBeNull();
    }
  });

  it('hero strings: TR/EN parity, every perk and kit line exists', () => {
    const en = new Map<string, string>();
    const tr = new Map<string, string>();
    const flat = (d: object, p: string, out: Map<string, string>) => {
      for (const [k, v] of Object.entries(d))
        if (typeof v === 'string') out.set(`${p}.${k}`, v);
        else flat(v, `${p}.${k}`, out);
    };
    flat(HERO_DICTS.en, 'heroes', en);
    flat(HERO_DICTS.tr, 'heroes', tr);
    expect([...en.keys()].sort()).toEqual([...tr.keys()].sort());
    for (const h of HERO_IDS) {
      for (const p of PERKS[h].flat()) {
        expect(en.has(`heroes.perk.${p}`), p).toBe(true);
        expect(en.has(`heroes.perkDesc.${p}`), p).toBe(true);
      }
      for (const k of ['tap', 'hold', 'swipe', 'ult']) expect(en.has(`heroes.kit.${h}.${k}`)).toBe(true);
    }
    // registered into the live dictionaries
    expect(FLAT_DICTIONARIES.tr.get('heroes.perk.bleed')).toBe(tr.get('heroes.perk.bleed'));
    for (const k of ['splash', 'layout', 'sfxStorm', 'fourColor'])
      expect(
        FLAT_DICTIONARIES.en.has(`onomatopoeia.${k}`) && FLAT_DICTIONARIES.tr.has(`onomatopoeia.${k}`),
      ).toBe(true);
  });
});

describe('SplashMeter', () => {
  it('charges from kills, prints and combos, emits, and is consumed only when full', () => {
    const ev = new EventBus<GameEvents>();
    const seen: number[] = [];
    ev.on('splash:changed', (e) => seen.push(e.value));
    const m = new SplashMeter(ev);
    expect(m.consume()).toBe(false);
    m.kill();
    expect(m.value).toBeCloseTo(TUNING.heroes.splash.perKill);
    m.print();
    m.combo();
    for (let i = 0; i < 30; i++) m.kill(3);
    expect(m.full).toBe(true);
    expect(seen.at(-1)).toBe(1);
    expect(m.consume()).toBe(true);
    expect(m.value).toBe(0);
  });
});

// ───────────────────────────── Inker parity ─────────────────────────────

function fakeInput(): InputAPI & { state: InputState } {
  return {
    state: {
      move: new THREE.Vector2(),
      crystalHeld: false,
      boltPressed: false,
      dashPressed: false,
      dashDir: new THREE.Vector2(),
      pausePressed: false,
      ultimatePressed: false,
      device: 'touch',
    },
    poll() {},
    setLeftHanded() {},
    setEnabled() {},
    dispose() {},
  };
}

function rig() {
  const events = new EventBus<GameEvents>();
  const input = fakeInput();
  const reveal = fakeReveal();
  const energy = new InkEnergy(events, TUNING);
  const ghosts: Ghost[] = [];
  const player = new Player(
    {
      events,
      tuning: TUNING,
      settings: { ...DEFAULT_SETTINGS },
      input,
      collision: open,
      reveal,
      render: { createInkMaterial: () => new THREE.ShaderMaterial(), addOutline: () => () => {} },
      targets: fakeTargets(ghosts),
    },
    energy,
  );
  player.teleport(0, 0, 0, 0);
  const run = (s: number) => {
    for (let i = 0; i < Math.round(s / DT); i++) {
      player.step(DT);
      input.state.boltPressed = false;
      input.state.dashPressed = false;
      input.state.ultimatePressed = false;
    }
  };
  return { events, input, reveal, energy, player, ghosts, run };
}

describe('Inker kit (default, behaviour parity)', () => {
  it('is the default kit with untouched mods', () => {
    const r = rig();
    expect(r.player.kit).toBeInstanceOf(InkerKit);
    expect({ ...r.player.kit.mods }).toEqual({ ...new HeroMods() });
  });

  it('crystal radius and drain match the tuning exactly', () => {
    const r = rig();
    r.run(0.2);
    expect(r.reveal.targetRadius).toBeCloseTo(TUNING.crystal.radiusIdle, 5);
    r.input.state.crystalHeld = true;
    const before = r.energy.value;
    r.run(1);
    expect(r.reveal.targetRadius).toBeCloseTo(TUNING.crystal.radiusHeld, 1);
    expect(before - r.energy.value).toBeCloseTo(TUNING.crystal.drainPerSec, 0);
  });

  it('Feathering: a kill leaves a 1.5 m / 3 s puddle', () => {
    const r = rig();
    r.events.emit('enemy:died', { id: 3, kind: 'smudge', position: [2, 0, 5] });
    const F = TUNING.heroes.inker.feather;
    expect(r.reveal.sources.at(-1)).toEqual([2, 5, F.radius, F.life]);
  });

  it('double-tap ultimate only fires with a full meter: Splash Page reveal + piercing bolts', () => {
    const r = rig();
    r.input.state.ultimatePressed = true;
    r.run(DT);
    expect(r.player.kit.mods.pierce).toBe(false);
    r.player.splash.reset(1);
    r.input.state.ultimatePressed = true;
    r.run(DT);
    expect(r.player.splash.value).toBe(0);
    expect(r.player.kit.mods.pierce).toBe(true);
    r.run(0.5);
    expect(r.reveal.targetRadius).toBeGreaterThanOrEqual(TUNING.heroes.inker.ultimate.radius);
    r.run(TUNING.heroes.inker.ultimate.time);
    expect(r.player.kit.mods.pierce).toBe(false);
    expect(r.reveal.targetRadius).toBeCloseTo(TUNING.crystal.radiusIdle, 3);
  });

  it('perks: Bleed trails, Drybrush cost + cap, India max ink, reset per run', () => {
    const r = rig();
    const kit = r.player.kit;
    kit.applyPerk('bleed');
    r.input.state.dashPressed = true;
    r.input.state.dashDir.set(0, 1);
    r.run(0.4);
    expect(r.reveal.sources.at(-1)![3]).toBe(TUNING.heroes.inker.bleedTrailLife);
    kit.applyPerk('drybrush');
    r.input.state.crystalHeld = true;
    r.run(1.6);
    expect(r.reveal.targetRadius).toBeCloseTo(TUNING.heroes.inker.drybrush.radius, 1);
    const e0 = r.energy.value;
    r.run(1);
    expect(e0 - r.energy.value).toBeCloseTo(TUNING.crystal.drainPerSec * 0.5, 0);
    kit.applyPerk('india');
    expect(r.energy.max).toBe(TUNING.energy.max + TUNING.heroes.inker.indiaInk);
    kit.resetPerks();
    expect(r.energy.max).toBe(TUNING.energy.max);
    expect(kit.perks.size).toBe(0);
    expect(kit.mods.holdCostMul).toBe(1);
  });

  it('Spot Black fires a bolt ring on release; Wet Edge splats leave puddles', () => {
    const r = rig();
    const combat = new Combat(
      {
        events: r.events,
        tuning: TUNING,
        settings: { ...DEFAULT_SETTINGS },
        input: r.input,
        targets: fakeTargets(r.ghosts),
        collision: open,
        reveal: r.reveal,
      },
      r.player,
      { spend: (n) => r.energy.spend(n) },
    );
    r.player.kit.applyPerk('spotBlack');
    r.player.kit.applyPerk('wetEdge');
    r.input.state.crystalHeld = true;
    r.run(1);
    r.input.state.crystalHeld = false;
    r.run(DT);
    expect(combat.liveBolts).toBe(TUNING.heroes.inker.spotBlack.bolts);
    const n0 = r.reveal.sources.length;
    for (let i = 0; i < 120; i++) combat.step(DT);
    const W = TUNING.heroes.inker.wetEdge;
    expect(r.reveal.sources.slice(n0).some((s) => s[2] === W.radius && s[3] === W.life)).toBe(true);
  });

  it('non-Inker kits: the tap goes to the kit, not to combat bolts', () => {
    const r = rig();
    const k = new PencillerKit();
    r.player.setKit(k);
    expect(r.player.kit.mods.baseBolt).toBe(false);
    r.input.state.boltPressed = true;
    r.run(DT);
    expect(r.energy.value).toBe(TUNING.energy.start - TUNING.heroes.penciller.ruler.cost);
    // no light at all
    r.run(1);
    expect(r.reveal.targetRadius).toBe(0);
  });
});

// ───────────────────────────── Penciller ─────────────────────────────

function circleTrace(kit: PencillerKit, w: World, cx: number, cz: number, r: number): void {
  kit.onHoldStart();
  for (let a = 0; a <= Math.PI * 2.3; a += 0.12) {
    w.host.position.set(cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r);
    kit.onHoldTick(DT);
  }
  kit.onRelease(1);
}

describe('Penciller', () => {
  it('ruler pins a ghost anywhere (even unrevealed) for 2.5 s', () => {
    const w = world(0, undefined, [new Ghost(1, 0, 6)]);
    const k = new PencillerKit();
    k.attach(w.host);
    k.onTap();
    expect(w.actions.at(-1)!.action).toBe('tap');
    step(k, w, 0.6); // flight
    const g = w.ghosts[0]!;
    expect(g.stuns).toEqual([TUNING.heroes.penciller.ruler.pin]);
    expect(k.isPinned(1)).toBe(true);
    expect(g.revealed).toBe(true); // pinned = hittable outside the ink
    step(k, w, 2.4);
    expect(k.isPinned(1)).toBe(false);
  });

  it('closing a loop crushes pinned ghosts inside (2 dmg, ignoring ink); solo spark; prints sketches', () => {
    const w = world(0, undefined, [new Ghost(1, 0, 4), new Ghost(2, 0.3, 4.2), new Ghost(3, 9, 9)]);
    w.host.prints.push({ x: 0.2, z: 3.8 });
    const prints: GameEvents['hero:print'][] = [];
    w.events.on('hero:print', (e) => prints.push({ ...e }));
    const k = new PencillerKit();
    k.attach(w.host);
    k.onTap();
    step(k, w, 0.5);
    circleTrace(k, w, 0, 4, 1.6);
    expect(k.loops).toBeGreaterThanOrEqual(1);
    expect(w.ghosts[0]!.hits).toEqual([TUNING.heroes.penciller.crush.damage]);
    expect(w.ghosts[1]!.hits).toEqual([]); // not pinned
    expect(w.ghosts[2]!.hits).toEqual([]);
    expect(w.reveal.sources.length).toBeGreaterThan(0); // solo assist spark
    expect(prints).toHaveLength(1);
    expect(w.actions.some((a) => a.action === 'hold' && a.data?.kind === 'loop')).toBe(true);
  });

  it('perks: Long Lead pins 4 s, Crosshatch +1 crush, eraser ignored, erase-step i-frames', () => {
    const w = world(0, undefined, [new Ghost(1, 0, 4)]);
    const k = new PencillerKit();
    k.attach(w.host);
    k.applyPerk('longLead');
    k.applyPerk('crosshatch');
    k.onTap();
    step(k, w, 0.5);
    expect(w.ghosts[0]!.stuns[0]).toBe(TUNING.heroes.penciller.ruler.longLead);
    circleTrace(k, w, 0, 4, 1.6);
    expect(w.ghosts[0]!.hits[0]).toBe(TUNING.heroes.penciller.crush.damage + 1);
    expect(k.mods.ignore).toBe('eraser');
    expect(k.mods.dashIFrames).toBe(TUNING.heroes.penciller.eraseStep.iFrames);
  });

  it('remote puppet replays a hero:action (world effects only on the authority)', () => {
    const shared = [new Ghost(1, 0, 6)];
    const a = world(0, undefined, shared);
    const b = world(1, undefined, shared);
    const local = new PencillerKit();
    local.attach(a.host);
    const remote = new PencillerKit();
    remote.remote = true;
    remote.attach(b.host);
    local.onTap();
    const ev = a.actions.at(-1)!;
    expect(applyRemoteAction(new LettererKit(), ev)).toBe(false); // wrong hero
    expect(applyRemoteAction(remote, ev, true)).toBe(true);
    step(remote, b, 0.6);
    expect(shared[0]!.stuns.length).toBe(1); // only the authority applied it (local tick not run)
    expect(JSON.parse(JSON.stringify(ev))).toEqual(ev); // serializable
  });
});

// ───────────────────────────── Letterer ─────────────────────────────

describe('Letterer', () => {
  it('wordTier grows with on-beat chains, capped', () => {
    expect(wordTier(0, 0)).toBe(0);
    expect(wordTier(1, 0)).toBe(1);
    expect(wordTier(5, 0)).toBe(2);
    expect(wordTier(0, 1)).toBe(1);
  });

  it('on-beat throws grow POW → KAPOW → KA-BLAMM!; off-beat resets (unless Off-Beat)', () => {
    const w = world(0, undefined, [new Ghost(1, 0, 5)]);
    const k = new LettererKit();
    k.attach(w.host);
    const tiers: number[] = [];
    const throwAt = (beat: boolean) => {
      w.onBeat.v = beat;
      k.onTap();
      tiers.push(k.lastTier);
    };
    throwAt(false);
    throwAt(true);
    throwAt(true);
    throwAt(true);
    throwAt(false);
    expect(tiers).toEqual([0, 1, 2, 2, 0]);
    expect(k.longest).toBe(WORDS[2]);
    k.applyPerk('offBeat');
    throwAt(true);
    throwAt(false);
    expect(tiers.slice(-2)).toEqual([1, 1]);
  });

  it('a landing word reveals letter patches for 3 s and damages after the mask catches up', () => {
    const g = new Ghost(1, 0, 4, 10);
    const w = world(0, undefined, [g]);
    const k = new LettererKit();
    k.attach(w.host);
    w.onBeat.v = true;
    k.onTap(); // KAPOW
    step(k, w, 0.4);
    const patches = w.reveal.sources.filter((s) => s[3] === TUNING.heroes.letterer.letterLife);
    expect(patches.length).toBe(Math.round(WORDS[1].length / 3));
    expect(patches[0]![2]).toBe(TUNING.heroes.letterer.reveal[1]);
    g.inked = true; // the reveal mask caught up
    step(k, w, 0.2);
    expect(g.hits).toEqual([TUNING.heroes.letterer.damage[1]]);
  });

  it('balloon soaks hits while held, then SHHH! silences scribblers', () => {
    const s = new Ghost(1, 0, 2, 10, 'scribbler');
    const w = world(0, undefined, [s]);
    const k = new LettererKit();
    k.attach(w.host);
    k.onHoldStart();
    const B = TUNING.heroes.letterer.balloon;
    for (let i = 0; i < B.soak; i++) expect(k.onDamage()).toBe(true);
    expect(k.onDamage()).toBe(false);
    k.onRelease(1);
    expect(s.stuns).toEqual([B.silence]);
  });
});

// ───────────────────────────── Colorist ─────────────────────────────

describe('Colorist', () => {
  it('colour cycle and registration rule', () => {
    expect([0, 1, 2].map(nextColor)).toEqual([1, 2, 0]);
    expect(registered({ t: [0, 1, 2] }, 3, 5)).toBe(true);
    expect(registered({ t: [0, -1, 2] }, 3, 5)).toBe(false);
    expect(registered({ t: [0, -1, 2] }, 3, 5, 2)).toBe(true);
    expect(registered({ t: [0, 1, 2] }, 9, 5)).toBe(false);
  });

  it('teal → salmon → gold on one ghost = Full Registration burst', () => {
    const g = new Ghost(1, 0, 3, 20);
    g.inked = true;
    const w = world(0, undefined, [g]);
    const k = new ColoristKit();
    k.attach(w.host);
    const K = TUNING.heroes.colorist;
    for (let i = 0; i < 3; i++) {
      k.onTap();
      step(k, w, 0.3);
    }
    expect(k.color).toBe(0);
    expect(k.bursts).toBe(1);
    expect(g.stuns[0]).toBe(K.slow);
    expect(g.hits).toContain(K.registration.damage);
  });

  it('Fill Bucket: a flat persists 10 s (reveal source + flatAt), gold flats heal', () => {
    const w = world(0);
    const k = new ColoristKit();
    k.attach(w.host);
    k.color = 0; // last sprayed = gold
    k.onHoldStart();
    k.onHoldTick(TUNING.heroes.colorist.bucket.charge + 0.01);
    const B = TUNING.heroes.colorist.bucket;
    expect(w.reveal.sources.at(-1)![3]).toBe(B.life);
    expect(k.flatAt(0.5, 0.5)).toBe(2);
    step(k, w, TUNING.heroes.colorist.goldHealEvery + 0.1);
    expect(w.host.healed).toBe(1);
    step(k, w, B.life);
    expect(k.flatAt(0.5, 0.5)).toBe(-1);
  });

  it('solo halo is bigger than the co-op halo', () => {
    const w = world(0);
    const k = new ColoristKit();
    k.attach(w.host);
    expect(k.mods.radiusIdle).toBe(TUNING.heroes.colorist.soloHalo);
    (w.host as { playerCount: number }).playerCount = 2;
    k.update(DT);
    expect(k.mods.radiusIdle).toBe(TUNING.heroes.colorist.halo);
  });
});

// ───────────────────────────── Combos ─────────────────────────────

describe('pair combos', () => {
  const ev = (
    pid: 0 | 1,
    hero: GameEvents['hero:action']['hero'],
    action: GameEvents['hero:action']['action'],
    data: Record<string, number | number[] | string>,
  ) => ({
    pid,
    hero,
    action,
    data,
  });
  const square = [0, 0, 3, 0, 3, 3, 0, 3];

  it('INK THE PENCILS: crystal over a partner loop (and open line → bridge)', () => {
    const d = new ComboDetector();
    expect(
      d.ingest(ev(1, 'penciller', 'hold', { kind: 'loop', pts: square, cx: 1.5, cz: 1.5, area: 9 }), 0),
    ).toEqual([]);
    expect(d.ingest(ev(0, 'inker', 'hold', { x: 1, z: 1, r: 7 }), 0.5).map((h) => h.combo)).toEqual([
      'inkThePencils',
    ]);
    // same player's crystal + loop never combos
    const solo = new ComboDetector();
    solo.ingest(ev(0, 'penciller', 'hold', { kind: 'loop', pts: square, cx: 1.5, cz: 1.5, area: 9 }), 0);
    expect(solo.ingest(ev(0, 'inker', 'hold', { x: 1, z: 1, r: 7 }), 0.5)).toEqual([]);
    const b = new ComboDetector();
    b.ingest(ev(1, 'penciller', 'release', { kind: 'line', pts: [0, 0, 2, 0, 4, 0, 6, 0] }), 0);
    expect(b.ingest(ev(0, 'inker', 'hold', { x: 3, z: 0, r: 7 }), 0.2)[0]).toMatchObject({
      combo: 'inkThePencils',
      kind: 'bridge',
    });
  });

  it('SOUND & LIGHT: bolt through a flying word splits; word landing in the mask bursts', () => {
    const d = new ComboDetector();
    d.ingest(ev(1, 'letterer', 'tap', { from: [0, 0], to: [0, 10], beat: 0, tier: 0 }), 0);
    expect(d.ingest(ev(0, 'inker', 'tap', { from: [-5, 5], to: [5, 5] }), 0.1)[0]).toMatchObject({
      combo: 'soundAndLight',
      kind: 'split',
    });
    const m = new ComboDetector();
    m.ingest(ev(0, 'inker', 'hold', { x: 0, z: 10, r: 7 }), 0);
    expect(
      m.ingest(ev(1, 'letterer', 'tap', { from: [0, 0], to: [0, 10], beat: 0, tier: 0 }), 0.1)[0],
    ).toMatchObject({ combo: 'soundAndLight', kind: 'burst' });
  });

  it('OVERPRINT: flat ∩ mask doubles damage; a bucket on the 7 m mask freezes', () => {
    const d = new ComboDetector();
    d.ingest(ev(0, 'inker', 'hold', { x: 0, z: 0, r: 7 }), 0);
    expect(d.ingest(ev(1, 'colorist', 'hold', { x: 2, z: 0, r: 3, col: 0 }), 0.1)[0]).toMatchObject({
      combo: 'overprint',
      kind: 'freeze',
    });
    const s = new ComboDetector();
    s.ingest(ev(0, 'inker', 'hold', { x: 0, z: 0, r: 3 }), 0);
    expect(s.ingest(ev(1, 'colorist', 'hold', { x: 4, z: 0, r: 2, col: 1 }), 0.1)[0]).toMatchObject({
      combo: 'overprint',
      kind: 'double',
    });
  });

  it('SPEED LINES: a WHOOSH dash along a construction line grinds it', () => {
    const d = new ComboDetector();
    d.ingest(ev(1, 'penciller', 'tap', { from: [0, 0], to: [0, 10], tid: -1 }), 0);
    expect(d.ingest(ev(0, 'letterer', 'swipe', { from: [0.3, 1], dir: [0, 1] }), 0.2)[0]).toMatchObject({
      combo: 'speedLines',
    });
    expect(new ComboDetector().ingest(ev(0, 'letterer', 'swipe', { from: [0, 1], dir: [1, 0] }), 0)).toEqual(
      [],
    );
  });

  it('COLORING BOOK: spraying inside a partner loop fills it', () => {
    const d = new ComboDetector();
    d.ingest(ev(1, 'penciller', 'hold', { kind: 'loop', pts: square, cx: 1.5, cz: 1.5, area: 9 }), 0);
    expect(
      d.ingest(ev(0, 'colorist', 'tap', { col: 1, from: [5, 5], to: [1, 2], tid: 3 }), 0.3)[0],
    ).toMatchObject({ combo: 'coloringBook', col: 1 });
    expect(d.ingest(ev(0, 'colorist', 'tap', { col: 1, from: [5, 5], to: [8, 8], tid: 3 }), 5)).toEqual([]); // expired
  });

  it('CHROMATIC CHORUS: on-beat words through flats take colour; three colours = blast', () => {
    const d = new ComboDetector();
    d.ingest(ev(1, 'colorist', 'hold', { x: 0, z: 3, r: 1.5, col: 0 }), 0);
    d.ingest(ev(1, 'colorist', 'hold', { x: 3, z: 3, r: 1.5, col: 1 }), 0);
    d.ingest(ev(1, 'colorist', 'hold', { x: 6, z: 3, r: 1.5, col: 2 }), 0);
    const hit = (x: number) =>
      d.ingest(ev(0, 'letterer', 'tap', { from: [x, 0], to: [x, 6], beat: 1, tier: 1 }), 0.5);
    expect(hit(0)[0]).toMatchObject({ combo: 'chromaticChorus', kind: 'color', col: 0 });
    expect(hit(3)[0]).toMatchObject({ kind: 'color', col: 1 });
    expect(hit(6)[0]).toMatchObject({ combo: 'chromaticChorus', kind: 'blast' });
    // off-beat words don't take colour
    expect(d.ingest(ev(0, 'letterer', 'tap', { from: [0, 0], to: [0, 6], beat: 0, tier: 0 }), 0.6)).toEqual(
      [],
    );
  });

  it('two live kits on one bus: Penciller loop + Inker crystal → hero:combo', () => {
    const events = new EventBus<GameEvents>();
    const ghosts: Ghost[] = [];
    const a = world(0, events, ghosts);
    const b = world(1, events, ghosts);
    let clock = 0;
    const combos: GameEvents['hero:combo'][] = [];
    events.on('hero:combo', (e) => combos.push(e));
    installCombos(events, () => clock);
    const pen = new PencillerKit();
    pen.attach(b.host);
    const ink = new InkerKit();
    ink.attach(a.host);
    circleTrace(pen, b, 0, 4, 1.6);
    clock = 0.5;
    a.host.crystalPos.set(0, 2, 4);
    (a.reveal as { radius: number }).radius = 7;
    ink.onHoldStart();
    ink.onHoldTick(DT);
    expect(combos.map((c) => c.combo)).toContain('inkThePencils');
    expect(combos[0]!.position[2]).toBeCloseTo(4, 0);
  });
});
