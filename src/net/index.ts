/**
 * Co-op networking entry point. Always reach this module through a dynamic import
 * (`await import('../net')`) so solo players never download any of it.
 *
 *   const net = await import('./net');
 *   const s = net.createRoom();               // host: s.code, net.inviteUrl(s.code)
 *   const s = net.joinRoom('ABC234');         // guest
 *   s.on('status', …); s.on('roster', …); s.on('start', …);
 *   await s.start();
 *
 * URL flags:
 *   ?room=CODE                 invite link (title screen opens the lobby in join mode)
 *   ?nettransport=loopback-bc  BroadcastChannel between same-origin tabs (offline e2e/dev)
 *   ?netsim=rtt150,jit40,loss3 wrap the transport in a LossyTransport
 */
import { BroadcastTransport } from './broadcast';
import { NET_CONFIG, type NetConfig } from './config';
import { LossyTransport, parseNetsim } from './lossy';
import { generateRoomCode, normalizeRoomCode } from './room';
import { NetSession, type Role } from './session';
import { TieredTransport } from './tiered';
import type { Transport } from './transport';

export * from './clock';
export * from './codec';
export { NET_CONFIG } from './config';
export * from './interp';
export { LoopbackTransport } from './loopback';
export { LossyTransport, parseNetsim } from './lossy';
export * from './protocol';
export * from './room';
export * from './session';
export * from './snapshot';
export type { NetTier, Transport } from './transport';

export interface NetFlags {
  transport: 'auto' | 'loopback-bc';
  netsim: string | null;
}

export function readNetFlags(
  search: string = typeof location !== 'undefined' ? location.search : '',
): NetFlags {
  const q = new URLSearchParams(search);
  return {
    transport: q.get('nettransport') === 'loopback-bc' ? 'loopback-bc' : 'auto',
    netsim: q.get('netsim'),
  };
}

/** Build the transport factory for a room according to flags + config. */
export function transportFactory(
  code: string,
  role: Role,
  flags: NetFlags = readNetFlags(),
  cfg: NetConfig = NET_CONFIG,
): () => Promise<Transport> {
  const sim = parseNetsim(flags.netsim);
  return async () => {
    let t: Transport;
    if (flags.transport === 'loopback-bc') {
      t = new BroadcastTransport(code);
    } else {
      t = await TieredTransport.create(
        cfg,
        {
          webrtc: async (strategy) => {
            const { TrysteroTransport } = await import('./trystero');
            return TrysteroTransport.create({ room: code, strategy, config: cfg });
          },
          relay: cfg.firebase
            ? async (selfId) => {
                const { FirebaseRelayTransport } = await import('./firebase');
                return FirebaseRelayTransport.create(
                  code,
                  selfId,
                  cfg.firebase!,
                  cfg.relayHz,
                  role === 'host',
                );
              }
            : null,
        },
        role === 'host',
      );
    }
    return sim ? new LossyTransport(t, sim) : t;
  };
}

let active: NetSession | null = null;

/** The session the lobby created (wave 2 gameplay picks it up after 'coop:start'). */
export function activeSession(): NetSession | null {
  return active;
}

function guestToken(): string | undefined {
  try {
    const k = 'inkwake.net.token';
    let v = sessionStorage.getItem(k);
    if (!v) {
      v = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      sessionStorage.setItem(k, v);
    }
    return v;
  } catch {
    return undefined;
  }
}

function make(role: Role, code: string, flags?: NetFlags): NetSession {
  active?.close();
  const s = new NetSession({
    role,
    code,
    connect: transportFactory(code, role, flags),
    rejoinWindowMs: NET_CONFIG.rejoinWindowS * 1000,
    pingMs: NET_CONFIG.pingMs,
    token: guestToken(),
  });
  active = s;
  s.on('state', (st) => {
    if (st === 'closed' && active === s) active = null;
  });
  return s;
}

/** Host a new room (call `.start()` to begin listening). */
export function createRoom(flags?: NetFlags): NetSession {
  return make('host', generateRoomCode(), flags);
}

/** Join an existing room by code; throws on an invalid code. */
export function joinRoom(code: string, flags?: NetFlags): NetSession {
  const c = normalizeRoomCode(code);
  if (!c) throw new Error('invalid room code');
  return make('guest', c, flags);
}
