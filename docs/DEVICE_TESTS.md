# Device test checklist (manual)

Agents can't drive real phones, so this is run by a person before each release. Copy the
**Run log** table, fill one row per device/browser, and file anything ✗ as an issue with a screen
recording. Test URL: <https://rakentaja.github.io/game/> (or a `BASE_PATH=/game/ bun run build && bun run preview`
build on the LAN: `http://<mac-ip>:4173/game/`).

## Target matrix

| # | Platform | Browser / mode | Min. device | Priority |
|---|---|---|---|---|
| A | iOS 17+ | Safari (tab) | iPhone 12 | P0 |
| B | iOS 17+ | Installed PWA (Share → Add to Home Screen) | iPhone 12 | P0 |
| C | Android 13+ | Chrome (tab) | Pixel 6 | P0 |
| D | Android 13+ | Installed PWA (Chrome "Install app") | Pixel 6 | P0 |
| E | Android mid-range | Chrome | Galaxy A54 | P1 (≥45 fps, floor 30) |
| F | iPadOS | Safari | iPad 9th gen | P2 |
| G | macOS / Windows | Chrome, Safari, Firefox, Edge (latest) | any laptop | P1 |

## Checklist (every device)

### Boot & install
- [ ] First load on 4G (DevTools throttling on desktop): playable in < 4 s, loading bar moves smoothly, no blank frames.
- [ ] Title screen: logo prints in ink, no layout overflow in portrait **and** landscape; safe areas (notch, home bar) respected.
- [ ] Install prompt/instructions appear (Android: install button; iOS: "Add to Home Screen" hint). After install the icon + name are correct, it launches full-screen with the right splash/theme colour.
- [ ] Airplane mode after one full load: the installed app starts and plays offline (all pages + boss).
- [ ] Update: deploy a new build → app shows the "new version" toast; accepting reloads into the new version without losing settings/save.

### Audio
- [ ] Sound unlocks on the first touch (iOS: silent switch ON → note if muted, the app should hint).
- [ ] Music + SFX levels from Settings apply immediately and persist after relaunch.
- [ ] Lock the phone / switch apps mid-game: audio stops; on return it resumes, the game is paused.
- [ ] Bluetooth headphones: no crackle, no runaway latency.

### Controls (touch)
- [ ] Left-side floating stick: appears under the thumb, smooth 8-direction movement, releases cleanly.
- [ ] Right side: tap = bolt, hold = crystal (vibration pulse if enabled), swipe = dash in swipe direction.
- [ ] Two thumbs at once (move + hold crystal + tap with a third finger) never drops input.
- [ ] Left-handed mode swaps sides. No accidental browser gestures: no zoom, text selection, pull-to-refresh or back-swipe during play.
- [ ] Gamepad (Android/desktop): stick, A dash, X/B bolt, triggers crystal, Start pause.

### Gameplay flow (one full run, Normal)
- [ ] Cold open → page 1 → page turn → page 2 → page 3 → boss → cover screen, no soft-locks.
- [ ] Page 2 terrace/gate section (z ≈ −90): the gate prints and the path continues (known autoplay failure here, see PERF/CI notes).
- [ ] Death → respawn at checkpoint with pages refilled; Continue from title resumes at the last checkpoint.
- [ ] Panel cuts, page turns and boss phase transitions play once, never stack or freeze.
- [ ] Cover screen: Share (Web Share sheet on mobile) and PNG download both work; stats are plausible.
- [ ] Credits screen lists every entry in CREDITS.md (models, textures, fonts, audio, original work, three.js).
- [ ] Story difficulty is clearly easier; Reduce motion disables boil/shake/flash; no flashes > 3 Hz.
- [ ] TR language: all strings translated, nothing overflows its button.

### Performance & stability
- [ ] `?debug=1` FPS readout: iPhone 12 / Pixel 6 hold 60 fps on pages 1–3; boss ≥ 55 fps. Record p50/p95 in docs/PERF.md.
- [ ] 10-minute session: no thermal throttling to < 45 fps, no memory warning/reload (iOS kills tabs over ~1.5 GB).
- [ ] Rotate the device mid-game: canvas resizes, HUD re-lays out, no stretched frame.
- [ ] Quality Auto drops resolution under load and recovers (watch pixel ratio in the debug panel).

### Desktop specifics
- [ ] Keyboard + mouse controls (WASD, Shift/L or RMB crystal, J/Enter/LMB bolt, Space/K dash, Esc/P pause); context menu suppressed on the canvas.
- [ ] Window resize and full-screen, 4K/HiDPI: crisp lines, pixel ratio capped at 2.
- [ ] Firefox and Safari: no shader compile errors in the console.

## Run log

| Date | Tester | Device / OS | Browser / mode | Build (commit) | Result | Notes / issue links |
|---|---|---|---|---|---|---|
| | | | | | | |
