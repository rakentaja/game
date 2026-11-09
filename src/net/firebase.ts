/**
 * FirebaseRelayTransport (tier 3): when WebRTC can't connect at all, both peers relay through a
 * Firebase Realtime Database using only its REST API — no SDK in the bundle.
 *
 *   write:  PATCH {db}/rooms/{code}/msgs.json   { "<from>_<seq>": Batch, "<old key>": null, … }
 *   read:   EventSource {db}/rooms/{code}/msgs.json   (server-sent 'put' / 'patch' events)
 *   meta:   PUT   {db}/rooms/{code}/meta.json   { createdAt, expiresAt }  (host, once)
 *
 * Traffic is batched at `hz` (12 by default): every reliable message queued since the last flush
 * plus only the newest few unreliable ones. Batches carry a per-sender sequence number; the
 * receiver delivers them in order (gaps are skipped after a timeout). Each sender deletes its own
 * batches a few seconds after writing them, and the host deletes the whole room on close; the
 * security rules in docs/COOP.md reject writes to expired rooms.
 *
 * Auth: with an API key we sign in anonymously (Identity Toolkit REST) and pass `?auth=<idToken>`
 * so rules can require `auth != null`.
 */
import type { FirebaseConfig } from './config';
import { BaseTransport } from './transport';

export interface RelayBatch {
  /** sender id */
  f: string;
  /** per-sender sequence */
  s: number;
  /** sender wall clock (ms) */
  t: number;
  /** reliable payloads, base64 */
  r?: string[];
  /** unreliable payloads, base64 */
  u?: string[];
  /** heartbeat-only batch */
  h?: 1;
  /** sender is leaving */
  bye?: 1;
}

/** Max unreliable messages per batch (older ones are superseded snapshots). */
const MAX_UNRELIABLE = 4;
const KEEP_MS = 5000;
const PEER_TIMEOUT_MS = 6000;
const GAP_SKIP_MS = 1500;
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;

export function toB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}
export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function batchKey(from: string, seq: number): string {
  return `${from}_${String(seq).padStart(9, '0')}`;
}

/**
 * Pure outbound queue: collects messages and produces a batch per flush. Kept separate from I/O
 * so it is unit-testable.
 */
export class RelayOutbox {
  private seq = 0;
  private reliable: string[] = [];
  private unreliable: string[] = [];
  private lastSentAt = Number.NEGATIVE_INFINITY;

  constructor(readonly selfId: string) {}

  push(data: Uint8Array, reliable: boolean): void {
    (reliable ? this.reliable : this.unreliable).push(toB64(data));
    if (this.unreliable.length > MAX_UNRELIABLE)
      this.unreliable.splice(0, this.unreliable.length - MAX_UNRELIABLE);
  }

  get pending(): boolean {
    return this.reliable.length > 0 || this.unreliable.length > 0;
  }

  /** Next batch, or null if nothing to send and no heartbeat due. */
  take(now: number, heartbeatMs = 1000, bye = false): RelayBatch | null {
    if (!this.pending && !bye && now - this.lastSentAt < heartbeatMs) return null;
    const b: RelayBatch = { f: this.selfId, s: this.seq++, t: Date.now() };
    if (this.reliable.length) b.r = this.reliable.splice(0);
    if (this.unreliable.length) b.u = this.unreliable.splice(0);
    if (!b.r && !b.u) b.h = 1;
    if (bye) b.bye = 1;
    this.lastSentAt = now;
    return b;
  }

  /** Put a failed batch's reliable messages back at the front (unreliable ones are dropped). */
  requeue(b: RelayBatch): void {
    if (b.r) this.reliable.unshift(...b.r);
  }
}

/** Pure inbound reorderer: per sender, releases batches in sequence order. */
export class RelayInbox {
  private next = new Map<string, number>();
  private held = new Map<string, Map<number, RelayBatch>>();
  private gapSince = new Map<string, number>();

  constructor(readonly selfId: string) {}

  /** Feed a batch; returns batches now deliverable (in order). */
  accept(b: RelayBatch, now: number): RelayBatch[] {
    if (!b || typeof b.f !== 'string' || typeof b.s !== 'number' || b.f === this.selfId) return [];
    const out: RelayBatch[] = [];
    let exp = this.next.get(b.f);
    if (exp === undefined) exp = b.s; // first batch seen from this sender: start here
    if (b.s < exp) return out;
    let held = this.held.get(b.f);
    if (!held) {
      held = new Map();
      this.held.set(b.f, held);
    }
    held.set(b.s, b);
    this.drain(b.f, exp, held, out, now);
    return out;
  }

  /** Release held batches whose gap has been open too long. */
  tick(now: number): RelayBatch[] {
    const out: RelayBatch[] = [];
    for (const [f, held] of this.held) {
      if (!held.size) continue;
      const since = this.gapSince.get(f);
      if (since === undefined || now - since < GAP_SKIP_MS) continue;
      const exp = Math.min(...held.keys());
      this.drain(f, exp, held, out, now);
    }
    return out;
  }

  private drain(f: string, exp: number, held: Map<number, RelayBatch>, out: RelayBatch[], now: number): void {
    let e = exp;
    for (;;) {
      const b = held.get(e);
      if (!b) break;
      held.delete(e);
      out.push(b);
      e++;
    }
    this.next.set(f, e);
    if (held.size) {
      if (!this.gapSince.has(f)) this.gapSince.set(f, now);
    } else this.gapSince.delete(f);
  }
}

async function anonymousToken(apiKey: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true }),
      },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { idToken?: string };
    return j.idToken ?? null;
  } catch {
    return null;
  }
}

export class FirebaseRelayTransport extends BaseTransport {
  private outbox: RelayOutbox;
  private inbox: RelayInbox;
  private es: EventSource | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private inflight = false;
  private auth = '';
  private written: { key: string; at: number }[] = [];
  private lastHeard = new Map<string, number>();
  private sentAt = new Map<number, number>();
  private initialLoaded = false;

  private constructor(
    private room: string,
    selfId: string,
    private cfg: FirebaseConfig,
    private hz: number,
    private isHost: boolean,
  ) {
    super(selfId, 'relay');
    this.outbox = new RelayOutbox(selfId);
    this.inbox = new RelayInbox(selfId);
  }

  static async create(
    room: string,
    selfId: string,
    cfg: FirebaseConfig,
    hz: number,
    isHost: boolean,
  ): Promise<FirebaseRelayTransport> {
    const t = new FirebaseRelayTransport(room, selfId, cfg, hz, isHost);
    await t.start();
    return t;
  }

  private url(path: string): string {
    const sub = path ? `/${path}` : '';
    return `${this.cfg.dbUrl}/rooms/${encodeURIComponent(this.room)}${sub}.json${this.auth ? `?auth=${encodeURIComponent(this.auth)}` : ''}`;
  }

  private async start(): Promise<void> {
    if (this.cfg.apiKey) this.auth = (await anonymousToken(this.cfg.apiKey)) ?? '';
    if (this.isHost) {
      const now = Date.now();
      await fetch(this.url('meta'), {
        method: 'PUT',
        body: JSON.stringify({ createdAt: { '.sv': 'timestamp' }, expiresAt: now + ROOM_TTL_MS }),
      }).catch(() => {});
    }
    const es = new EventSource(this.url('msgs'));
    this.es = es;
    const onEvt = (e: MessageEvent<string>) => {
      let ev: { path: string; data: unknown };
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!this.initialLoaded) {
        // the first 'put' is the whole existing node: history, not live traffic
        this.initialLoaded = true;
        if (ev.path === '/') return;
      }
      if (ev.path === '/' && ev.data && typeof ev.data === 'object') {
        for (const v of Object.values(ev.data as Record<string, RelayBatch | null>)) if (v) this.onBatch(v);
      } else if (ev.data && typeof ev.data === 'object') {
        this.onBatch(ev.data as RelayBatch);
      }
    };
    es.addEventListener('put', onEvt as EventListener);
    es.addEventListener('patch', onEvt as EventListener);
    es.addEventListener('cancel', () => this.close());
    this.flushTimer = setInterval(() => this.flush(), 1000 / this.hz);
  }

  private onBatch(b: RelayBatch): void {
    const now = performance.now();
    if (b.f === this.selfId) {
      const t0 = this.sentAt.get(b.s);
      if (t0 !== undefined) {
        this.sentAt.delete(b.s);
        // write → visible in stream ≈ one relay hop; peer RTT ≈ two of them
        const sample = (now - t0) * 2;
        this.rttMs = Number.isNaN(this.rttMs) ? sample : this.rttMs + (sample - this.rttMs) * 0.2;
      }
      return;
    }
    this.lastHeard.set(b.f, now);
    for (const ready of this.inbox.accept(b, now)) this.consume(ready);
  }

  private consume(b: RelayBatch): void {
    if (b.bye) {
      this.peerLeft(b.f);
      return;
    }
    this.peerJoined(b.f);
    if (b.r) for (const s of b.r) this.deliver(fromB64(s), b.f, true);
    if (b.u) for (const s of b.u) this.deliver(fromB64(s), b.f, false);
  }

  private flush(bye = false): void {
    const now = performance.now();
    for (const b of this.inbox.tick(now)) this.consume(b);
    for (const [id, at] of this.lastHeard) {
      if (now - at > PEER_TIMEOUT_MS) {
        this.lastHeard.delete(id);
        this.peerLeft(id);
      }
    }
    if (this.inflight && !bye) return;
    const batch = this.outbox.take(now, 1000, bye);
    if (!batch) return;
    const key = batchKey(this.selfId, batch.s);
    const patch: Record<string, RelayBatch | null> = { [key]: batch };
    while (this.written.length && now - this.written[0]!.at > KEEP_MS)
      patch[this.written.shift()!.key] = null;
    this.written.push({ key, at: now });
    this.sentAt.set(batch.s, now);
    if (this.sentAt.size > 64) this.sentAt.clear();
    this.inflight = true;
    fetch(this.url('msgs'), { method: 'PATCH', body: JSON.stringify(patch), keepalive: bye })
      .then((r) => {
        if (!r.ok) this.outbox.requeue(batch);
      })
      .catch(() => this.outbox.requeue(batch))
      .finally(() => {
        this.inflight = false;
      });
  }

  sendReliable(data: Uint8Array): void {
    if (!this.closed) this.outbox.push(data, true);
  }
  sendUnreliable(data: Uint8Array): void {
    if (!this.closed) this.outbox.push(data, false);
  }

  override close(): void {
    if (this.closed) return;
    this.flush(true);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.es?.close();
    if (this.isHost) void fetch(this.url(''), { method: 'DELETE', keepalive: true }).catch(() => {});
    super.close();
  }
}
