# Co-op networking (2 players)

Wave 1 shipped the transport, codec, clock/interpolation and the lobby. Wave 2 adds the
gameplay sync (`src/coop/**`, lazy chunk) — see "Gameplay sync" below.

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
- Hero pick: 4 slots (Inker, Penciller, Letterer, Colorist), all selectable
  (`PLAYABLE_HEROES` in `protocol.ts`). `coop:start.heroes[]` (by slot) drives both machines: the
  local hero runtime loads this machine's kit, `RemotePlayer` the partner's (see "Heroes in
  co-op").
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

## Gameplay sync (wave 2)

Code: `src/coop/**` (lazy chunk `net-coop-*.js`, reached only through `import('../coop')` from
`src/game/Game.ts`), partner HUD `src/ui/hud/partner.ts`, tuning `TUNING.coop`.

| Module | What |
|---|---|
| `rules.ts` | Shared rules for local 2P and online: downed/revive, both-down reprint, tether, dash-through ink, Two-Page Spread clamp |
| `local.ts` | `?local2p=1`: second `Player` + `Combat` + `InkEnergy` (IJKL move, U crystal, O bolt, H dash, Y snuff, or the 2nd gamepad) |
| `net.ts` | `NetCoop`: host/guest replication, hit validation, scheduling, disconnect/rejoin/takeover |
| `wire.ts` | Message ids 40–43, wizard state, enemy `SnapshotSchema`, boss block, page save, RLE |
| `RemotePlayer.ts` | The partner's wizard: newest replicated state for gameplay, a puppet-driven `Player` body for visuals |
| `puppet.ts` | Guest enemy mirror, co-op targeting chooser, crystal-1 `RevealAPI` facade, page-save helpers |
| `history.ts` | `HitHistory`: 250 ms per-tick ring of (enemy id, alive, revealed) |

**Authority.** The host owns the world: enemies, projectiles, spawner/director, boss FSM,
sketch printing, triggers, pickups, crit rules. Each client owns its own wizard (movement, dash,
crystal, ink), with no reconciliation. `ctx.players` is slot-ordered on both machines and
`ctx.player` stays the local wizard. RevealSystem crystal 0 is always the local wizard, crystal 1
the partner (`setDual`, `center2`/`radius2`); the reveal history is rebuilt locally from both
crystals, dash trails and events, and only sent in full (RLE) on a (re)join.

**Wire.**
- `SNAP` (40, unreliable, 20 Hz): host tick + host-clock time, epoch, blot suppression on the
  guest crystal, the host wizard (~24 B), the boss block when the Editor is up, and ≤ 12 nearest
  enemy rows delta-compressed against the newest acked baseline.
- `PSTATE` (41, unreliable, 30 Hz): snapshot ack + the guest's last 3 wizard states (seq-tagged,
  host-clock stamped) so a lost packet costs nothing.
- `EVT` (42, reliable): batches of tick-tagged events — spawn/die/hit, scribbler fire params,
  hit requests/acks, sketch printed, trigger fired (checkpoints included), respawn, shared panel
  cut, page turn, page save, contact damage, ink claim, dash, boss phase/attack/weak point/STET,
  `hero:action`, `perk`, `heal`, `combo`, `sprog` (wave 3).
- `SYNC` (43, reliable): page save + reveal history for a joining/rejoining guest.
- Every event batch and snapshot carries an **epoch** (bumped on each page build and checkpoint
  respawn on both machines); a guest holds batches of a future epoch until its own page is up.

**Combat.** Guest bolts favor the shooter: the guest flashes the hit and sends `hitReq` with
`fireTick = estHostTick − interpDelay`; the host accepts if the target was alive + revealed in
the history ring around that tick (or is now) and refunds the bolt's ink otherwise. Player
damage favors the victim: scribbler strokes and Editor lanes are simulated on both machines from
their spawn params and each tests only its own wizard; ghost contact runs on the host against
the guest's newest position with a 0.1 m smaller radius. Hit-stop and crit cuts stay local;
shared panel cuts, boss phase cuts, pair combos and page turns are scheduled by the host
`leadTicks` (6 × 16.7 ms) ahead **in host-clock ms** (`NetCoop.leadAt`); both machines run them
when their clock-synced `session.hostNow()` reaches that moment, so the guest plays them on the
host's beat rather than on packet arrival (and a slow host's tick drift doesn't skew them).

**Pages.** The page end fires only when both wizards are inside the exit rect (host decides).
Downed wizards crawl as "UNFINISHED" sketches (40 % speed); the partner reprints them by holding
the crystal on them for 2 s inside the reveal; both down → checkpoint reprint for both. Past
22 m the page edge curls (vignette + soft leash); past 30 m the lagging wizard is pulled to the
partner with a "MEANWHILE…" cut.

**Drops.** Partner gone: fades out over 10 s, the run continues solo and the 2-player scaling
(ghost HP ×1.6, maxActive 12, attacker cap 3) eases back over 3 s; the seat is held 60 s and a
rejoin gets `SYNC`. Host gone: the guest shows a 10 s reconnect overlay, then closes the room and
reloads the page at the replicated checkpoint (printed sketches, spent triggers, cleared waves,
boss phase + weak-point mask). Online pages never pause, and a 100 ms watchdog keeps ticking the
sim when the tab loses rAF.

## Heroes in co-op (wave 3)

- **Puppet kits.** `RemotePlayer.setHero(id)` loads the partner's kit chunk (`loadKit`), sets
  `kit.remote = true` and steps it itself. Every `hero:action` the local kit emits is copied (kits
  reuse the payload) into an `EVT` `hero` event; the receiver replays it with
  `applyRemoteAction(kit, ev, world)`, `world = true` only on the host. The puppet's side effects
  (`hero:print`, ink drops, lures, shakes, panel cuts, sfx) go to the game bus; ink it would grant
  goes to its owner (`claim`), pages via `heal`.
- **Authority.** `Player.worldAuthority` → `HeroHost.authority` is false for the online guest's
  own kit: it still plays its own-wizard effects (Inker Splash Page, balloon soak, gold-flat heal,
  Halftone refund) but leaves damage, stun, pins, crushes, lures and colour statuses to the host's
  puppet, which replicates through the usual snapshot rows and `hit` / `die` / `sketch` events.
  Reveal (ink) is per machine, so every copy of an action adds its reveal sources.
- **Perks** replicate as `perk` events; the **Splash meter** is per player (pid follows the slot;
  `WizState.splash` feeds the partner card's bar). Local 2P: `?hero2=` picks player 2's kit; the
  hero runtime offers each local player their own perk card.
- **Pair combos** (`src/coop/combos.ts`, detection in `entities/heroes/combos.ts`): the host (or
  the local 2P machine) runs the detector on both heroes' actions and resolves the gameplay
  (`ComboEffects.play(h, world)`), then sends `combo` (with `at` in host-clock ms); the guest
  replays the visuals + ink at that moment and emits `hero:combo`. A combo charges both Splash
  meters and opens a ×2 charge window (`heroes.splash.comboBoostS`). Panel cut words are
  `heroes.combo.*` (lazy heroes dictionary).
- **Decoys** (Colorist) emit `hero:lure` where world effects resolve; `EnemySystem` targeting reads
  live lures (1.5 s) closer than the enemy's wizard. The **Penciller** sees unlit ghosts as faint
  pencil silhouettes on his own screen (`EnemyRenderer` `sight`).
- **Guest mirrors:** live sketch print progress (`sprog`, 10 Hz, `SketchObjects.replica`), and the
  boss block carries the rewrite sketch (verb, draw-in, print) and the P2 summon drawing.
- New `EVT` kinds: `perk`, `heal`, `combo`, `sprog`. Wire bumps (same build on both ends):
  `WizState.splash` (u8) and the boss block's `rw` / `sm` tail.

**Boss co-op moments** (two players only): *Two-Page Spread* (P2 gutter wall, weak points print
only from the other panel) and *STET* (P3 red-pencil circle; partner holds the crystal on it;
both holding in the 400 ms slam window parries the eraser into the Editor).

**Hooks for tests/e2e.** `window.__net` (`role`, `slot`, `solo`, `partner`, `players`, `epoch`,
`tick`, `rtt`, `stats`) and `<html data-coop="host|guest|local|solo" data-coop-peers>`.
`?autoplay=1` with `?room=` or `?coop=host` goes through the lobby instead of auto-starting.

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
- Unit: `tests/unit/coop-net.test.ts` runs two headless sims (`tests/unit/coop-harness.ts`)
  over Loopback + Lossy transports: convergence, hit accept/reject + refund, both-at-exit page
  turn, disconnect → solo scaling; plus wire, history, triggers and rules tests.
- E2E: `tests/e2e/coop.spec.ts` (lobby → run) and `tests/e2e/coop-run.spec.ts` (two autoplay
  bots over `loopback-bc` + `netsim`, long; `COOP_RUN_E2E=0` skips it). The offline tests run by default. The real-network test
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
