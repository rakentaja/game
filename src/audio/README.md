# Audio (workstream: audio)

```ts
import { AudioEngine, installAudio } from './audio';
const audio = new AudioEngine(); // starts baking the SFX bank + music kit immediately
ctx.audio = audio;
const disposeAudio = installAudio(ctx); // unlock on first gesture + event bridge
// per frame (camera or player):
audio.setListener(listenerPos, listenerForward);
```

Events consumed (see install.ts): `sfx:play`, `music:intensity`, `settings:changed` (`master`/`music`/`sfx`),
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
