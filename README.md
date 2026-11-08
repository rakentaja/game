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

## Controls

| Action | Touch | Keyboard / mouse | Gamepad |
|---|---|---|---|
| Move | drag on the left half (floating stick) | WASD / arrows | left stick |
| Crystal (hold) | press and hold on the right half | Shift or L, or hold right mouse button | any trigger / RB |
| Ink bolt | tap on the right half | J / Enter / left click | X or B |
| Dash | swipe on the right half | Space / K | A |
| Pause | ⏸ button | Esc / P | Start |

Left-handed mode (Settings) swaps the touch sides. Settings also cover volume, vibration, reduce
motion, misregistration, quality (Auto/Low/High), language (EN/TR) and difficulty (Story/Normal).

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
