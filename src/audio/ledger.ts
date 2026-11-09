/**
 * Idea Ledger (wave 1) audio behaviours, installed by install() when the AudioAPI is the real
 * AudioEngine. Everything here hangs off the music scheduler's step hook (one call per 16th,
 * ~6–10 per second) or off game events — nothing runs per animation frame.
 *
 *  - beat clock events ('audio:beat', fired at the *audible* time of each beat)
 *  - Unprinted Mix (reveal:progress / crystal-hold proxy → 1940s radio … full fidelity)
 *  - sound only in the light (per-voice lowpass from distance to the crystal)
 *  - freeze-frame onomatopoeia on fx:panelCut
 *  - Shepard riser while printing
 *  - Ape Out drummer (player actions quantized into the combat percussion)
 *  - newsprint-noir room tones + muted-trumpet leitmotif after 8 s idle
 *  - the Editor erasing stems, leitmotif pickups (phase 2), blank-page heartbeat (phase 3)
 *  - fourth-wall red-pen scratch through the pause menu, reversed "rewind" bar on respawn
 *  - beat-locked haptics
 */
import { haptics } from '../core/input/haptics';
import type { GameContext, PageId } from '../core/types';
import { TUNING } from '../data/tuning';
import type { AudioEngine } from './AudioEngine';
import { downbeatDelay, untilNext } from './beat';
import { type BedId, makeBed } from './beds';
import {
  DRUM_KIT,
  drumDensity,
  HitRing,
  MOTIF_MIDI,
  MOTIF_STEPS,
  revealProxy,
  shepardVoice,
  stemLayer,
} from './fxmath';
import { LAYERS, type LayerName, type StepCtx } from './music/tracks';

const A = () => TUNING.audio;

/** Stems the fallback (no boss:eraseStem producer) erases on phase-1 drag strikes, in order. */
const FALLBACK_ERASE: readonly LayerName[] = ['ostinato', 'texture', 'melody', 'perc'];
const PAGE_BEDS: Record<string, readonly BedId[]> = { '1': ['rain'], '2': ['press'], '3': ['rain', 'press'] };

export function installLedger(ctx: GameContext, engine: AudioEngine): () => void {
  const ev = ctx.events;
  const ac = engine.ac;
  const music = engine.music;
  const inst = music.inst;
  const offs: (() => void)[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const h = setTimeout(() => {
      timers.delete(h);
      fn();
    }, ms);
    timers.add(h);
    return h;
  };

  let state = 'boot';
  let paused = false;
  let bossPhase = 0;
  const inBoss = () => state === 'boss' || music.track === 'boss';

  // ───────────────────────────── beat clock
  ctx.beat = engine.beat;
  const readOffset = () => {
    const s = ctx.settings as unknown as { audioOffsetMs?: number };
    engine.beat.latencyOffsetMs =
      typeof s.audioOffsetMs === 'number' ? s.audioOffsetMs : (ctx.tuning?.audio?.latencyOffsetMs ?? 0);
  };
  readOffset();
  offs.push(
    ev.on('settings:changed', (p) => {
      if (p.key === 'audioOffsetMs' || p.key === 'all' || p.key === '*') readOffset();
    }),
  );
  // FIFO of beats waiting for their audible moment: one timer per beat, no per-frame polling.
  const BQ = 8;
  const qBeat = new Float64Array(BQ);
  const qBar = new Float64Array(BQ);
  const qBpm = new Float64Array(BQ);
  let qHead = 0;
  let qLen = 0;
  const beatPayload = { beat: 0, bar: 0, bpm: 0 };
  const fireBeat = () => {
    if (qLen === 0) return;
    beatPayload.beat = qBeat[qHead]!;
    beatPayload.bar = qBar[qHead]!;
    beatPayload.bpm = qBpm[qHead]!;
    qHead = (qHead + 1) % BQ;
    qLen--;
    ev.emit('audio:beat', beatPayload);
  };
  const queueBeat = (c: StepCtx) => {
    if (qLen === BQ) return;
    const i = (qHead + qLen) % BQ;
    qBeat[i] = c.step >> 2;
    qBar[i] = Math.floor(c.step / 16);
    qBpm[i] = music.bpm;
    qLen++;
    later(fireBeat, Math.max(0, engine.beat.msUntilAudible(c.t)));
  };

  // ───────────────────────────── sound only in the light
  if (ctx.reveal?.center) engine.setLight(ctx.reveal);

  // ───────────────────────────── Unprinted Mix
  let revealBase = 1; // title: full fidelity
  let gotProgress = false;
  let crystalHeld = false;
  let heldSince = 0;
  let heldS = 0;
  let crystalTimer: ReturnType<typeof setInterval> | null = null;
  const applyReveal = () => {
    const U = A().unprinted;
    let base = revealBase;
    if (!gotProgress && revealBase < 1) {
      const live = crystalHeld ? (performance.now() - heldSince) / 1000 : 0;
      base = revealBase + (1 - revealBase) * revealProxy(heldS + live, U.proxyTauS);
    }
    engine.setReveal(Math.min(1, base + (crystalHeld ? U.crystalBurst : 0)), crystalHeld ? 0.15 : 0.6);
  };
  offs.push(
    ev.on('reveal:progress', (p) => {
      gotProgress = true;
      revealBase = p.t;
      applyReveal();
    }),
    ev.on('crystal:hold', (p) => {
      if (p.held === crystalHeld) return;
      crystalHeld = p.held;
      const now = performance.now();
      if (p.held) {
        heldSince = now;
        if (!crystalTimer) crystalTimer = setInterval(applyReveal, 500);
      } else {
        heldS += (now - heldSince) / 1000;
        if (crystalTimer) clearInterval(crystalTimer);
        crystalTimer = null;
      }
      applyReveal();
    }),
    ev.on('page:complete', () => {
      gotProgress = true;
      revealBase = 1;
      applyReveal();
    }),
    () => {
      if (crystalTimer) clearInterval(crystalTimer);
    },
  );

  // ───────────────────────────── freeze-frame onomatopoeia
  const letters = ac.createGain();
  letters.gain.value = 0.55;
  letters.connect(engine.sfxIn);
  offs.push(
    ev.on('fx:panelCut', (p) => {
      if (ac.state !== 'running') return;
      const hold = ctx.tuning?.panelCut?.duration ?? 0.6;
      const s16 = music.sec16 || 0.125;
      engine.freeze(hold, s16 * 2);
      // one pen transient per letter of the word, on 32nds from the beat clock
      const n = Math.max(3, Math.min(8, p.word.replace(/[^a-z]/gi, '').length || 4));
      const s32 = s16 / 2;
      const t0 = ac.currentTime + 0.01 + engine.untilGrid(32);
      for (let i = 0; i < n; i++) {
        const t = t0 + i * s32;
        const last = i === n - 1;
        inst.hit(letters, last ? 'snare' : 'stick', t, last ? 0.5 : 0.32, 1 + i * 0.07, ((i % 3) - 1) * 0.4);
        if (i % 2 === 0) inst.hit(letters, 'pencil', t, 0.25, 1.1 + i * 0.05);
      }
    }),
  );

  // ───────────────────────────── printing riser (Shepard tone)
  const R = A().riser;
  const riserOut = ac.createGain();
  riserOut.gain.value = 0;
  const riserLP = ac.createBiquadFilter();
  riserLP.type = 'lowpass';
  riserLP.frequency.value = 2400;
  riserOut.connect(riserLP);
  riserLP.connect(engine.sfxIn);
  const fa: [number, number] = [0, 0];
  let riserOsc: OscillatorNode[] = [];
  let riserGain: GainNode[] = [];
  let riserP = 0;
  let riserLast = 0;
  let riserTimer: ReturnType<typeof setInterval> | null = null;
  const riserSet = (immediate: boolean) => {
    const now = ac.currentTime;
    for (let i = 0; i < riserOsc.length; i++) {
      shepardVoice(riserP, i, riserOsc.length, R.fMin, R.span, R.climb, fa);
      const f = riserOsc[i]!.frequency;
      // wrap jumps happen at zero amplitude, so they can be instant
      if (immediate || fa[0] < f.value * 0.75) f.setValueAtTime(fa[0], now);
      else f.setTargetAtTime(fa[0], now, 0.05);
      riserGain[i]!.gain.setTargetAtTime(fa[1], now, immediate ? 0.005 : 0.05);
    }
  };
  const riserStop = (at = ac.currentTime) => {
    if (riserTimer) clearInterval(riserTimer);
    riserTimer = null;
    if (!riserOsc.length) return;
    riserOut.gain.cancelScheduledValues(at);
    riserOut.gain.setTargetAtTime(0, at, 0.05);
    for (const o of riserOsc) o.stop(at + 0.4);
    const gs = riserGain;
    later(
      () => {
        for (const g of gs) g.disconnect();
      },
      (at - ac.currentTime) * 1000 + 600,
    );
    riserOsc = [];
    riserGain = [];
  };
  const riserStart = () => {
    if (riserOsc.length || ac.state !== 'running') return;
    const now = ac.currentTime;
    for (let i = 0; i < R.voices; i++) {
      const o = ac.createOscillator();
      o.type = 'sine';
      const g = ac.createGain();
      g.gain.value = 0;
      o.connect(g);
      g.connect(riserOut);
      o.start(now);
      riserOsc.push(o);
      riserGain.push(g);
    }
    riserSet(true);
    riserOut.gain.cancelScheduledValues(now);
    riserOut.gain.setTargetAtTime(R.gain, now, 0.2);
    riserTimer = setInterval(() => {
      if (performance.now() - riserLast > 260) riserStop();
      else riserSet(false);
    }, 60);
  };
  const progressT = new Map<string, number>();
  offs.push(
    ev.on('sketch:progress', (p) => {
      if (p.id.startsWith('editor:')) return;
      const prev = progressT.get(p.id) ?? 0;
      progressT.set(p.id, p.t);
      if (p.t <= prev) return;
      riserP = p.t;
      riserLast = performance.now();
      riserStart();
    }),
    ev.on('sketch:printed', (p) => {
      progressT.delete(p.id);
      if (p.id.startsWith('editor:')) return;
      // climb right up to the downbeat where sketch_done lands, then cut
      riserStop(ac.currentTime + downbeatWait(engine));
    }),
    () => riserStop(),
  );

  // ───────────────────────────── Ape Out drummer
  const ring = new HitRing(32);
  let curLayers: Record<LayerName, GainNode> | null = null;
  let drumT = 0;
  const playDrum = (piece: number, vel: number, off16: number, rate: number) => {
    const dest = curLayers?.perc ?? music.layers?.perc;
    if (!dest) return;
    const t = drumT + off16 * music.sec16;
    if (t < ac.currentTime) return; // a grace note that is already late: skip it
    inst.hit(dest, DRUM_KIT[piece]!, t, vel, rate, off16 < 0 ? -0.2 : 0.15);
  };
  const heat = () =>
    inBoss() ? Math.max(music.intensity.boss, music.intensity.combat) : music.intensity.combat;
  /** Queue a hit on the next `div` grid line: play directly if that line is already scheduled. */
  const drum = (piece: number, vel: number, div: number, off16 = 0, rate = 1) => {
    if (!(music.sec16 > 0) || ac.state !== 'running') return;
    const now = ac.currentTime;
    const t = now + 0.004 + untilNext(now + 0.004, music.anchor, music.sec16 * div);
    if (t < music.horizon) {
      drumT = t;
      curLayers = music.layers;
      playDrum(piece, vel, off16, rate);
    } else ring.push(piece, vel, div, off16, rate);
  };
  const SNARE = DRUM_KIT.indexOf('snare');
  const STICK = DRUM_KIT.indexOf('stick');
  const CRASH = DRUM_KIT.indexOf('crash');
  const FRAME = DRUM_KIT.indexOf('frame');
  const TAIKO = DRUM_KIT.indexOf('taikoHi');
  offs.push(
    ev.on('player:dash', () => {
      const m = drumDensity(heat(), A().drummer.minHeat);
      if (!m) return;
      if (m & 2) {
        // drag: two ghost strokes a 32nd apart before the main stroke
        drum(SNARE, 0.16, 1, -0.5, 1.08);
        drum(SNARE, 0.2, 1, -0.25, 1.04);
      }
      drum(SNARE, 0.42, 1);
    }),
    ev.on('bolt:hit', (p) => {
      const m = drumDensity(heat(), A().drummer.minHeat);
      if (!m) return;
      drum(STICK, p.critical ? 0.6 : 0.42, 1, 0, 1.15);
      if (m & 2) drum(SNARE, 0.18, 1, 0, 1.2);
    }),
    ev.on('enemy:died', () => {
      const m = drumDensity(heat(), A().drummer.minHeat);
      if (m) drum(CRASH, 0.4, 2);
      if (m & 4) {
        drum(TAIKO, 0.3, 2, 1);
        drum(FRAME, 0.25, 2, 1.5);
      }
    }),
    ev.on('page:start', () => ring.clear()),
  );

  // ───────────────────────────── newsprint-noir bed + idle leitmotif
  const bedGain = ac.createGain();
  bedGain.gain.value = 0;
  bedGain.connect(engine.musicPost);
  const bedBufs = new Map<BedId, AudioBuffer>();
  let bedSrcs: AudioBufferSourceNode[] = [];
  const stopBeds = () => {
    const now = ac.currentTime;
    bedGain.gain.cancelScheduledValues(now);
    bedGain.gain.setTargetAtTime(0, now, 0.6);
    for (const s of bedSrcs) s.stop(now + 3);
    bedSrcs = [];
  };
  const startBeds = (page: PageId) => {
    stopBeds();
    const ids = PAGE_BEDS[String(page)];
    if (!ids) return;
    const now = ac.currentTime;
    for (const id of ids) {
      let b = bedBufs.get(id);
      if (!b) {
        b = makeBed(ac, id, id === 'rain' ? 0x7a1 : 0x9e55);
        bedBufs.set(id, b);
      }
      const s = ac.createBufferSource();
      s.buffer = b;
      s.loop = true;
      s.connect(bedGain);
      s.start(now + 0.05, Math.random() * b.duration);
      bedSrcs.push(s);
    }
    bedGain.gain.cancelScheduledValues(now);
    bedGain.gain.setTargetAtTime(A().noir.bed / Math.sqrt(ids.length), now + 0.5, 1.5);
  };
  let lastActive = performance.now();
  let quoted = false;
  const lastPos = { x: Number.NaN, z: 0 };
  const active = () => {
    lastActive = performance.now();
    quoted = false;
  };
  const playQuote = () => {
    if (!(music.sec16 > 0)) return;
    const s16 = music.sec16;
    const t0 = ac.currentTime + 0.02 + engine.untilGrid(1); // next bar line
    for (let i = 0; i < MOTIF_MIDI.length; i++) {
      const st = MOTIF_STEPS[i]!;
      const next = MOTIF_STEPS[i + 1] ?? st + 8;
      inst.mutedTrumpet(engine.musicIn, t0 + st * s16, MOTIF_MIDI[i]!, (next - st) * s16 * 0.9, 0.1);
    }
  };
  const idleTimer = setInterval(() => {
    const p = ctx.player?.position;
    if (p) {
      if (Number.isNaN(lastPos.x) || Math.abs(p.x - lastPos.x) + Math.abs(p.z - lastPos.z) > 0.25) active();
      lastPos.x = p.x;
      lastPos.z = p.z;
    }
    if (paused || quoted || music.track !== 'explore' || ac.state !== 'running') return;
    if (performance.now() - lastActive > A().noir.idleS * 1000) {
      quoted = true;
      playQuote();
    }
  }, 1000);
  offs.push(
    () => clearInterval(idleTimer),
    ev.on('player:dash', active),
    ev.on('bolt:fire', active),
    ev.on('crystal:hold', active),
    ev.on('ink:collected', active),
    ev.on('player:damaged', active),
    ev.on('page:start', (p) => {
      active();
      // the boss arena starts half-inked: the Editor's score should not sound like a wireless set
      revealBase = p.page === 'boss' ? 0.6 : 0;
      gotProgress = false;
      heldS = 0;
      applyReveal();
      startBeds(p.page);
    }),
  );

  // ───────────────────────────── the Editor erases the soundtrack
  let gotErase = false;
  let fallbackIdx = 0;
  let blank = false;
  const erase = (l: LayerName, erased: boolean, side: number) =>
    music.setLayerMod(l, erased ? 0 : 1, erased ? side : 0, erased ? 0.9 : 0.6);
  const bossReset = () => {
    blank = false;
    fallbackIdx = 0;
    engine.pickup.mode = 'penta';
    music.resetLayerMods();
  };
  offs.push(
    ev.on('boss:eraseStem', (p) => {
      gotErase = true;
      const l = stemLayer(p.stem);
      if (l) erase(l, p.erased, p.stem % 2 ? 0.85 : -0.85);
    }),
    ev.on('boss:attack', (p) => {
      if (gotErase || bossPhase > 1 || p.kind !== 'drag' || p.stage !== 'strike') return;
      const l = FALLBACK_ERASE[fallbackIdx];
      if (!l) return;
      erase(l, true, fallbackIdx % 2 ? 0.85 : -0.85);
      fallbackIdx++;
    }),
    ev.on('boss:phase', (p) => {
      bossPhase = p.phase;
      engine.pickup.mode = p.phase === 2 ? 'motif' : 'penta';
      engine.pickup.reset();
      if (p.phase === 2 && !gotErase) {
        for (const l of FALLBACK_ERASE) erase(l, false, 0);
        fallbackIdx = FALLBACK_ERASE.length; // the fallback only erases in phase 1
      }
      if (p.phase === 3) {
        // the blank page: near-silence, only a sub heartbeat on the downbeats
        blank = true;
        for (const l of LAYERS) music.setLayerMod(l, l === 'drone' ? 0.25 : 0.04, 0, 1.2);
      } else if (blank) {
        blank = false;
        music.resetLayerMods();
      }
    }),
    ev.on('boss:defeated', bossReset),
    ev.on('page:start', () => {
      bossPhase = 0;
      gotErase = false;
      bossReset();
    }),
  );
  const heart = ac.createGain();
  heart.gain.value = 1;
  heart.connect(engine.musicPost);
  if (music.exciter) heart.connect(music.exciter);
  const H = () => A().haptics;
  const heartbeat = (t: number) => {
    inst.bass(heart, t, 26, 0.16, 0.5);
    inst.bass(heart, t + 0.27, 26, 0.12, 0.32);
    later(() => haptics.heartbeat(H().heart), Math.max(0, engine.beat.msUntilAudible(t)));
  };

  // ───────────────────────────── fourth-wall leak + rewind
  const L = A().leak;
  const leak = ac.createGain();
  leak.gain.value = L.scratchGain;
  const leakBP = ac.createBiquadFilter();
  leakBP.type = 'bandpass';
  leakBP.frequency.value = 2800;
  leakBP.Q.value = 0.9;
  leak.connect(leakBP);
  leakBP.connect(engine.bypass);
  let leakTimer: ReturnType<typeof setTimeout> | null = null;
  const scratch = () => {
    leakTimer = null;
    if (!inBoss() || state === 'title' || state === 'cover') return;
    if (ac.state === 'running') {
      const t = ac.currentTime + 0.02;
      const rnd = inst.rand();
      inst.hit(leak, rnd < 0.4 ? 'hatch' : 'pencil', t, 0.9, 0.85 + 0.3 * inst.rand(), rnd * 1.6 - 0.8);
    }
    leakTimer = later(scratch, (L.minGapS + (L.maxGapS - L.minGapS) * inst.rand()) * 1000);
  };
  const leakOn = () => {
    if (!leakTimer) leakTimer = later(scratch, L.minGapS * 1000);
  };
  offs.push(
    ev.on('game:pause', (p) => {
      paused = p.paused;
      // the Editor keeps scratching while everything else is muffled — a bit louder, even
      leak.gain.setTargetAtTime(L.scratchGain * (p.paused ? 1.8 : 1), ac.currentTime, 0.2);
      if (p.paused && inBoss()) leakOn();
      if (!p.paused) active();
    }),
    ev.on('player:respawn', () => {
      if (ac.state !== 'running') return;
      // "rewind": one bar of the kit played backwards, accelerating, ending on a reversed boom
      const s16 = music.sec16 || 0.14;
      const bar = s16 * 16;
      const t0 = ac.currentTime + 0.03;
      engine.duckMusic(9, bar);
      let t = t0;
      for (let i = 0; i < 16; i++) {
        const u = i / 15;
        inst.hitReversed(engine.sfxIn, i % 4 === 0 ? 'taikoLow' : 'frame', t, 0.35 + 0.2 * u, 0.9 + 0.8 * u);
        t += s16 * (1.25 - 0.6 * u);
      }
      inst.hitReversed(engine.sfxIn, 'boom', t0 + bar, 0.5, 1.6, true);
      inst.hitReversed(engine.sfxIn, 'crash', t0 + bar, 0.3, 1, true);
    }),
  );

  // ───────────────────────────── haptics
  if (!haptics.settings) haptics.settings = ctx.settings;
  offs.push(
    ev.on('combat:onBeat', () => haptics.beatTick(H().beat, H().minGapMs)),
    ev.on('enemy:died', () => haptics.killPattern(H().kill, H().minGapMs)),
  );

  // ───────────────────────────── state
  offs.push(
    ev.on('state:change', (p) => {
      state = p.to;
      if (p.to === 'title' || p.to === 'cover' || p.to === 'credits') {
        revealBase = 1;
        gotProgress = true;
        applyReveal();
        stopBeds();
        bossReset();
      }
      if (p.to === 'boss') {
        stopBeds();
        leakOn();
      }
    }),
  );

  // ───────────────────────────── step hook (one call per scheduled 16th)
  music.onStep = (c, layers) => {
    if (c.s16 % 4 === 0) queueBeat(c);
    if (ring.size) {
      drumT = c.t;
      curLayers = layers;
      ring.drain(c.step, playDrum);
    }
    if (blank && (c.s16 === 0 || (c.s16 === 8 && c.bar % 2 === 1))) heartbeat(c.t);
  };

  return () => {
    music.onStep = null;
    for (const o of offs) o();
    for (const h of timers) clearTimeout(h);
    timers.clear();
    stopBeds();
    if (ctx.beat === engine.beat) ctx.beat = null;
  };
}

/** Seconds until sketch_done should land: next bar line if close (≤ downbeatMaxS), else next beat. */
export function downbeatWait(engine: AudioEngine): number {
  const m = engine.music;
  if (!(m.sec16 > 0)) return 0;
  return downbeatDelay(engine.ac.currentTime, m.anchor, m.sec16, A().downbeatMaxS);
}
