# Co-op networking (2 players)

Wave 1 ships the transport, codec, clock/interpolation and the lobby. Gameplay sync (who
simulates what, which snapshots go over the wire) is wave 2.

- Code: `src/net/**` (this doc), lobby UI `src/ui/screens/coop.ts` (+ `coop.css`),
  title hook in `src/ui/screens/title.ts`, event `coop:start` in `src/core/events.ts`.
- Everything under `src/net` is reached through `import()` only. Vite names those chunks
  `assets/net-*.js`, and the service worker does not precache them (`vite.config.ts`
  `globIgnores`), so solo players never download them. `scripts/bundle-size.ts` now
  budgets *initial* JS (entry + modulepreloads, < 350 KB gzip) and lists lazy chunks
  separately.

Lazy cost for a co-op player (gzip): lobby + net core ≈ 10 KB, Trystero core ≈ 6 KB,
Nostr strategy ≈ 21 KB. The MQTT fallback (≈ 97 KB) loads only if Nostr signaling stalls,
and the Firebase relay (≈ 2 KB) loads only if it is configured and needed.

## Architecture

```
 CoopScreen (UI) ──► NetSession (lobby protocol, rejoin, clock sync, START)
                         │ Transport interface (bytes; reliable + unreliable lanes)
                         ▼
   TieredTransport ── TrysteroTransport(nostr) ─┐
   (connection ladder)  TrysteroTransport(mqtt) ─┼─ first candidate with a peer wins
                        FirebaseRelayTransport ──┘
   BroadcastTransport   (?nettransport=loopback-bc: same-origin tabs, no network)
   LoopbackTransport    (unit tests, in-memory pair)
   LossyTransport       (?netsim=…: seeded latency/jitter/loss/reorder wrapper)
```

| Module | What |
|---|---|
| `transport.ts` | `Transport` interface + `BaseTransport` (emitters, peers, tier) |
| `trystero.ts` | WebRTC through Trystero. Reliable lane = Trystero action. Unreliable lane = our own negotiated data channel (id 99, `{ordered:false, maxRetransmits:0}`) on Trystero's `RTCPeerConnection`, added through the `rtcPolyfill` hook (Trystero has no unreliable actions). If the channel isn't open, unreliable falls back to a second, reliable action. |
| `tiered.ts` | Connection ladder (below). Factories are injected so it can be unit-tested. |
| `firebase.ts` | Firebase RTDB relay over REST + `EventSource`. Pure `RelayOutbox` and `RelayInbox` do the batching and ordering. |
| `codec.ts` | `ByteWriter`/`ByteReader`, quantizers (int16 cm, u8 yaw, u8 unit), `MessageRegistry` (first byte = type id; 0–31 lobby, ≥ 32 gameplay). |
| `snapshot.ts` | `SnapshotSchema` (field kinds q16/yaw8/unit8/u8/u16/bool), `SnapshotEncoder` (field masks, delta against the newest *acked* baseline, pooled rows) and `SnapshotDecoder`. |
| `clock.ts` | `ClockSync` (NTP-style 4-timestamp ping, EWMA offset weighted toward low-RTT samples, jitter). `Scheduler` and `ManualScheduler` for deterministic tests. |
| `interp.ts` | `SnapshotInterpolator`: renders at `hostNow − D`, `D = clamp(interval + 2·jitter, 80, 250) ms`. Hermite between samples (velocity sent, or derived from neighbours), ≤ 150 ms linear extrapolation. |
| `session.ts` / `protocol.ts` | Lobby: HELLO/WELCOME/ROSTER/PICK/READY/START/REJECT/BYE/PING/PONG. |
| `room.ts` | 6-char codes (no look-alike characters) and invite URLs (`?room=CODE`). |
| `lossy.ts` | `LossyTransport` + `parseNetsim()`. |

### Session lifecycle

- **Host** = room creator (slot 0). The guest sends `HELLO {v, token}` on peer-join. The
  host answers `WELCOME` + `ROSTER`, or `REJECT {full|version}`.
- Hero pick: 4 slots (Inker, Penciller, Letterer, Colorist). Only Inker is selectable. The
  others say "coming in this issue" (`PLAYABLE_HEROES` in `protocol.ts`).
- Both players ready, then the host presses Start. `START {seed, at}` goes out, and both
  ends emit `start` (session) and `coop:start` (game bus). `at` is in host-clock ms;
  convert it with `session.hostNow()`.
- Pings every second on the unreliable lane. The guest's `ClockSync` converges on host
  time, and both ends show RTT.
- **Drops:** the seat is held for 60 s (`NET_CONFIG.rejoinWindowS`). `peerLeft` fires with
  `final:false` immediately and with `final:true` at expiry. A guest that comes back with
  the same per-tab token (sessionStorage) gets its seat and hero back.
- **iOS Safari background:** on `visibilitychange → visible` after more than 5 s hidden (or
  with no peers), the session rebuilds its transport and re-runs the handshake.
- Wave 2: `(await import('../net')).activeSession()` gives the live session. Use
  `session.send(def, msg, reliable)` and `session.on('message', …)` with defs registered
  on `NET_REGISTRY` at id ≥ 32.

## Connection tiers

Tried in order. Status (phase, tier, RTT) is shown in the lobby.

1. **Direct WebRTC.** Signaling runs over public **Nostr** relays (account-free,
   `NET_CONFIG.nostrRelays`, redundancy 4), with public STUN (Google and Cloudflare). SDP
   is encrypted with the room code as the Trystero password, so relays only see opaque
   blobs. If no peer shows up within `signalFallbackMs` (8 s), the same room is also
   joined over **MQTT** signaling (public EMQX/HiveMQ/Mosquitto WebSocket brokers).
2. **TURN** with static credentials, if configured. TURN servers sit in the same ICE
   server list. ICE ranks host and srflx pairs above relay pairs, so the direct path is
   tried first within a single negotiation, and nobody waits through an extra
   renegotiation. The reported tier comes from `getStats()`: the selected pair's local
   candidate type `relay` means `turn`.
3. **Firebase RTDB relay**, if configured. It starts when ICE reaches `checking` but not
   `connected` within `iceTimeoutMs` (4 s), or when no peer is found within
   `connectTimeoutMs` (30 s). It batches at 12 Hz. If a WebRTC peer appears later, the
   session upgrades back to it.

Without TURN or Firebase, a guest that can't connect sees "Couldn't connect" after 30 s.
The host keeps waiting.

## Build-time configuration (Vite env)

Never commit credentials. Put them in a git-ignored `.env.local` or in CI secrets. They end
up in the static bundle, so anyone can read them (see "Abuse caveats").

| Var | Example | Purpose |
|---|---|---|
| `VITE_TURN_URLS` | `turns:global.relay.metered.ca:443?transport=tcp,turn:global.relay.metered.ca:80` | Comma-separated TURN URLs. `turns:…:443` entries are sorted first. |
| `VITE_TURN_USERNAME` | — | Static TURN username |
| `VITE_TURN_CREDENTIAL` | — | Static TURN credential |
| `VITE_FIREBASE_DB_URL` | `https://inkwake-coop-default-rtdb.europe-west1.firebasedatabase.app` | Enables tier 3 |
| `VITE_FIREBASE_API_KEY` | `AIza…` | Optional. Signs in anonymously so the rules can require `auth != null`. |
| `VITE_NOSTR_RELAYS` | `wss://relay.damus.io,wss://nos.lol` | Optional override |
| `VITE_MQTT_RELAYS` | `wss://broker.emqx.io:8084/mqtt` | Optional override |

`src/net/config.ts` ships with an **empty** TURN list and Firebase disabled.

### Getting free TURN credentials

- **Metered Open Relay** (<https://www.metered.ca/tools/openrelay/>): sign up for the free
  plan. The dashboard shows a static username and credential, plus URLs on ports 80/443
  (UDP, TCP and TLS). Copy the `turns:…:443?transport=tcp` and `turn:…:80` URLs into
  `VITE_TURN_URLS`.
- **ExpressTURN** (<https://www.expressturn.com/>): the free tier gives one static
  username and password for `relay1.expressturn.com:3478` (and 443).

Both free tiers have monthly bandwidth caps. A co-op session at ~12–20 Hz snapshots uses
roughly 5–15 KB/s each way, so only the ~10–20 % of pairs that actually need TURN count
against the cap.

### Firebase relay setup

1. Create a Firebase project and add a **Realtime Database** (any region).
2. In Authentication, enable the **Anonymous** provider (optional, but recommended).
3. Set `VITE_FIREBASE_DB_URL` (and `VITE_FIREBASE_API_KEY` from Project settings → Web app).
4. Publish these **security rules**:

```json
{
  "rules": {
    ".read": false,
    ".write": false,
    "rooms": {
      "$code": {
        ".validate": "$code.matches(/^[A-HJ-NP-Z2-9]{6}$/)",
        ".read": "auth != null",
        "meta": {
          ".write": "auth != null && (!data.exists() || data.child('expiresAt').val() < now)",
          ".validate": "newData.hasChildren(['createdAt', 'expiresAt']) && newData.child('expiresAt').val() <= now + 3 * 60 * 60 * 1000"
        },
        "msgs": {
          ".write": "auth != null && root.child('rooms').child($code).child('meta/expiresAt').val() > now",
          "$key": {
            ".validate": "!newData.exists() || (newData.hasChildren(['f', 's', 't']) && $key.length < 48)"
          }
        },
        "$other": { ".validate": false }
      }
    }
  }
}
```

The host deletes `/rooms/{code}` when it leaves, and each sender deletes its own batches
5 s after writing them. RTDB has no native TTL, so rooms abandoned by a crashed tab stay
behind. Prune `/rooms/*` where `meta/expiresAt < now` with a scheduled job, or clear them
by hand from the console now and then.

If you run without anonymous auth (no API key), replace `auth != null` with `true` and
rely on the expiry and shape checks. That is weaker: anyone can write junk into live rooms.

## Dev and test flags

- `?nettransport=loopback-bc`: two tabs of the same origin talk through
  `BroadcastChannel`, with no network (used by the offline e2e test). Invite links keep
  this flag.
- `?netsim=rtt150,jit40,loss3[,ro5][,seed7]`: wraps the transport in `LossyTransport`
  (RTT ms, ± jitter ms, loss %, reorder %, seed). Reliable traffic is delayed but never
  dropped or reordered.
- Unit tests: `tests/unit/net-*.test.ts` cover the codec, delta compression, interpolator,
  clock sync, LossyTransport determinism, loopback handshake/rejoin/rebuild, relay
  batching and the tier ladder.
- E2E: `tests/e2e/coop.spec.ts`. The offline tests run by default. The real-network test
  (two browser contexts, real Trystero/Nostr) is opt-in with `COOP_E2E_REAL=1`.

## Abuse caveats

- **Public signaling.** Nostr relays and MQTT brokers are third-party community services.
  They can rate-limit, go down or log metadata (topic hashes, IPs). Room codes are short,
  so an attacker could scan codes and join an open lobby. Codes are not secrets. The host
  sees the guest seat fill, and a third peer is rejected with `full`.
- **Static TURN credentials are public** once bundled. Anyone can lift them from the JS and
  burn your quota. Use free or capped accounts only, and rotate them if abused. For a
  bigger audience, mint short-lived TURN credentials server-side. That is out of scope
  here, since we deploy no servers.
- **Firebase.** The API key is public by design. Protection comes from the rules above
  (auth, shape, expiry) plus RTDB usage alerts and quotas. Consider App Check if abuse
  shows up.
- **Peers are untrusted.** Every decoder is bounds-checked and returns `null` on junk. The
  host validates PICK/READY. Wave 2 must keep the host authoritative for anything that
  matters (damage, pickups, progression).
- WebRTC reveals each player's IP address to the other. That is normal for P2P, but say
  so in any privacy note.
