/**
 * Audio dev harness (/dev/audio.html): soundboard with per-variant mastering readouts and
 * spectrograms, music track/stem/phase controls, loops, spatial test pad, master meters.
 * Everything goes through install() + the event bus, exactly like the game.
 */
import { Vector3 } from 'three';
import { AudioEngine } from '../audio/AudioEngine';
import { install } from '../audio/install';
import { gainToDb } from '../audio/mix';
import { bossPhase } from '../audio/music/tracks';
import type { BakedSfx } from '../audio/synth/bake';
import { SFX, SFX_IDS } from '../audio/synth/sfx';
import { EventBus, type GameEvents } from '../core/events';
import { DEFAULT_SETTINGS, type GameContext, type SfxId } from '../core/types';
import { PAL } from '../data/palette';

const css = `
:root{color-scheme:dark}
body{margin:0;background:${PAL.void};color:${PAL.paper};font:14px/1.4 ui-monospace,Menlo,monospace;padding:16px;max-width:1100px;margin-inline:auto}
h1{font:700 22px/1 Georgia,serif;letter-spacing:.06em;margin:4px 0 2px;color:${PAL.glowCore}}
h2{font:700 13px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.14em;color:${PAL.red[3]};margin:22px 0 10px;border-bottom:1px solid ${PAL.staff[2]};padding-bottom:6px}
.sub{color:${PAL.ghost[1]};margin-bottom:12px}
button{font:inherit;background:${PAL.staff[1]};color:${PAL.paper};border:1px solid ${PAL.staff[3]};border-radius:6px;padding:7px 10px;cursor:pointer}
button:hover{background:${PAL.staff[2]}}
button.on{background:${PAL.teal[2]};border-color:${PAL.teal[3]}}
button.big{font-size:16px;padding:12px 18px;background:${PAL.red[1]};border-color:${PAL.red[2]}}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
.card{background:${PAL.staff[1]};border:1px solid ${PAL.staff[2]};border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px}
.card button{width:100%;text-align:left}
.meta{font-size:11px;color:${PAL.ghost[1]}}
.warn{color:${PAL.glowEdge}}
canvas{width:100%;border-radius:4px;background:${PAL.ink};display:block}
label{display:flex;gap:8px;align-items:center;min-width:240px}
input[type=range]{flex:1;accent-color:${PAL.glowEdge}}
#pad{max-width:420px;aspect-ratio:1;cursor:crosshair;touch-action:none}
.meter{height:10px;background:${PAL.ink};border-radius:5px;overflow:hidden;flex:1;min-width:160px}
.meter>i{display:block;height:100%;background:linear-gradient(90deg,${PAL.teal[2]},${PAL.glowCore} 80%,${PAL.glowEdge})}
`;

const style = document.createElement('style');
style.textContent = css;
document.head.append(style);
const root = document.getElementById('root')!;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props) as HTMLElementTagNameMap[K];
  e.append(...kids);
  return e;
}

const bakedInfo = new Map<SfxId, BakedSfx[]>();
const cards = new Map<SfxId, { meta: HTMLElement; canvas: HTMLCanvasElement }>();

const events = new EventBus<GameEvents>();
const settings = { ...DEFAULT_SETTINGS };
const engine = new AudioEngine({
  onBaked: (b) => {
    const id = b.id as SfxId;
    const list = bakedInfo.get(id) ?? [];
    list.push(b);
    bakedInfo.set(id, list);
    updateCard(id);
    progress.textContent = `baked ${[...bakedInfo.values()].reduce((s, l) => s + l.length, 0)} / ${SFX_IDS.reduce((s, id) => s + SFX[id].variants, 0)} variants`;
  },
});
(window as unknown as { __audio: AudioEngine }).__audio = engine;
const ctx = { events, settings, audio: engine } as unknown as GameContext;
install(ctx, { autoMusic: false });

// ───────────────────────────── header
const status = el('span', { className: 'meta' });
const progress = el('span', { className: 'meta' });
const startBtn = el('button', { className: 'big', textContent: '▶ Unlock audio' });
startBtn.onclick = async () => {
  await engine.unlock();
  refreshStatus();
};
const refreshStatus = () => {
  status.textContent = `context: ${engine.state} · ${engine.ac.sampleRate} Hz · base latency ${(engine.ac.baseLatency * 1000).toFixed(1)} ms${engine.mayBeMutedBySwitch ? ' · iOS: silent switch mutes' : ''}`;
};
engine.ac.addEventListener('statechange', refreshStatus);
refreshStatus();
const t0 = performance.now();
void engine.ready.then(() => {
  progress.textContent += ` · all ready in ${((performance.now() - t0) / 1000).toFixed(2)} s`;
});

root.append(
  el('h1', { textContent: 'INKWAKE · audio' }),
  el('div', {
    className: 'sub',
    textContent: 'Procedural SFX bank + generative score. Tap unlock first (iOS/Chrome autoplay rules).',
  }),
  el('div', { className: 'row' }, startBtn, status),
  el('div', { className: 'row' }, progress),
);

// ───────────────────────────── meters
const meterBar = el('i');
const meterTxt = el('span', { className: 'meta', textContent: '—' });
root.append(
  el('h2', { textContent: 'Master' }),
  el('div', { className: 'row' }, el('div', { className: 'meter' }, meterBar), meterTxt),
);
const an = engine.meter();
const buf = new Float32Array(an.fftSize);
let peakHold = -96;
let peakHoldAt = 0;
let maxPeak = -96;
const rmsWin: number[] = [];
function meterLoop(now: number) {
  an.getFloatTimeDomainData(buf);
  let pk = 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]!);
    if (a > pk) pk = a;
    sum += buf[i]! * buf[i]!;
  }
  const pdb = gainToDb(pk);
  const rdb = gainToDb(Math.sqrt(sum / buf.length));
  rmsWin.push(sum / buf.length);
  if (rmsWin.length > 180) rmsWin.shift();
  const st = gainToDb(Math.sqrt(rmsWin.reduce((s, v) => s + v, 0) / rmsWin.length));
  if (pdb > peakHold || now - peakHoldAt > 1500) {
    peakHold = pdb;
    peakHoldAt = now;
  }
  maxPeak = Math.max(maxPeak, pdb);
  meterBar.style.width = `${Math.max(0, Math.min(100, ((rdb + 60) / 60) * 100))}%`;
  meterTxt.textContent = `peak ${peakHold.toFixed(1)} dBFS · RMS ${rdb.toFixed(1)} · 3 s RMS ${st.toFixed(1)} · session max ${maxPeak.toFixed(1)}`;
  requestAnimationFrame(meterLoop);
}
requestAnimationFrame(meterLoop);

// ───────────────────────────── soundboard
root.append(el('h2', { textContent: 'SFX (mastered: peak ≤ -1 dBFS, loudness → target)' }));
const grid = el('div', { className: 'grid' });
root.append(grid);
for (const id of SFX_IDS) {
  const r = SFX[id];
  const btn = el('button', { textContent: `${r.loop ? '⟳ ' : '▶ '}${id}` });
  const meta = el('div', { className: 'meta', textContent: 'baking…' });
  const canvas = el('canvas', { width: 480, height: 90 });
  btn.onclick = () => {
    if (r.loop) {
      const on = btn.classList.toggle('on');
      if (on) loopStops.set(id, engine.loop(id));
      else {
        loopStops.get(id)?.();
        loopStops.delete(id);
      }
    } else events.emit('sfx:play', { id });
  };
  grid.append(el('div', { className: 'card' }, btn, meta, canvas));
  cards.set(id, { meta, canvas });
}
const loopStops = new Map<SfxId, () => void>();

function updateCard(id: SfxId): void {
  const c = cards.get(id);
  const list = bakedInfo.get(id);
  if (!c || !list?.length) return;
  const r = SFX[id];
  const worst = Math.max(...list.map((b) => b.peakDb));
  const lufs = list.map((b) => b.lufs.toFixed(1)).join('/');
  c.meta.innerHTML = `${list.length}/${r.variants} var · ${list[0]!.buffer.duration.toFixed(2)} s · ${list[0]!.buffer.numberOfChannels === 2 ? 'stereo' : 'mono'} · peak <b class="${worst > -0.99 ? 'warn' : ''}">${worst.toFixed(1)}</b> dBFS · ${lufs} LUFS (target ${r.lufs}) · GR ${Math.min(...list.map((b) => b.grDb)).toFixed(1)} dB · ${list.reduce((s, b) => s + b.renderMs, 0).toFixed(0)} ms`;
  drawSpectrogram(c.canvas, list[0]!.buffer);
}

/** Log-frequency spectrogram (radix-2 FFT, 1024, hop 256) — sanity view of each recipe. */
function drawSpectrogram(cv: HTMLCanvasElement, b: AudioBuffer): void {
  const g = cv.getContext('2d')!;
  const W = cv.width;
  const H = cv.height;
  const d = b.getChannelData(0);
  const N = 1024;
  const cols = W;
  const hop = Math.max(1, Math.floor((d.length - N) / cols));
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const img = g.createImageData(W, H);
  const fs = b.sampleRate;
  const fMin = 40;
  const fMax = Math.min(16000, fs / 2);
  for (let x = 0; x < cols; x++) {
    const off = x * hop;
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
      re[i] = (d[off + i] ?? 0) * w;
      im[i] = 0;
    }
    fft(re, im);
    for (let y = 0; y < H; y++) {
      const f = fMin * (fMax / fMin) ** (1 - y / (H - 1));
      const k = Math.min(N / 2 - 1, Math.round((f / fs) * N));
      const mag = Math.hypot(re[k]!, im[k]!) / (N / 4);
      const db = gainToDb(mag);
      const v = Math.max(0, Math.min(1, (db + 80) / 80));
      const p = (y * W + x) * 4;
      img.data[p] = 22 + v * 224;
      img.data[p + 1] = 16 + v * v * 179;
      img.data[p + 2] = 14 + v * v * v * 76;
      img.data[p + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // waveform overlay
  g.strokeStyle = 'rgba(105,161,151,.8)';
  g.beginPath();
  const step = Math.max(1, Math.floor(d.length / W));
  for (let x = 0; x < W; x++) {
    let mx = 0;
    for (let i = x * step; i < (x + 1) * step && i < d.length; i++) mx = Math.max(mx, Math.abs(d[i]!));
    g.moveTo(x + 0.5, H / 2 - (mx * H) / 2);
    g.lineTo(x + 0.5, H / 2 + (mx * H) / 2);
  }
  g.globalAlpha = 0.35;
  g.stroke();
  g.globalAlpha = 1;
}

function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a]! += tr;
        im[a]! += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

// ───────────────────────────── music
root.append(el('h2', { textContent: 'Music' }));
const trackRow = el('div', { className: 'row' });
const trackBtns: HTMLButtonElement[] = [];
for (const t of ['title', 'explore', 'boss', 'cover', null] as const) {
  const b = el('button', { textContent: t ?? '■ stop' });
  b.onclick = async () => {
    await engine.unlock();
    engine.setMusic(t);
    for (const x of trackBtns) x.classList.toggle('on', x === b && t !== null);
  };
  trackBtns.push(b);
  trackRow.append(b);
}
root.append(trackRow);

function slider(label: string, value: number, on: (v: number) => void): HTMLLabelElement {
  const out = el('span', { className: 'meta', textContent: value.toFixed(2) });
  const input = el('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(value) });
  input.oninput = () => {
    out.textContent = Number(input.value).toFixed(2);
    on(Number(input.value));
  };
  (input as unknown as { set: (v: number) => void }).set = (v: number) => {
    input.value = String(v);
    out.textContent = v.toFixed(2);
  };
  return el('label', {}, `${label}`, input, out);
}

const stemRow = el('div', { className: 'row' });
const exploreS = slider('explore', 0.5, (v) =>
  events.emit('music:intensity', { layer: 'explore', level: v }),
);
const combatS = slider('combat', 0, (v) => events.emit('music:intensity', { layer: 'combat', level: v }));
const bossS = slider('boss', 0.34, (v) => {
  events.emit('music:intensity', { layer: 'boss', level: v });
  phaseLbl.textContent = `phase ${bossPhase(v) || 1}`;
});
const phaseLbl = el('span', { className: 'meta', textContent: 'phase 1' });
stemRow.append(exploreS, combatS, bossS);
const phaseRow = el(
  'div',
  { className: 'row' },
  el('span', { className: 'meta', textContent: 'boss phase:' }),
);
for (const ph of [1, 2, 3] as const) {
  const b = el('button', { textContent: `phase ${ph}` });
  b.onclick = () => {
    events.emit('boss:phase', { phase: ph });
    const lvl = [0.34, 0.67, 1][ph - 1]!;
    (bossS.querySelector('input') as unknown as { set: (v: number) => void }).set(lvl);
    phaseLbl.textContent = `phase ${ph}`;
  };
  phaseRow.append(b);
}
phaseRow.append(phaseLbl);
const pauseBtn = el('button', { textContent: 'pause menu' });
pauseBtn.onclick = () => events.emit('game:pause', { paused: pauseBtn.classList.toggle('on') });
const fanBtn = el('button', { textContent: 'victory → cover' });
fanBtn.onclick = async () => {
  await engine.unlock();
  events.emit('sfx:play', { id: 'fanfare' });
  setTimeout(() => engine.setMusic('cover'), 3200);
};
phaseRow.append(pauseBtn, fanBtn);
root.append(stemRow, phaseRow);

// ───────────────────────────── Idea Ledger
root.append(el('h2', { textContent: 'Idea Ledger' }));
const phoneBtn = el('button', { textContent: '📱 phone speaker audition' });
phoneBtn.onclick = () => engine.setPhoneAudition(phoneBtn.classList.toggle('on'));
const beatTxt = el('span', { className: 'meta', textContent: 'beat —' });
events.on('audio:beat', (b) => {
  beatTxt.textContent = `beat ${b.beat} · bar ${b.bar} · ${b.bpm} bpm · offset ${engine.beat.offsetMs().toFixed(0)} ms`;
});
const light = { center: { x: 0, z: 0 }, radius: 4 };
engine.setLight(light);
const revealS = slider('reveal (unprinted→inked)', 1, (v) => events.emit('reveal:progress', { t: v }));
const lightS = slider('crystal light radius /10 m', 0.4, (v) => {
  light.radius = v * 10;
});
const ledgerBtns: [string, () => void][] = [
  ['panel cut "KRAK"', () => events.emit('fx:panelCut', { word: 'krak', focus: [0, 0, 0], reason: 'dev' })],
  [
    'print sketch (riser)',
    () => {
      let t = 0;
      const id = `dev:${Math.random()}`;
      const h = setInterval(() => {
        t += 0.02;
        events.emit('sketch:progress', { id, t: Math.min(1, t) });
        if (t >= 1) {
          clearInterval(h);
          events.emit('sketch:printed', { id });
          events.emit('sfx:play', { id: 'sketch_done' });
        }
      }, 50);
    },
  ],
  ['dash', () => events.emit('player:dash', { from: [0, 0, 0], to: [3, 0, 0] })],
  ['bolt hit', () => events.emit('bolt:hit', { enemyId: 1, position: [0, 0, 0], critical: false })],
  ['kill', () => events.emit('enemy:died', { id: 1, kind: 'smudge', position: [0, 0, 0] })],
  ['respawn (rewind)', () => events.emit('player:respawn', { checkpointId: 'dev' })],
  ['page 1 (rain)', () => events.emit('page:start', { page: 1 })],
  ['page 2 (press)', () => events.emit('page:start', { page: 2 })],
  ['boss drag strike', () => events.emit('boss:attack', { kind: 'drag', stage: 'strike' })],
  ['on-beat tick', () => events.emit('combat:onBeat', { action: 'bolt' })],
];
const ledgerRow = el('div', { className: 'row' }, phoneBtn);
for (const [label, fn] of ledgerBtns) {
  const b = el('button', { textContent: label });
  b.onclick = async () => {
    await engine.unlock();
    fn();
  };
  ledgerRow.append(b);
}
const eraseRow = el(
  'div',
  { className: 'row' },
  el('span', { className: 'meta', textContent: 'erase stem:' }),
);
for (let i = 0; i < 8; i++) {
  const b = el('button', { textContent: String(i) });
  b.onclick = () => events.emit('boss:eraseStem', { stem: i, erased: b.classList.toggle('on') });
  eraseRow.append(b);
}
root.append(ledgerRow, el('div', { className: 'row' }, revealS, lightS, beatTxt), eraseRow);

// ───────────────────────────── volumes
root.append(el('h2', { textContent: 'Settings buses (square-law faders)' }));
const volRow = el('div', { className: 'row' });
for (const k of ['master', 'music', 'sfx'] as const) {
  volRow.append(
    slider(k, settings[k], (v) => {
      settings[k] = v;
      events.emit('settings:changed', { key: k });
    }),
  );
}
root.append(volRow);

// ───────────────────────────── spatial
root.append(
  el('h2', {
    textContent:
      'Spatial (equal-power panner, inverse distance) — click to place, listener at centre facing up',
  }),
);
const pad = el('canvas', { id: 'pad', width: 420, height: 420 });
const spatialSel = el('select');
for (const id of [
  'bolt_hit',
  'ghost_die',
  'step_stone',
  'ghost_reveal',
  'blot_drain',
  'scribble_fire',
] as SfxId[]) {
  spatialSel.append(el('option', { value: id, textContent: id }));
}
const orbitBtn = el('button', { textContent: 'orbit test' });
root.append(el('div', { className: 'row' }, spatialSel, orbitBtn), pad);
const listenerPos = new Vector3(0, 0, 0);
const listenerFwd = new Vector3(0, 0, -1);
engine.setListener(listenerPos, listenerFwd);
const R = 20; // metres from centre to edge
const dots: { x: number; z: number; t: number }[] = [];
function drawPad() {
  const g = pad.getContext('2d')!;
  g.fillStyle = PAL.ink;
  g.fillRect(0, 0, 420, 420);
  g.strokeStyle = PAL.staff[2];
  for (const r of [3, 10, 20]) {
    g.beginPath();
    g.arc(210, 210, (r / R) * 210, 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = PAL.glowCore;
  g.beginPath();
  g.moveTo(210, 198);
  g.lineTo(202, 218);
  g.lineTo(218, 218);
  g.fill();
  const now = performance.now();
  for (const d of dots) {
    const a = Math.max(0, 1 - (now - d.t) / 800);
    if (a <= 0) continue;
    g.fillStyle = `rgba(226,121,78,${a})`;
    g.beginPath();
    g.arc(210 + (d.x / R) * 210, 210 + (d.z / R) * 210, 7, 0, Math.PI * 2);
    g.fill();
  }
  requestAnimationFrame(drawPad);
}
requestAnimationFrame(drawPad);
function spatialAt(x: number, z: number) {
  dots.push({ x, z, t: performance.now() });
  if (dots.length > 30) dots.shift();
  events.emit('sfx:play', { id: spatialSel.value as SfxId, position: [x, 0, z] });
}
pad.onpointerdown = async (e) => {
  await engine.unlock();
  const r = pad.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width - 0.5) * 2 * R;
  const z = ((e.clientY - r.top) / r.height - 0.5) * 2 * R;
  spatialAt(x, z);
};
let orbit: ReturnType<typeof setInterval> | null = null;
orbitBtn.onclick = async () => {
  await engine.unlock();
  if (orbit) {
    clearInterval(orbit);
    orbit = null;
    orbitBtn.classList.remove('on');
    return;
  }
  orbitBtn.classList.add('on');
  let a = 0;
  orbit = setInterval(() => {
    a += Math.PI / 6;
    spatialAt(Math.cos(a) * 6, Math.sin(a) * 6);
  }, 350);
};

// ───────────────────────────── combat auto-intensity demo
root.append(el('h2', { textContent: 'Event bridge: enemy spawn/reveal/death → auto combat intensity' }));
let nextEnemy = 1;
const live: number[] = [];
const spawnBtn = el('button', { textContent: '+ spawn & reveal smudge' });
const killBtn = el('button', { textContent: '× kill one' });
const combatTxt = el('span', { className: 'meta' });
const showCombat = () => {
  combatTxt.textContent = `alive ${live.length} → combat ${engine.music.intensity.combat.toFixed(2)}`;
  (combatS.querySelector('input') as unknown as { set: (v: number) => void }).set(
    engine.music.intensity.combat,
  );
};
spawnBtn.onclick = () => {
  const id = nextEnemy++;
  live.push(id);
  events.emit('enemy:spawn', { id, kind: 'smudge' });
  events.emit('enemy:revealed', { id, kind: 'smudge', first: true });
  events.emit('sfx:play', { id: 'ghost_reveal', position: [(Math.random() - 0.5) * 12, 0, -4] });
  showCombat();
};
killBtn.onclick = () => {
  const id = live.pop();
  if (id === undefined) return;
  events.emit('enemy:died', { id, kind: 'smudge', position: [0, 0, -3] });
  events.emit('sfx:play', { id: 'ghost_die', position: [(Math.random() - 0.5) * 8, 0, -3] });
  showCombat();
};
root.append(el('div', { className: 'row' }, spawnBtn, killBtn, combatTxt));
