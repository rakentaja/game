/**
 * Event bridge: wires the AudioAPI in `ctx.audio` to the game's event bus.
 *
 * Integrator usage (main.ts):
 *   const audio = new AudioEngine();
 *   ctx.audio = audio;
 *   const disposeAudio = installAudio(ctx);
 */
import { Vector3 } from 'three';
import type { GameContext } from '../core/types';
import { ACTIVATION_EVENTS, AudioEngine } from './AudioEngine';
import type { TrackName } from './music/tracks';

export interface InstallOptions {
  /** Pick the music track from `state:change` (title/playing/boss/cover). Default true. */
  autoMusic?: boolean;
  /**
   * Derive combat intensity from enemy spawn/reveal/death. The music follows
   * max(level trigger `music:intensity` combat, enemy-derived level); both reset per page.
   */
  autoCombat?: boolean;
  /** Unlock the context on the first activating gesture. Default true. */
  autoUnlock?: boolean;
  /** Comic stinger on every `fx:panelCut` (rate-limited by the bank). Default true. */
  panelStinger?: boolean;
}

const STATE_TRACK: Record<string, TrackName | null | undefined> = {
  title: 'title',
  playing: 'explore',
  boss: 'boss',
  cover: 'cover',
  credits: 'cover',
  // pageTurn / boot keep whatever is playing
};

const BOSS_PHASE_LEVEL = [0.34, 0.67, 1] as const;
/** Highest boss intensity allowed per announced phase (index = phase; 0 = not started). */
const BOSS_PHASE_CAP = [0.49, 0.49, 0.83, 1] as const;

export function install(ctx: GameContext, opts: InstallOptions = {}): () => void {
  const audio = ctx.audio;
  const ev = ctx.events;
  const engine = audio instanceof AudioEngine ? audio : null;
  const offs: (() => void)[] = [];
  const v = new Vector3();
  const playOpts: { position?: Vector3; volume?: number } = {};

  audio.setVolumes(ctx.settings);

  // ── sketch printing: the gameplay asks for 'sketch_loop' once when printing starts; we turn
  // that into a real loop that runs exactly while some sketch's progress is rising.
  let sketchStop: (() => void) | null = null;
  let sketchVol = 0.6;
  let lastRise = 0;
  let sketchTimer: ReturnType<typeof setInterval> | null = null;
  const sketchT = new Map<string, number>();
  const stopSketch = () => {
    sketchStop?.();
    sketchStop = null;
    if (sketchTimer) clearInterval(sketchTimer);
    sketchTimer = null;
  };
  const startSketch = () => {
    lastRise = performance.now();
    if (sketchStop) return;
    sketchStop = audio.loop('sketch_loop', { volume: sketchVol });
    sketchTimer = setInterval(() => {
      if (performance.now() - lastRise > 220) stopSketch();
    }, 60);
  };
  offs.push(
    stopSketch,
    ev.on('sketch:progress', (p) => {
      if (p.id.startsWith('editor:')) return; // the Editor drives its own print loop
      const prev = sketchT.get(p.id) ?? 0;
      sketchT.set(p.id, p.t);
      if (p.t > prev) startSketch(); // also restarts after a pause mid-print
    }),
    ev.on('sketch:printed', (p) => {
      sketchT.delete(p.id);
      if (!p.id.startsWith('editor:')) stopSketch();
    }),
  );

  offs.push(
    ev.on('sfx:play', (p) => {
      if (p.id === 'sketch_loop' && !p.position) {
        sketchVol = p.volume ?? 0.6;
        startSketch();
        return;
      }
      if (engine) {
        const pos = p.position;
        engine.playAt(p.id, pos ? pos[0] : Number.NaN, pos ? pos[1] : 0, pos ? pos[2] : 0, p.volume ?? 1);
        return;
      }
      if (p.position) {
        v.fromArray(p.position);
        playOpts.position = v;
      } else playOpts.position = undefined;
      playOpts.volume = p.volume;
      audio.play(p.id, playOpts);
    }),
  );

  let bossPhaseNow = 1;
  // combat = max(level-designer trigger, enemies in play)
  let triggerCombat = 0;
  let enemyCombat = 0;
  const pushCombat = () => audio.setIntensity('combat', Math.max(triggerCombat, enemyCombat));
  offs.push(
    ev.on('music:intensity', (p) => {
      if (p.layer === 'combat' && opts.autoCombat !== false) {
        triggerCombat = p.level;
        pushCombat();
      } else if (p.layer === 'boss') {
        // Anyone may push boss intensity (arena triggers, the Editor), but it can never run
        // ahead of the phase the Editor has actually announced.
        audio.setIntensity('boss', Math.min(p.level, BOSS_PHASE_CAP[bossPhaseNow]!));
      } else audio.setIntensity(p.layer, p.level);
    }),
  );
  if (opts.panelStinger !== false) {
    offs.push(ev.on('fx:panelCut', () => audio.play('panel_stinger')));
  }

  offs.push(
    ev.on('settings:changed', (p) => {
      if (p.key === 'master' || p.key === 'music' || p.key === 'sfx' || p.key === 'all' || p.key === '*') {
        audio.setVolumes(ctx.settings);
      }
    }),
  );

  offs.push(
    ev.on('boss:phase', (p) => {
      bossPhaseNow = p.phase;
      audio.setIntensity('boss', BOSS_PHASE_LEVEL[p.phase - 1] ?? 1);
    }),
    ev.on('page:start', () => {
      bossPhaseNow = 1;
    }),
  );
  offs.push(ev.on('game:pause', (p) => engine?.setPaused(p.paused)));

  if (opts.autoMusic !== false) {
    offs.push(
      ev.on('state:change', (p) => {
        const t = STATE_TRACK[p.to];
        if (t !== undefined) audio.setMusic(t);
        if (p.to === 'boss') audio.setIntensity('boss', BOSS_PHASE_LEVEL[0]);
      }),
    );
  }

  if (opts.autoCombat !== false) {
    // "Heat": fight events add, time drains (τ ≈ 6 s). Walking away from enemies you never
    // engage lets the drums fade even though they are technically still alive.
    let heat = 0;
    let last = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      const now = performance.now();
      heat *= Math.exp(-(now - last) / 6000);
      last = now;
      const lvl = heat < 0.04 ? 0 : Math.min(1, heat);
      if (Math.abs(lvl - enemyCombat) > 0.02 || (lvl === 0 && enemyCombat !== 0)) {
        enemyCombat = lvl;
        pushCombat();
      }
      if (lvl === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const bump = (amount: number) => {
      tick();
      heat = Math.min(1.6, heat + amount);
      tick();
      if (!timer) timer = setInterval(tick, 250);
    };
    const reset = () => {
      heat = 0;
      triggerCombat = 0;
      tick();
    };
    offs.push(
      ev.on('enemy:revealed', (p) => bump(p.first ? 0.45 : 0.2)),
      ev.on('bolt:hit', () => bump(0.12)),
      ev.on('enemy:died', () => bump(0.08)),
      ev.on('player:damaged', () => bump(0.35)),
      ev.on('page:start', reset),
      ev.on('player:respawn', reset),
      ev.on('state:change', (p) => {
        if (p.to === 'title' || p.to === 'cover') reset();
      }),
      () => {
        if (timer) clearInterval(timer);
      },
    );
  }

  // The engine listens for activation gestures itself (and keeps retrying after iOS
  // interruptions); other AudioAPI implementations get a one-shot unlock here.
  if (!engine && opts.autoUnlock !== false && typeof window !== 'undefined') {
    const unlock = () => {
      void audio.unlock();
      for (const e of ACTIVATION_EVENTS) removeEventListener(e, unlock, true);
    };
    for (const e of ACTIVATION_EVENTS) addEventListener(e, unlock, true);
    offs.push(() => {
      for (const e of ACTIVATION_EVENTS) removeEventListener(e, unlock, true);
    });
  }

  return () => {
    for (const o of offs) o();
  };
}
