# INKWAKE — Issue #1: The Unprinted Wood

A pulp-comic world that hasn't been printed yet. Your crystal sheds ink, not light: wherever it
shines, the page gets drawn. Paper ghosts hide outside the ink; reveal them, ink them, and turn the
page. Three pages and a boss, **THE EDITOR**, in 5–8 minutes. Mobile-first, installable PWA, plays
offline.

**Play:** <https://rakentaja.github.io/game/> (GitHub Pages, deployed from `main`).

## How to play

- Move through each page. Hold the **crystal** to spread ink: it reveals the world, the ghosts and
  sketched objects. Holding it drains **ink energy**; ink wells and defeated ghosts refill it.
- Ghosts can only be hit while they're inside the ink. **Tap** to fire an ink bolt at the nearest
  revealed one.
- **Dash** through danger (brief invulnerability, leaves an ink trail).
- Dashed-pencil sketches (bridge, stairs, gate) are **printed** by keeping the crystal on them.
- You have **pages** instead of hearts; lose them all and you restart at the last checkpoint.
- THE EDITOR erases the arena in three phases. Watch the eraser, print the weak points, finish it.
- Kills, prints and pair combos fill your **Splash** meter; when it is full, fire your hero's
  **ultimate**.

## Heroes

Pick a hero on the title screen (or with `?hero=`). Every hero uses the same grammar: tap = attack,
hold = channel, swipe = movement, double-tap = ultimate. Each page offers a pick-one-of-two perk.

| Hero | Tap | Hold | Swipe | Ultimate |
|---|---|---|---|---|
| **Inker** (default) | ink bolt at the nearest lit ghost | grow the crystal, print sketches | dash, ink trail | SPLASH PAGE: full-screen ink, piercing bolts |
| **Penciller** (no light) | ruler pins a ghost (hittable outside the ink) | trace a loop: crush pinned ghosts, print sketches by tracing | erase-step (phase through) | LAYOUT: freeze every ghost on screen |
| **Letterer** | sound-effect word (bigger on the beat) | speech-balloon shield, release = SHHH! shove | WHOOSH: letters as stepping-stones | SFX STORM: your longest word as giant letters |
| **Colorist** | spray teal (slow) → salmon (burn) → gold (ink) | Fill Bucket: the ink you stand in stays inked | misregistration decoys that draw aggro | FOUR-COLOR: flats spread, everything inside registers |

The Penciller sees ghosts outside the ink as faint pencil silhouettes (on his own screen only).

## Controls

| Action | Touch | Keyboard / mouse | Gamepad |
|---|---|---|---|
| Move | drag on the left half (floating stick) | WASD / arrows | left stick |
| Crystal (hold) | press and hold on the right half | Shift or L, or hold right mouse button | any trigger / RB |
| Ink bolt | tap on the right half | J / Enter / left click | X or B |
| Dash | swipe on the right half | Space / K | A |
| Ultimate (Splash full) | double-tap on the right half | Q | LB |
| Pause | ⏸ button | Esc / P | Start |

Hero kits reuse the same inputs (tap = the hero's attack, hold = channel, swipe = movement).
Local 2P player 2: IJKL move, U hold, O tap, H dash, Y snuff, N ultimate, or the second gamepad
(left stick, triggers hold, A dash, X/B tap, LB ultimate).

Left-handed mode (Settings) swaps the touch sides. Settings also cover volume, vibration, reduce
motion, misregistration, quality (Auto/Low/High), language (EN/TR) and difficulty (Story/Normal).

## Co-op (2 players)

- **Online:** Title → **Co-op** → **Host** creates a room with a 6-character **room code**
  (no look-alike characters) and an **invite link** (`…/?room=CODE`, Share / Copy buttons). The
  partner opens the link, or picks **Join** and types the code. Both pick a hero, press Ready, and
  the host presses Start. Peer-to-peer WebRTC (signaling over public Nostr relays, MQTT fallback,
  optional TURN / Firebase relay); the host owns the world, each player owns their own wizard.
  Details: [docs/COOP.md](docs/COOP.md).
- **Same screen:** `?local2p=1` adds a second wizard (keys / second gamepad above); pick its hero
  with `?hero2=`.
- Each player has their own ink, pages, perks and Splash meter. Downed partners crawl as
  unfinished sketches: hold your light on them to reprint them. The page turns when both stand in
  the exit. Two heroes together unlock **pair combos** (Ink the Pencils, Sound & Light,
  Overprint, Speed Lines, Coloring Book, Chromatic Chorus); a combo charges both Splash meters at
  double rate for a few seconds.

## Develop

```bash
bun install
bun run dev                 # http://localhost:5173
bun run typecheck && bun run lint && bun run test
bun run build && bun run preview
bun run e2e                 # Playwright (builds + previews on :4173)
```

Dev harnesses (dev server only): `/dev/assets.html`, `/dev/audio.html` and the other `/dev/<workstream>.html` pages.

### URL flags

| Flag | Effect |
|---|---|
| `?debug=1` | lil-gui debug panel (per-system folders, tuning live-edit) |
| `?skip=1` | skip title and intro cinematic |
| `?page=1\|2\|3\|boss` | start at a page |
| `?autoplay=1` | bot plays the whole issue (implies `skip`); used by `tests/e2e/playthrough.spec.ts` |
| `?seed=N` | world seed (default 7) |
| `?lang=en\|tr` | force language |
| `?hero=inker\|penciller\|letterer\|colorist` | hero for solo runs and the bot (the co-op lobby pick wins online) |
| `?hero2=…` | player 2's hero in local 2P |
| `?local2p=1` | same-screen co-op (second wizard) |
| `?room=CODE` | join an online co-op room (invite link) · `?coop=host` opens the lobby as host |
| `?daily=1\|YYYY-MM-DD` | Daily Issue for today / a date (one shared variation + rule) |
| `?nettransport=loopback-bc`, `?netsim=rtt150,jit40,loss3` | co-op tests: same-origin tabs, simulated link |
| `?bench=1` | reserved for the perf bench (flag is parsed, no bench mode yet) |

### Assets

`bun run assets` rebuilds `public/assets` from scratch (download → retarget/compose → optimize →
credits → validate). Licences, picks and rejections: [docs/ASSET_RESEARCH.md](docs/ASSET_RESEARCH.md).
Every shipped file must be in `assets/licenses.json`; `bun run assets:validate` fails otherwise.
Credits: [CREDITS.md](CREDITS.md) (same data as the in-game Credits screen).

## Deploy

`main` deploys to GitHub Pages via `.github/workflows/pages.yml` (built with `BASE_PATH=/game/`).
To reproduce the production build locally:

```bash
BASE_PATH=/game/ bun run build && bun run preview   # → http://localhost:4173/game/
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, unit tests, asset validation, build, the JS
bundle budget and the Playwright smoke/visual suites on every push.

## Docs

[PLAN.md](PLAN.md) (design) · [docs/DECISIONS.md](docs/DECISIONS.md) · [docs/PERF.md](docs/PERF.md) ·
[docs/DEVICE_TESTS.md](docs/DEVICE_TESTS.md) · [docs/OWNERSHIP.md](docs/OWNERSHIP.md)
