import { describe, expect, it, vi } from 'vitest';
import { ManualScheduler } from '../../src/net/clock';
import { NET_CONFIG } from '../../src/net/config';
import { batchKey, fromB64, RelayInbox, RelayOutbox, toB64 } from '../../src/net/firebase';
import { readNetFlags } from '../../src/net/index';
import { LoopbackTransport } from '../../src/net/loopback';
import { LossyTransport, parseNetsim } from '../../src/net/lossy';
import {
  CODE_ALPHABET,
  generateRoomCode,
  inviteUrl,
  normalizeRoomCode,
  roomFromUrl,
} from '../../src/net/room';
import { NetSession, type SessionState, type StartInfo } from '../../src/net/session';
import { TieredTransport } from '../../src/net/tiered';
import { Emitter } from '../../src/net/transport';

describe('netsim + LossyTransport', () => {
  it('parses ?netsim specs', () => {
    expect(parseNetsim('rtt150,jit40,loss3')).toEqual({
      rtt: 150,
      jitter: 40,
      loss: 0.03,
      reorder: 0,
      seed: 1,
    });
    expect(parseNetsim('ro10,seed9')).toMatchObject({ reorder: 0.1, seed: 9 });
    expect(parseNetsim('')).toBeNull();
    expect(parseNetsim('nonsense')).toBeNull();
    expect(readNetFlags('?nettransport=loopback-bc&netsim=rtt50')).toEqual({
      transport: 'loopback-bc',
      netsim: 'rtt50',
    });
    expect(readNetFlags('').transport).toBe('auto');
  });

  function run(seed: number) {
    const s = new ManualScheduler();
    const [a, b] = LoopbackTransport.pair('a', 'b', s);
    const la = new LossyTransport(a, { rtt: 100, jitter: 30, loss: 0.2, reorder: 0.1, seed }, s);
    const log: string[] = [];
    b.onMessage((d, _from, rel) => log.push(`${s.now().toFixed(3)}:${rel ? 'R' : 'U'}${d[0]}`));
    s.advance(1);
    for (let i = 0; i < 200; i++) {
      la.sendUnreliable(new Uint8Array([i & 255]));
      if (i % 10 === 0) la.sendReliable(new Uint8Array([i & 255]));
      s.advance(16);
    }
    s.advance(1000);
    return { log, stats: { ...la.stats } };
  }

  it('is deterministic for a seed and degrades as configured', () => {
    const r1 = run(5);
    const r2 = run(5);
    const r3 = run(6);
    expect(r1.log).toEqual(r2.log);
    expect(r1.log).not.toEqual(r3.log);
    const unrel = r1.log.filter((l) => l.includes(':U')).length;
    expect(unrel).toBe(200 - r1.stats.dropped);
    expect(r1.stats.dropped).toBeGreaterThan(20);
    expect(r1.stats.dropped).toBeLessThan(60);
    expect(r1.stats.reordered).toBeGreaterThan(0);
    // reliable lane: all 20 delivered, in order
    const rel = r1.log.filter((l) => l.includes(':R')).map((l) => Number(l.split(':R')[1]));
    expect(rel).toEqual(Array.from({ length: 20 }, (_, i) => i * 10));
    // unreliable lane actually arrives out of order somewhere
    const un = r1.log.filter((l) => l.includes(':U')).map((l) => Number(l.split(':U')[1]));
    expect(un.some((v, i) => i > 0 && v < un[i - 1]!)).toBe(true);
  });
});

describe('room codes', () => {
  it('generates, normalizes and builds invite links', () => {
    const c = generateRoomCode();
    expect(c).toHaveLength(6);
    for (const ch of c) expect(CODE_ALPHABET).toContain(ch);
    expect(normalizeRoomCode(' ab-cd 23 ')).toBe('ABCD23');
    expect(normalizeRoomCode('ABC')).toBeNull();
    expect(normalizeRoomCode('ABCDE0')).toBeNull(); // 0 is not in the alphabet
    const url = inviteUrl('ABCD23', 'https://x.io/game/?skip=1&nettransport=loopback-bc#h');
    expect(url).toBe('https://x.io/game/?nettransport=loopback-bc&room=ABCD23');
    expect(roomFromUrl('?room=abcd23')).toBe('ABCD23');
  });
});

describe('Firebase relay batching', () => {
  it('base64 round-trips bytes', () => {
    const b = new Uint8Array([0, 1, 255, 128, 7]);
    expect([...fromB64(toB64(b))]).toEqual([...b]);
    expect(batchKey('p', 12)).toBe('p_000000012');
  });

  it('outbox batches, caps unreliable, heartbeats; inbox reorders per sender', () => {
    const out = new RelayOutbox('me');
    expect(out.take(0)).toMatchObject({ h: 1, s: 0 });
    expect(out.take(500)).toBeNull(); // nothing pending, heartbeat not due
    out.push(new Uint8Array([1]), true);
    for (let i = 0; i < 10; i++) out.push(new Uint8Array([i]), false);
    const b1 = out.take(600)!;
    expect(b1.r).toHaveLength(1);
    expect(b1.u).toHaveLength(4);
    expect(fromB64(b1.u![3]!)[0]).toBe(9);

    const inbox = new RelayInbox('you');
    const mk = (s: number) => ({ f: 'me', s, t: 0, r: [toB64(new Uint8Array([s]))] });
    expect(inbox.accept(mk(5), 0).map((b) => b.s)).toEqual([5]);
    expect(inbox.accept(mk(7), 10)).toEqual([]);
    expect(inbox.accept(mk(6), 20).map((b) => b.s)).toEqual([6, 7]);
    expect(inbox.accept(mk(6), 30)).toEqual([]); // duplicate
    expect(inbox.accept(mk(9), 40)).toEqual([]); // gap at 8
    expect(inbox.tick(100)).toEqual([]);
    expect(inbox.tick(2000).map((b) => b.s)).toEqual([9]);
    expect(inbox.accept({ f: 'you', s: 0, t: 0 }, 0)).toEqual([]); // own echo ignored
  });
});

function lobby(latency = 20) {
  const sched = new ManualScheduler();
  let pair = LoopbackTransport.pair('H', 'G', sched, latency);
  const host = new NetSession({
    role: 'host',
    code: 'ABCD23',
    connect: async () => pair[0],
    scheduler: sched,
    watchVisibility: false,
  });
  const guest = new NetSession({
    role: 'guest',
    code: 'ABCD23',
    connect: async () => pair[1],
    scheduler: sched,
    token: 'tok-1',
    watchVisibility: false,
  });
  const states: Record<'host' | 'guest', SessionState[]> = { host: [], guest: [] };
  host.on('state', (s) => states.host.push(s));
  guest.on('state', (s) => states.guest.push(s));
  return {
    sched,
    host,
    guest,
    states,
    repair() {
      pair = LoopbackTransport.pair('H', 'G', sched, latency);
    },
    async tick(ms: number) {
      for (let t = 0; t < ms; t += 10) {
        sched.advance(10);
        await Promise.resolve();
      }
    },
  };
}

describe('NetSession over loopback', () => {
  it('handshakes, picks, readies and starts on both ends', async () => {
    const L = lobby();
    await L.host.start();
    await L.guest.start();
    await L.tick(200);
    expect(L.host.state).toBe('connected');
    expect(L.guest.state).toBe('connected');
    expect(L.states.host).toEqual(['waiting', 'connected']);
    expect(L.guest.players).toHaveLength(2);
    expect(L.guest.slot).toBe(1);

    // only Inker is playable
    expect(L.guest.pick('colorist')).toBe(false);
    expect(L.guest.pick('inker')).toBe(true);

    expect(L.host.canStart()).toBe(false);
    expect(L.host.requestStart()).toBe(false);
    L.host.setReady(true);
    L.guest.setReady(true);
    await L.tick(100);
    expect(L.host.players.every((p) => p.ready)).toBe(true);
    expect(L.guest.players.every((p) => p.ready)).toBe(true);
    expect(L.guest.requestStart()).toBe(false); // guest cannot start

    const starts: StartInfo[] = [];
    L.host.on('start', (i) => starts.push(i));
    L.guest.on('start', (i) => starts.push(i));
    expect(L.host.requestStart()).toBe(true);
    await L.tick(100);
    expect(starts).toHaveLength(2);
    expect(starts[0]!.seed).toBe(starts[1]!.seed);
    expect(starts.map((s) => s.slot).sort()).toEqual([0, 1]);

    // clock sync ran (pings every second) and converged: same clock in this test → offset ≈ 0
    await L.tick(5000);
    expect(L.guest.clock.samples).toBeGreaterThan(3);
    expect(Math.abs(L.guest.clock.offset)).toBeLessThan(1);
    expect(L.guest.rtt()).toBeCloseTo(40, 0);
    expect(L.host.rtt()).toBeCloseTo(40, 0);
    expect(L.guest.status().tier).toBe('loopback');
  });

  it('keeps the seat for the rejoin window, restores it, and fires final peer-left on expiry', async () => {
    const L = lobby();
    await L.host.start();
    await L.guest.start();
    await L.tick(200);
    L.guest.setReady(true);
    await L.tick(100);
    const left: { final: boolean }[] = [];
    L.host.on('peerLeft', (e) => left.push(e));

    (L.host.transport as LoopbackTransport).disconnect();
    await L.tick(50);
    expect(L.host.state).toBe('reconnecting');
    expect(L.guest.state).toBe('reconnecting');
    expect(left).toEqual([{ peer: 'G', final: false }]);
    expect(L.host.status().rejoinLeftS).toBe(60);
    expect(L.host.players[1]!.connected).toBe(false);

    (L.host.transport as LoopbackTransport).reconnect();
    await L.tick(200);
    expect(L.host.state).toBe('connected');
    expect(L.guest.state).toBe('connected');
    expect(L.host.players[1]!.connected).toBe(true);

    (L.host.transport as LoopbackTransport).disconnect();
    await L.tick(61_000);
    expect(left.at(-1)).toEqual({ peer: 'G', final: true });
    expect(L.host.state).toBe('waiting');
    expect(L.host.players).toHaveLength(1);
    expect(L.guest.state).toBe('failed');
    expect(L.guest.error).toBe('host-left');
  });

  it('rebuilds the transport (iOS background) and re-handshakes', async () => {
    const L = lobby();
    await L.host.start();
    await L.guest.start();
    await L.tick(200);
    L.repair(); // fresh link for both connect() calls
    const g = L.guest.rebuild();
    const h = L.host.rebuild();
    await Promise.all([g, h]);
    await L.tick(300);
    expect(L.host.state).toBe('connected');
    expect(L.guest.state).toBe('connected');
  });

  it('host announces leaving with BYE', async () => {
    const L = lobby();
    await L.host.start();
    await L.guest.start();
    await L.tick(200);
    L.host.close();
    await L.tick(200);
    expect(L.guest.state).toBe('failed');
    expect(L.guest.error).toBe('host-left');
  });
});

describe('TieredTransport ladder', () => {
  it('steps to the relay when ICE stalls, then upgrades back to WebRTC', async () => {
    vi.useFakeTimers();
    try {
      const webSched = new ManualScheduler();
      const relaySched = new ManualScheduler();
      const iceFailed = new Emitter<[string]>();
      const [webA] = LoopbackTransport.pair('A', 'B', webSched);
      const [relA] = LoopbackTransport.pair('A', 'B', relaySched);
      Object.assign(webA, { iceFailed, iceChecking: new Emitter<[]>() });
      const relayCalls: string[] = [];
      const t = await TieredTransport.create(
        NET_CONFIG,
        {
          webrtc: async () => webA,
          relay: async (id) => {
            relayCalls.push(id);
            return relA;
          },
        },
        false,
      );
      const joins: string[] = [];
      t.onPeerJoin((p) => joins.push(p));
      expect(t.phase).toBe('signaling');
      iceFailed.emit('checking');
      expect(t.phase).toBe('fallback');
      await vi.advanceTimersByTimeAsync(1);
      expect(relayCalls).toEqual(['A']);

      relaySched.advance(1); // relay link comes up first
      expect(joins).toEqual(['B']);
      expect(t.phase).toBe('connected');
      expect(t.via).toBe('relay');

      webSched.advance(1); // WebRTC finally connects → upgrade, same logical peer
      expect(t.via).toBe('nostr');
      expect(joins).toEqual(['B']);
      expect(relA.peers()).toEqual([]); // relay closed

      // no peer at all within connectTimeout → guest reports failure (no relay configured)
      const lone = await TieredTransport.create(
        NET_CONFIG,
        { webrtc: async () => LoopbackTransport.pair('X', 'Y', new ManualScheduler())[0], relay: null },
        false,
      );
      await vi.advanceTimersByTimeAsync(NET_CONFIG.connectTimeoutMs + 10);
      expect(lone.phase).toBe('failed');
      lone.close();
      t.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
