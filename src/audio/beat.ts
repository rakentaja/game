/**
 * Beat clock: pure grid math (unit-tested in tests/unit/audio-beat.test.ts) plus `BeatClock`, the
 * `BeatAPI` implementation that reads the music scheduler's step grid.
 *
 * Two time domains matter:
 *  - **context time** (`ac.currentTime`): when the scheduler *starts* a note. SFX that should sit
 *    on the music grid are scheduled in this domain (`quantizeDelay`).
 *  - **audible time**: the context time of the sample leaving the speaker right now. It lags
 *    context time by the output latency (Bluetooth: 150–250 ms). Gameplay judging "was that tap on
 *    the beat?" must use this domain, plus a user calibration offset.
 */
import type { BeatAPI } from '../core/types';

/** Grid source: the current track's step-0 time and 16th length (context seconds). */
export interface StepGrid {
  /** Context time of step 0 (NaN when no track runs). */
  readonly anchor: number;
  /** Seconds per 16th (0 when no track runs). */
  readonly sec16: number;
  readonly bpm: number;
}

/** Minimal clock surface (AudioContext + getOutputTimestamp), injectable for tests. */
export interface ClockSource {
  readonly currentTime: number;
  readonly state: string;
  readonly baseLatency?: number;
  readonly outputLatency?: number;
  getOutputTimestamp?(): { contextTime?: number; performanceTime?: number };
}

/**
 * Context time audible at performance time `perfNow`.
 * Prefers getOutputTimestamp() (exact presentation pairing), else currentTime − outputLatency
 * (− baseLatency when outputLatency is unknown, e.g. Safari < 17). `userOffsetMs` > 0 means the
 * player hears sound later than reported (extra latency), so audible time moves back.
 */
export function audibleTime(
  currentTime: number,
  outputLatency: number | undefined,
  baseLatency: number | undefined,
  ts: { contextTime?: number; performanceTime?: number } | null,
  perfNow: number,
  userOffsetMs: number,
): number {
  let t: number;
  const ct = ts?.contextTime;
  const pt = ts?.performanceTime;
  if (ct !== undefined && pt !== undefined && pt > 0 && ct > 0) {
    // The stamp pairs "this context time is at the speaker" with a performance.now() value.
    // Extrapolate to now; clamp so a stale stamp never runs ahead of the render clock.
    t = Math.min(currentTime, ct + Math.max(0, perfNow - pt) / 1000);
  } else {
    const lat = outputLatency && outputLatency > 0 ? outputLatency : (baseLatency ?? 0);
    t = currentTime - lat;
  }
  return t - userOffsetMs / 1000;
}

/** Positive modulo. */
export function pmod(a: number, n: number): number {
  const r = a % n;
  return r < 0 ? r + n : r;
}

/** Signed seconds from `t` to the nearest grid line of spacing `div` anchored at `anchor` (negative = just passed). */
export function nearestOffset(t: number, anchor: number, div: number): number {
  if (!(div > 0) || !Number.isFinite(anchor)) return 0;
  const d = pmod(t - anchor, div);
  return d <= div / 2 ? -d : div - d;
}

/** Seconds from `t` to the next grid line strictly after `t − eps` (0 when exactly on one). */
export function untilNext(t: number, anchor: number, div: number, eps = 1e-6): number {
  if (!(div > 0) || !Number.isFinite(anchor)) return 0;
  const d = pmod(t - anchor, div);
  return d < eps ? 0 : div - d;
}

/** 0..1 phase of `t` inside a period of `div`. */
export function phaseAt(t: number, anchor: number, div: number): number {
  if (!(div > 0) || !Number.isFinite(anchor)) return 0;
  return pmod(t - anchor, div) / div;
}

/**
 * Quantize decision for SFX: seconds to wait so the sound lands on the next grid line, or 0
 * ("play now") when that line is further than `maxS` away or there is no grid.
 */
export function quantizeDelay(now: number, anchor: number, div: number, maxS: number): number {
  const w = untilNext(now, anchor, div);
  return w <= maxS ? w : 0;
}

/**
 * Context time to schedule a downbeat-landing sound: the next bar line if it is within `maxS`,
 * otherwise the next beat (so feedback never waits most of a slow bar).
 */
export function downbeatDelay(now: number, anchor: number, sec16: number, maxS: number): number {
  if (!(sec16 > 0)) return 0;
  const bar = untilNext(now, anchor, sec16 * 16);
  return bar <= maxS ? bar : untilNext(now, anchor, sec16 * 4);
}

export class BeatClock implements BeatAPI {
  /** Calibration (ms): positive when the player's speakers lag more than the browser reports. */
  latencyOffsetMs = 0;

  constructor(
    private readonly src: ClockSource,
    private readonly grid: StepGrid,
    private readonly defaultWindowMs: number,
  ) {}

  get bpm(): number {
    return this.running ? this.grid.bpm : 0;
  }

  get running(): boolean {
    return this.src.state === 'running' && this.grid.sec16 > 0 && Number.isFinite(this.grid.anchor);
  }

  /** Context time the player hears right now. */
  audibleNow(): number {
    const s = this.src;
    let ts: { contextTime?: number; performanceTime?: number } | null = null;
    if (typeof s.getOutputTimestamp === 'function') {
      try {
        ts = s.getOutputTimestamp();
      } catch {
        ts = null;
      }
    }
    const perf = typeof performance !== 'undefined' ? performance.now() : 0;
    return audibleTime(s.currentTime, s.outputLatency, s.baseLatency, ts, perf, this.latencyOffsetMs);
  }

  /** ms from "now as heard" until context time `t` is heard (for event timers). */
  msUntilAudible(t: number): number {
    return (t - this.audibleNow()) * 1000;
  }

  offsetMs(): number {
    if (!this.running) return 0;
    return nearestOffset(this.audibleNow(), this.grid.anchor, this.grid.sec16 * 2) * 1000;
  }

  onBeat(windowMs = this.defaultWindowMs): boolean {
    if (!this.running) return false;
    return Math.abs(this.offsetMs()) <= windowMs;
  }

  phase(): number {
    if (!this.running) return 0;
    return phaseAt(this.audibleNow(), this.grid.anchor, this.grid.sec16 * 4);
  }
}
