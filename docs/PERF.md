# Performance log

Budgets (PLAN §8): 60 fps on iPhone 12 / Pixel 6 (≥45, floor 30 on mid Android) · initial JS
< 350 KB gzip · first download < 8 MB · first playable < 4 s on 4G · < 120 draw calls · < 200k
visible tris · ≤ 10 skinned meshes · < 64 MB textures · JS heap < 150 MB · no per-frame allocations.

Real-device numbers come from the manual pass in [DEVICE_TESTS.md](DEVICE_TESTS.md); agents only
have emulation (headless Chromium, Lighthouse throttling, SwiftShader in CI).

## Build size (every milestone)

| Date | Commit | JS gzip (bundle-size.ts) | public/assets | First load (Lighthouse, transfer) | Notes |
|---|---|---|---|---|---|
| 2026-11-08 | main 0c25090 + ws2-qa | 330.7 KB / 350 | 1.53 MB (7 files) | 773 KiB | one 326 KB JS chunk; ~43 % unused at boot (three.js core) |
| 2026-11-09 | wave 2 merge 087cf92 | 354.1 KB / 350 (over) | – | – | heroes + co-op hooks landed in the entry; 6 initial files |
| 2026-11-09 | wave 3 integration | 343.3 KB / 350 | – | – | lazy: Turkish dictionary, cover + credits, settings screen, Editor's Hand, Daily variants, ghost playback; shared entry deps merged into one `boot` chunk (3 initial files); co-op, hero kits, combos, lobby, hero HUD stay lazy |

## Frame stats (emulated)

| Date | Where | Device profile | fps p50 / p95 | Draw calls | Tris | Pixel ratio | Source |
|---|---|---|---|---|---|---|---|
| 2026-11-08 | page 1 reveal / panel cut / page turn | iPhone 14 + Pixel 7 emulation, Apple GPU (local) | 60 / – | 45–47 | 67.9k–68.9k | 1.5 | tests/e2e/visual.spec.ts stats |
| 2026-11-08 | autoplay pages 1–2 | iPhone 14 emulation, Apple GPU (local) | 60 / – | – | – | – | tests/e2e/playthrough.spec.ts log |
| 2026-11-08 | autoplay pages 1–2 | GitHub Actions, SwiftShader | 5–6 | – | – | – | CI run 42438717582 (software GL; not representative) |

## Real devices (fill from DEVICE_TESTS.md)

| Date | Device | Browser / mode | Page | fps p50 / p95 | Quality (auto →) | Heap | Notes |
|---|---|---|---|---|---|---|---|
| | iPhone 12 | Safari | 1 / 2 / 3 / boss | | | | |
| | Pixel 6 | Chrome | 1 / 2 / 3 / boss | | | | |
| | Galaxy A54 | Chrome | 1 / 2 / 3 / boss | | | | |

## Lighthouse 12.8.2 — 2026-11-08

Target: `https://rakentaja.github.io/game/` (production, gzip by Pages) and a local
`BASE_PATH=/game/ bun run build && vite preview` (no compression). Lighthouse 12 no longer has a
PWA category; installability/offline were checked separately (below).

| Run | Perf | A11y | Best practices | SEO | FCP | LCP | TBT | CLS | SI |
|---|---|---|---|---|---|---|---|---|---|
| Live, mobile (Moto G Power, slow 4G, 4× CPU) | 74 | 92 | 96 | 90 | 3.2 s | 5.4 s | 10 ms | 0.011 | 3.2 s |
| Live, desktop | 83 | 92 | 100 | 90 | 0.8 s | 0.8 s | 320 ms | 0.009 | 1.6 s |
| Local preview, mobile (uncompressed, headless SwiftShader) | 35 | 92 | 96 | 90 | 6.6 s | 10.4 s | 1,230 ms | 0.011 | 6.6 s |

The local preview run is pessimistic: `vite preview` doesn't gzip (Lighthouse flags 194 KiB of
compressible text that Pages already compresses), and GPU work runs on the CPU.

### PWA / offline check (Playwright against the live site)

- Service worker registers under `/game/`, Workbox precache holds 42 entries: JS/CSS, fonts, every GLB,
  manifest.json and credits.json.
- Offline reload after the first visit boots straight to the title ("Click to start reading").
- `paper_grain*.webp` isn't precached (globPatterns has no `webp`), but nothing in the game loads
  it yet; add `webp` if render starts using it.

### Findings and owners

| # | Finding | Impact | Owner | Suggested fix |
|---|---|---|---|---|
| 1 | LCP 5.4 s on mobile: the LCP element is the loading screen's "tap" line, which waits for the single 326 KB JS chunk | first-playable budget (< 4 s) missed on slow 4G | integrator / render | split three.js + game into a lazy chunk behind a tiny HTML/CSS loading screen; inline critical CSS |
| 2 | ~137 KiB unused JS at boot (three.js core, examples) | parse/compile time on low-end phones | integrator | `manualChunks` for three, dynamic-import dev/debug-only code (lil-gui, harness helpers) |
| 3 | No `<meta name="description">` | SEO 90 | integrator (index.html) | add a one-line description |
| 4 | `.loading-issue` text 11.9 px (59 % of text below 12 px on the loading screen) | legibility audit | ui | ≥ 12 px |
| 5 | `aria-allowed-role`: `section.ui-screen` carries a role not allowed on `<section>` | a11y 92 | ui | use `<div role="dialog">` or drop the role |
| 6 | `user-scalable=no` / `maximum-scale` in the viewport meta | a11y audit flag | integrator | intentional for a touch game (prevents pinch-zoom mid-play); keep and document |
| 7 | Manifest `"id": "/"` with `scope`/`start_url` `./` under `/game/` | the PWA identity is the whole `rakentaja.github.io` origin root; it collides with any other app installed from that origin | ui (public/manifest.webmanifest) | `"id": "./"` (resolves to `/game/`) |
| 8 | Credits modal: title-screen logo and buttons paint **over** the Credits dialog at 412 px width | Credits unreadable on phones (PLAN §10) | ui | z-index / hide the title layer while a modal is open |
| 9 | Autoplay bot dies in a loop at the page-2 gate (`p2_gate`, z ≈ −90) and never prints it; reproduces at 60 fps locally, so it isn't a CI frame-rate artefact | full-run e2e can't complete; maybe a real difficulty spike at the gate ambush | player (autoplay) + levels | check gate print time vs. ambush damage; the bot should clear the ambush before printing |

---

# Render performance notes

Budgets (PLAN §8): 60 fps on iPhone 12 / Pixel 6 class, < 120 draw calls, < 200k triangles,
adaptive pixel ratio 1.0–2.0.

## How to measure

`/?page=1|2|3|boss&bench=1` runs a 30 s camera tour along the page's path at the game-camera angle
(2 s warm-up, god mode on, reveal pulsing between idle and held radius). The result is logged as
`[bench] {...}` and published on `<html data-bench="…">`. `?debug=1` shows a live overlay
(fps, frame ms, worst frame, draws, tris, pixel ratio).

## M2 / wave 2 — emulation (2026-11-08)

Playwright Chromium with device emulation on a desktop GPU (ANGLE/Metal), **not a phone**:
frame times are vsync-capped, so they show regressions and budget counts, not device headroom.

| Device (emulated) | Page | avg ms | p50 | p95 | p99 | draws avg / max | tris avg / max | PR |
|---|---|---|---|---|---|---|---|---|
| iPhone 14 | 1 | 17.03 | 16.7 | 16.7 | 16.8 | 37 / 40 | 94k / 109k | 1.75 |
| iPhone 14 | 2 | 17.06 | 16.7 | 16.7 | 16.8 | 39 / 42 | 120k / 133k | 1.75 |
| iPhone 14 | 3 | 17.27 | 16.7 | 16.8 | 33.3 | 36 / 39 | 81k / 90k | 1.375 |
| iPhone 14 | boss | 16.82 | 16.7 | 16.8 | 16.8 | 60 / 61 | 92k / 94k | 1.625 |
| Pixel 7 | 2 | 17.20 | 16.7 | 16.7 | 16.8 | 39 / 42 | 119k / 133k | 1.625 |

Panel cuts (0.6 s, sim frozen) cost about one extra scene per close-up. Measured peak while one
is on screen, after the 3→2 panel budget guard:

| Page | steady draws / tris | during panel cut |
|---|---|---|
| 1 | 39 / 97k | 71 / 174k |
| 2 | 41 / 114k | 73 / 208k |
| 3 | 38 / 82k | 95 / 206k |
| boss | 61 / 94k | 115 / 171k |

Before the guard the worst cut was 169 draws (boss) and 412k tris (page 2).

### Where the cost is
- Page 2: 22 merged forest chunks = 178k of the scene's tris (levels). Chunks are large, so
  neither frustum nor close-up culling drops them; finer chunks or a LOD would buy the most.
- Boss: 26 always-drawn Editor parts + outlines (`frustumCulled = false`), the largest draw
  count; frustum culling the parts would roughly halve it.

## Real devices

Still owed: iPhone 12 / Pixel 6 class and a mid-range Android (e.g. Galaxy A54), same bench URL.
(docs/DEVICE_TESTS.md, PLAN §0, is not written yet.)

| Device | Page | avg ms | p95 | p99 | draws max | tris max | PR | notes |
|---|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | — | not measured yet |
