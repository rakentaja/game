# Workstream ownership

Parallel workstreams each own a set of paths. Only the owner edits them; others consume the
contracts in `src/core/types.ts` / `src/core/events.ts`. Shared files (`src/main.ts`,
`src/data/tuning.ts`, `src/core/*`) may get **additive** edits from anyone; keep them small to
merge cleanly. `src/main.ts` integration is done by the integrator (main session).

| Workstream | Owns |
|---|---|
| assets | `docs/ASSET_RESEARCH.md`, `assets/**`, `scripts/**` (except bundle-size.ts), `public/assets/**`, `CREDITS.md`, `src/world/assets.ts` (loader + manifest) |
| render | `src/render/**`, `src/fx/**`, `tests/e2e/visual.spec.ts` |
| player | `src/core/input/**`, `src/entities/Player.ts`, `src/render/../world/camera.ts` → `src/world/camera.ts`, `src/systems/ink-energy.ts`, `src/systems/combat.ts`, `src/debug/autoplay.ts` |
| enemies | `src/entities/enemies/**`, `src/systems/ai/**`, `src/systems/spawner.ts`, `src/systems/targets.ts` |
| levels | `src/world/**` (except camera.ts, assets.ts), `src/systems/sketch-objects.ts`, `src/systems/checkpoints.ts`, `src/systems/triggers.ts` |
| boss | `src/entities/Editor/**` |
| audio | `src/audio/**`, `public/audio/**` |
| ui | `src/ui/**`, `public/icons/**`, `public/manifest.webmanifest`, `src/core/pwa.ts` |
