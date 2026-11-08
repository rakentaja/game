# Decisions log

- 2026-11-08 — Repo lives at ~/Developer/inkwake; local git only (no remote yet). CI workflow present but not run.
- 2026-11-08 — three 0.187, Vite 8, TS 7, Biome 2, Vitest 5, Playwright 1.65 (latest at scaffold time).
- 2026-11-08 — Work split into parallel workstreams (docs/OWNERSHIP.md), each on its own branch; integrator merges into main.
- 2026-11-08 — Mixamo avoided (redistribution terms in a public web build are unclear). Animations come from CC0 sources (Quaternius UAL) or procedural.
- 2026-11-08 — Real-device perf (iPhone 12 / Pixel 6) cannot be measured by the agents; docs/PERF.md records emulation numbers and docs/DEVICE_TESTS.md carries the manual checklist.
- 2026-11-08 — LICENSE: code is "All rights reserved" until the owner picks a license.
- 2026-11-08 — [levels] LevelDef gained optional `widths` (corridors), `voids` (chasm/cliff/wall rects that override the walk until a printed sketch unlocks them), `terrain` (noise amp, bank rise, plateaus), `mist`, `mood`, `anchors`; SketchObjectDef gained `requires` (dormant until `trigger:fired {id}`). New events `trigger:fired` and `tutorial:hint`. All additive.
- 2026-11-08 — [levels] Coordinates: walk runs toward −Z (up the portrait screen), `rotY` 0 faces −Z, follow camera assumed behind at +Z. Any procedural trunk standing between that camera and the walk becomes a low stump (layout.ts `occludes`), so the player is never hidden.
- 2026-11-08 — [levels] Collision is pure math (no BVH): walk = path spine (Catmull-Rom, 0.5 m samples, bucket grid) ∪ clearings ∪ printed rects − voids; trunk/boulder circles in a 2 m grid. Positions are circle centres; `resolveCircle` slides back onto the walk, pushes out of blockers, then re-slides. three-mesh-bvh not needed.
- 2026-11-08 — [levels] Ground height is a 1 m heightfield; `groundHeight` interpolates over the exact triangles the ground mesh uses (same b–c diagonal split). Printed bridges add a flat humped deck height over chasms.
- 2026-11-08 — [levels] Ink wells refill after `world.wellRefill` s so a print can never softlock on an empty tank. Sketch progress decays (`sketch.decayPerSec`) instead of resetting when the hold breaks.
- 2026-11-08 — [levels] Checkpoints: page starts + pre-boss as planned, plus `p2_terrace` mid page 2 (longest page; the stairs print shouldn't be replayed after a death in the corridor). On respawn, spawn/music/panel-cut triggers re-arm; unprinted sketches lose progress; printed ones stay.
- 2026-11-08 — [levels] Pacing (validate.ts estimate, first-time player): page 1 ≈ 76 s + cold-open teaching, page 2 ≈ 118 s, page 3 ≈ 83 s → ≈ 4.8 min of pages. Paths 114 / 133 / 81 m.
- 2026-11-08 — [levels] Forest = procedural POC trunks merged per 24 m chunk (~10–16 chunks/page), far trees get a simplified silhouette. Typical page: ~27 colour draws in the harness, 70–190k visible tris.
- 2026-11-08 — [levels] Meshes that must skip the edge/normal pass (pencil strokes, mist) are tagged `userData.noOutline = true`; render decides how (layers in the dev stub).
