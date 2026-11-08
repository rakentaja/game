# Performance

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
