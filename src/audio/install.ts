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
import { AudioEngine } from './AudioEngine';
import type { TrackName } from './music/tracks';

export interface InstallOptions {
  /** Pick the music track from `state:change` (title/playing/boss/cover). Default true. */
  autoMusic?: boolean;
  /**
   * Derive combat intensity from enemy spawn/death events until someone emits an explicit
   * `music:intensity` for the combat layer (then the explicit driver wins). Default true.
   */
  autoCombat?: boolean;
  /** Unlock the context on the first gesture. Default true. */
  autoUnlock?: boolean;
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

export function install(ctx: GameContext, opts: InstallOptions = {}): () => void {
  const audio = ctx.audio;
  const ev = ctx.events;
  const engine = audio instanceof AudioEngine ? audio : null;
  const offs: (() => void)[] = [];
  const v = new Vector3();
  const playOpts: { position?: Vector3; volume?: number } = {};

  audio.setVolumes(ctx.settings);

  offs.push(
    ev.on('sfx:play', (p) => {
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

  let explicitCombat = false;
  offs.push(
    ev.on('music:intensity', (p) => {
      if (p.layer === 'combat') explicitCombat = true;
      audio.setIntensity(p.layer, p.level);
    }),
  );

  offs.push(
    ev.on('settings:changed', (p) => {
      if (p.key === 'master' || p.key === 'music' || p.key === 'sfx' || p.key === 'all' || p.key === '*') {
        audio.setVolumes(ctx.settings);
      }
    }),
  );

  offs.push(ev.on('boss:phase', (p) => audio.setIntensity('boss', BOSS_PHASE_LEVEL[p.phase - 1] ?? 1)));
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
    const alive = new Set<number>();
    const revealed = new Set<number>();
    const push = () => {
      if (explicitCombat) return;
      // revealed enemies count double: a fight you can see is louder than one you can't
      const n = alive.size + revealed.size;
      audio.setIntensity('combat', Math.min(1, n / 6));
    };
    offs.push(
      ev.on('enemy:spawn', (p) => {
        alive.add(p.id);
        push();
      }),
      ev.on('enemy:revealed', (p) => {
        if (alive.has(p.id)) revealed.add(p.id);
        push();
      }),
      ev.on('enemy:died', (p) => {
        alive.delete(p.id);
        revealed.delete(p.id);
        push();
      }),
      ev.on('page:start', () => {
        alive.clear();
        revealed.clear();
        push();
      }),
      ev.on('player:respawn', () => {
        alive.clear();
        revealed.clear();
        push();
      }),
    );
  }

  if (opts.autoUnlock !== false && typeof window !== 'undefined') {
    const unlock = () => {
      void audio.unlock();
      removeEventListener('pointerdown', unlock, true);
      removeEventListener('touchend', unlock, true);
      removeEventListener('keydown', unlock, true);
    };
    addEventListener('pointerdown', unlock, true);
    addEventListener('touchend', unlock, true);
    addEventListener('keydown', unlock, true);
    offs.push(() => {
      removeEventListener('pointerdown', unlock, true);
      removeEventListener('touchend', unlock, true);
      removeEventListener('keydown', unlock, true);
    });
  }

  return () => {
    for (const o of offs) o();
  };
}
