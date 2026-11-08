# Decisions log

- 2026-11-08 — Repo lives at ~/Developer/inkwake; local git only (no remote yet). CI workflow present but not run.
- 2026-11-08 — three 0.187, Vite 8, TS 7, Biome 2, Vitest 5, Playwright 1.65 (latest at scaffold time).
- 2026-11-08 — Work split into parallel workstreams (docs/OWNERSHIP.md), each on its own branch; integrator merges into main.
- 2026-11-08 — Mixamo avoided (redistribution terms in a public web build are unclear). Animations come from CC0 sources (Quaternius UAL) or procedural.
- 2026-11-08 — Real-device perf (iPhone 12 / Pixel 6) cannot be measured by the agents; docs/PERF.md records emulation numbers and docs/DEVICE_TESTS.md carries the manual checklist.
- 2026-11-08 — LICENSE: code is "All rights reserved" until the owner picks a license.
- 2026-11-08 — player: Gesture rules: tap <180 ms & <12 px; hold starts at 180 ms when steady, or after the 200 ms swipe window if the thumb drifts (no crystal flicker before a slow swipe); swipe fires on the move that crosses 40 px within 200 ms (before release). A quick flick while holding also dashes and keeps the crystal held.
- 2026-11-08 — player: Joystick base follows the thumb past the rim (instant reversal); radius scales with the short screen side (44–77 px).
- 2026-11-08 — player: Player writes `reveal.center` and an eased `reveal.targetRadius` every sim step (smoothstep 3→7 m over growTime, back over shrinkTime, 1.5 m dim at 0 ink, low-ink sputter). Blot suppression should set `player.radiusMul` (or multiply targetRadius after the player step).
- 2026-11-08 — player: Dash lives in Player (movement), not combat.ts: ease-out-quart over 0.25 s, reveal sources every 0.8 m, 0.12 s input buffer. Bolts in combat.ts: 0.07 s cast delay so the bolt leaves at the staff swing, 0.14 s tap buffer, soft homing. Critical = killing blow, first kill always, then 35% with ≥8 s spacing → `fx:panelCut` word 'krak'. Crit rolls use a seeded RNG for deterministic e2e.
- 2026-11-08 — player: Animation: locomotion idle/walk/run share one gait phase; cast_tap and cast_hold_loop are upper-body masked clips (Torso subtree) layered with high weight; dash = frozen Run frame (comic leap pose); the mixer is stepped at TUNING.boil.animHz. Clip names resolve via CLIP_ALIASES (`wizard@<name>` first, then Quaternius names). Walk/Run natural speeds measured from foot travel: 1.03 / 1.77 m/s.
- 2026-11-08 — player: Camera: implicit critically-damped spring, max lag 1.3 m, velocity look-ahead, boom length from pitch + distance; portrait pushes the boom back to keep 7.5 m width visible, and every orientation keeps 9.5 m ground depth. `camera.height` is unused (pitchDeg + distance define the boom). fovPortrait 42→50 so the wizard reads at phone size.
- 2026-11-08 — player: Pickups are liquid-gold drops (gold/ember/paper/ink only) to match the HUD ink bottle; enemy:died spawns `tuning.enemies[kind].inkDrop` automatically.
