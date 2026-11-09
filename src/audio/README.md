# Audio (workstream: audio)

```ts
import { AudioEngine, installAudio } from './audio';
const audio = new AudioEngine(); // starts baking the SFX bank + music kit immediately
ctx.audio = audio;
const disposeAudio = installAudio(ctx); // unlock on first gesture + event bridge
// per frame (camera or player):
audio.setListener(listenerPos, listenerForward);
```

Events consumed (see install.ts; Idea Ledger events below): `sfx:play`, `music:intensity`, `settings:changed` (`master`/`music`/`sfx`),
`boss:phase`, `game:pause`, `state:change` (title→title, playing→explore, boss→boss,
cover/credits→cover), `enemy:spawn|revealed|died`, `page:start`, `player:respawn` (auto combat).

Extras on `AudioEngine` (not in `AudioAPI`): `playAt(id,x,y,z,vol)` (allocation-free),
`setPaused(bool)`, `duckMusic(db, s)`, `ready` (promise), `mayBeMutedBySwitch`, `meter()`.

Loops: `const stop = audio.loop('sketch_loop')` while printing, `audio.loop('eraser_sweep')` while
the boss eraser sweeps. Gameplay-relevant behaviour baked into the bank:

- `ink_pickup` played repeatedly within 0.7 s climbs a pentatonic ladder (a pickup trail plays a tune).
- `boss_roar`, `panel_stinger`, `fanfare`, `player_hurt`, `sketch_done` duck the music.
- `minGapMs` / `maxVoices` per id stop machine-gun phasing; 18 spatial + 10 flat pooled voices with
  priority-based stealing.

Harness: `bun run dev` → `/dev/audio.html` (soundboard with peak/LUFS/GR readouts and
spectrograms, music track/stem/phase controls, loops, spatial pad, master meter).

In-game behaviour added by `install()`: panel stinger on every `fx:panelCut`; combat intensity =
max(level trigger, fight heat that drains in ~6 s); boss intensity capped to the announced phase;
`sfx:play` `sketch_loop` (no position) becomes a managed loop while print progress rises.
Dev builds expose the engine as `globalThis.__inkAudio` for inspection.

## Idea Ledger (wave 1) — `ledger.ts`, `beat.ts`, `fxmath.ts`, `beds.ts`

Installed by `install()` when `ctx.audio` is the real `AudioEngine` (`installAudio(ctx, { ledger: false })`
turns it off). Tuning lives in `TUNING.audio`. Nothing runs per animation frame: work hangs off game
events or the music scheduler's step hook (`Music.onStep`, one call per scheduled 16th).

**Beat clock** — `ctx.beat` / `engine.beat` implements `BeatAPI` from the scheduler grid
(`Music.anchor` = context time of step 0, `Music.sec16`, `Music.bpm`, `Music.horizon`). "Now" is the
_audible_ context time: `getOutputTimestamp()` when available, else `currentTime − outputLatency`
(`baseLatency` on old Safari), minus `latencyOffsetMs` (from `settings.audioOffsetMs` if the UI adds it,
else `TUNING.audio.latencyOffsetMs`; re-read on `settings:changed`). `onBeat()` defaults to
`TUNING.audio.beatWindowMs`. `'audio:beat' {beat, bar, bpm}` is emitted once per beat by a single timer
aimed at that beat's audible moment.

**Quantized SFX** — `engine.playQuantized(id, grid=16, x?, y?, z?, vol?)` waits for the next 1/grid line
only if it is ≤ `quantizeMaxMs` (45) away, else plays now. `sfx:play` of `bolt_hit`, `ghost_die`, `dash`,
`panel_stinger` (and the `fx:panelCut` stinger) go through it; `sketch_done` lands on the next bar line
(if ≤ `downbeatMaxS`, else the next beat).

| Feature                 | Trigger                                                      | What it does                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unprinted Mix           | `reveal:progress {t}`, `crystal:hold`, `page:start/complete` | Music HP→LP→soft-clip + crackle bed. `engine.setReveal(0..1)`: 0 = 1940s radio, 1 = full fidelity. Holding the crystal adds a burst (+0.3). Without `reveal:progress` the page's reveal is a proxy from total crystal-hold time. Title/cover = 1, boss page starts at 0.6.                                                                  |
| Sound only in the light | every spatial play                                           | One lowpass per spatial voice, set at start from the source's distance to `ctx.reveal.center`/`radius`: 18 kHz inside → 700 Hz beyond a 3 m feather. equalpower panning unchanged.                                                                                                                                                          |
| Freeze-frame            | `fx:panelCut`                                                | `engine.freeze(hold, 8th)`: last 8th of music held in a feedback DelayNode (0.97) with the dry path muted for `panelCut.duration`, then released; one pen/stick transient per letter of `word` on 32nds.                                                                                                                                    |
| Printing riser          | `sketch:progress` (non-`editor:` ids)                        | 4-voice Shepard tone climbing with progress (updated at ~16 Hz), cut on the downbeat where `sketch_done` lands.                                                                                                                                                                                                                             |
| Ape Out drummer         | `player:dash`, `bolt:hit`, `enemy:died`                      | Snare drag / rimshot on the next 16th, crash on the next 8th, into the current track's perc stem. Hits already inside the look-ahead window are scheduled directly; later ones wait in a `HitRing` drained by the step hook. Combat heat (intensity) gates grace notes and fills.                                                           |
| Newsprint noir          | `page:start`, idle                                           | Room-tone loops per page (1 rain on paper, 2 press thump, 3 both). After `noir.idleS` (8 s) of no movement/action during explore, a muted-trumpet quote of the leitmotif on the next bar (through the radio chain).                                                                                                                         |
| Editor erases stems     | `boss:eraseStem {stem, erased}`                              | Fades `ERASE_ORDER[stem]` and pans it hard to one side (no sweep position in the event, so stems alternate L/R). Fallback if no such event arrives: phase-1 `boss:attack` drag strikes erase ostinato → texture → melody → perc, restored at phase 2.                                                                                       |
| Leitmotif pickups       | `boss:phase` 2                                               | `ink_pickup` plays A A A · D F E · D instead of the pentatonic ladder (`engine.pickup.mode`).                                                                                                                                                                                                                                               |
| Blank page              | `boss:phase` 3                                               | Every stem near-silent (drone 25 %), sub heartbeat (D1, exciter-fed) on downbeats + Android heartbeat haptic at its audible time.                                                                                                                                                                                                           |
| Fourth-wall leak        | boss state / pause                                           | Faint red-pen scratches every 2–4.5 s on `engine.bypass` (skips pause muffling), a bit louder while paused.                                                                                                                                                                                                                                 |
| Rewind                  | `player:respawn`                                             | One bar of reversed kit hits accelerating into a reversed boom + crash, music ducked for the bar.                                                                                                                                                                                                                                           |
| Haptics                 | `combat:onBeat`, `enemy:died`, blank-page beats              | `haptics.beatTick/killPattern/heartbeat` (src/core/input/haptics.ts): Android UA only, own rate limit, respects `settings.vibration`.                                                                                                                                                                                                       |
| Phone-speaker master    | always                                                       | Harmonic exciter (low band → asymmetric shaper → 180 Hz–2.5 kHz) on bass/perc/drone stems, the heartbeat and `boss_roar`; stereo side signal removed below 120 Hz (phase-exact mono bass). `/dev/audio.html` → "📱 phone speaker audition" toggles an HP 380 Hz / presence / LP 9 kHz / mono output simulation (`engine.setPhoneAudition`). |

New engine surface: `beat`, `playQuantized`, `quantizeWait`, `untilGrid`, `setReveal`/`reveal`, `setLight`,
`freeze`, `setPhoneAudition`, `pickup`, buses `musicIn`/`musicPost`/`sfxIn`/`bypass`; `playAt(…, delay)`.
`Music` gained `anchor`/`sec16`/`bpm`/`horizon`/`nextStep`/`layers`, `onStep`, `setLayerMod`/`resetLayerMods`,
`exciter`. Kit gained `snare` and `crash`; instruments gained `mutedTrumpet` and `hitReversed`.
Pure parts are unit-tested in `tests/unit/audio-ledger.test.ts`. The harness has an "Idea Ledger" row
(reveal slider, light radius, panel cut, print, dash/hit/kill, respawn, page beds, stem erase buttons).
