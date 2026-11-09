/**
 * Lobby/session wire protocol (message ids 0..31). Gameplay messages (wave 2) register on
 * `NET_REGISTRY` with ids ≥ 32.
 */
import { MessageRegistry } from './codec';

export const PROTOCOL_VERSION = 1;

export type HeroId = 'inker' | 'penciller' | 'letterer' | 'colorist';
export const HEROES: readonly HeroId[] = ['inker', 'penciller', 'letterer', 'colorist'];
/** Heroes selectable right now (the rest are "coming in this issue"). */
export const PLAYABLE_HEROES: readonly HeroId[] = ['inker'];

export interface PlayerInfo {
  /** 0 = host, 1 = guest */
  slot: 0 | 1;
  peer: string;
  hero: HeroId;
  ready: boolean;
  connected: boolean;
}

export interface HelloMsg {
  v: number;
  token: string;
}
export interface WelcomeMsg {
  slot: 1;
  players: PlayerInfo[];
}
export interface RosterMsg {
  players: PlayerInfo[];
}
export interface PickMsg {
  hero: HeroId;
}
export interface ReadyMsg {
  ready: boolean;
}
export interface StartMsg {
  seed: number;
  /** Host clock time (ms) at which both sides should begin. */
  at: number;
  players: PlayerInfo[];
}
export interface RejectMsg {
  reason: 'full' | 'version';
}
export interface PingMsg {
  t0: number;
}
export interface PongMsg {
  t0: number;
  t1: number;
  t2: number;
}

export const NET_REGISTRY = new MessageRegistry();
export const MSG = {
  hello: NET_REGISTRY.defineJson<HelloMsg>(1, 'hello'),
  welcome: NET_REGISTRY.defineJson<WelcomeMsg>(2, 'welcome'),
  roster: NET_REGISTRY.defineJson<RosterMsg>(3, 'roster'),
  pick: NET_REGISTRY.defineJson<PickMsg>(4, 'pick'),
  ready: NET_REGISTRY.defineJson<ReadyMsg>(5, 'ready'),
  start: NET_REGISTRY.defineJson<StartMsg>(6, 'start'),
  reject: NET_REGISTRY.defineJson<RejectMsg>(7, 'reject'),
  bye: NET_REGISTRY.defineJson<Record<string, never>>(8, 'bye'),
  ping: NET_REGISTRY.define<PingMsg>(
    9,
    'ping',
    (w, m) => w.f64(m.t0),
    (r) => ({ t0: r.f64() }),
  ),
  pong: NET_REGISTRY.define<PongMsg>(
    10,
    'pong',
    (w, m) => w.f64(m.t0).f64(m.t1).f64(m.t2),
    (r) => ({ t0: r.f64(), t1: r.f64(), t2: r.f64() }),
  ),
} as const;

/** First id free for gameplay messages. */
export const FIRST_GAME_MESSAGE_ID = 32;
