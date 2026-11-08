# Decisions log

- 2026-11-08 — Repo lives at ~/Developer/inkwake; local git only (no remote yet). CI workflow present but not run.
- 2026-11-08 — three 0.187, Vite 8, TS 7, Biome 2, Vitest 5, Playwright 1.65 (latest at scaffold time).
- 2026-11-08 — Work split into parallel workstreams (docs/OWNERSHIP.md), each on its own branch; integrator merges into main.
- 2026-11-08 — Mixamo avoided (redistribution terms in a public web build are unclear). Animations come from CC0 sources (Quaternius UAL) or procedural.
- 2026-11-08 — Real-device perf (iPhone 12 / Pixel 6) cannot be measured by the agents; docs/PERF.md records emulation numbers and docs/DEVICE_TESTS.md carries the manual checklist.
- 2026-11-08 — LICENSE: code is "All rights reserved" until the owner picks a license.
- 2026-11-08 — enemies: all three kinds share ONE instanced lathe-grid mesh; the vertex shader evaluates a per-kind surface f(u,v) (smudge sheet ghost, scribbler tall robe+pencil arm, blot metaball puddle). Total enemy draw calls = 4 at any count (bodies, inverted-hull outlines sharing the same instance buffers, FX ribbons, particles).
- 2026-11-08 — enemies: own minimal reveal mask in `src/entities/enemies/glsl.ts` (center + radius + fbm edge), uniforms copied each frame from any `RevealAPI`, so render's RevealSystem works unchanged. `EnemyRendererOptions.bodyMaterial` lets render swap in `createInkMaterial({crumple, instancing})` later; it must read the aA..aD/aCell attributes documented in `bodyShader.ts`. Temporary reveal sources / history map are not mirrored in the shader (CPU `revealAt` is still used for gameplay).
- 2026-11-08 — enemies: partially revealed enemies render as pencil hatching + contour only; outline grows in only once revealed. Telegraph lines and pencil projectiles ignore the mask (graphite reads on blank paper) for fairness; shadows/tendrils/particles are masked.
- 2026-11-08 — enemies: new events `ink:drop` (pickup is ink-energy's job), `enemy:telegraph` (audio/UI cue; smudge windup, scribbler telegraph, blot latch), `wave:cleared`. First-ever reveal of a kind emits `fx:panelCut` with word keys `fx.shff` / `fx.skritch` / `fx.splotch` (ui: add i18n strings).
- 2026-11-08 — enemies: integration order — `enemies.step(dt)` after the player step (which writes `reveal.targetRadius`) and before `reveal.update(dt)`, because blots multiply the target radius down (floor `blotAi.minRadiusFactor`). Spawner groups spawns by `trigger` ('' = immediate on `load`); levels forward trigger entry via `spawner.fireTrigger(id)`.
- 2026-11-08 — enemies: hits interrupt windups/telegraphs (recoil), which is the intended skill expression. `Damageable.hit` is ignored while unrevealed per contract.
