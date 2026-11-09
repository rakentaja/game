/**
 * Loopable noise beds, synthesised once into plain Float32Arrays (a few hundred ms of CPU at
 * boot, then free): the record-crackle of the Unprinted Mix and the newsprint-noir room tones.
 * Every generator writes a seamless loop (events wrap around the end).
 */
import { Rng } from './synth/dsp';

export type BedId = 'crackle' | 'rain' | 'press';

/** 78 rpm crackle: sparse clicks of random polarity + a faint band of hiss. */
function crackle(d: Float32Array, sr: number, rng: Rng): void {
  let lp = 0;
  for (let i = 0; i < d.length; i++) {
    lp += (rng.next() * 2 - 1 - lp) * 0.35;
    d[i] = lp * 0.035;
  }
  const clicks = Math.round((d.length / sr) * 38);
  for (let c = 0; c < clicks; c++) {
    const at = Math.floor(rng.next() * d.length);
    const amp = (rng.chance(0.5) ? 1 : -1) * (rng.chance(0.08) ? 0.9 : rng.range(0.08, 0.35));
    const len = Math.floor(sr * rng.range(0.0004, 0.002));
    for (let k = 0; k < len; k++) d[(at + k) % d.length]! += amp * Math.exp((-5 * k) / len);
  }
}

/** Rain on paper: soft broadband patter + individual droplet ticks on a tight page. */
function rain(d: Float32Array, sr: number, rng: Rng): void {
  let a = 0;
  let b = 0;
  for (let i = 0; i < d.length; i++) {
    const w = rng.next() * 2 - 1;
    a += (w - a) * 0.22; // ≈ 1.5 kHz lowpass
    b += (a - b) * 0.02; // remove the rumble
    d[i] = (a - b) * 0.12;
  }
  const drops = Math.round((d.length / sr) * 70);
  for (let c = 0; c < drops; c++) {
    const at = Math.floor(rng.next() * d.length);
    const f = rng.range(1800, 4200);
    const amp = rng.range(0.05, 0.22);
    const len = Math.floor(sr * rng.range(0.006, 0.02));
    for (let k = 0; k < len; k++) {
      const e = Math.exp((-6 * k) / len);
      d[(at + k) % d.length]! += amp * e * Math.sin((2 * Math.PI * f * k) / sr) * (rng.next() * 0.6 + 0.4);
    }
  }
}

/** Printing press in the next room: sub thump per beat (~92 bpm) with a dull clack. */
function press(d: Float32Array, sr: number, rng: Rng): void {
  const n = 4; // thumps per loop
  const period = d.length / n;
  for (let j = 0; j < n; j++) {
    const at = Math.floor(j * period);
    const len = Math.floor(sr * 0.32);
    const amp = j % 2 === 0 ? 0.55 : 0.4;
    let ph = 0;
    for (let k = 0; k < len; k++) {
      const f = 42 + 30 * Math.exp((-k / sr) * 30);
      ph += (2 * Math.PI * f) / sr;
      d[(at + k) % d.length]! += amp * Math.sin(ph) * Math.exp((-k / sr) * 11);
    }
    const cl = Math.floor(sr * 0.04);
    const off = Math.floor(sr * 0.012);
    let lp = 0;
    for (let k = 0; k < cl; k++) {
      lp += (rng.next() * 2 - 1 - lp) * 0.12;
      d[(at + off + k) % d.length]! += lp * 0.35 * Math.exp((-k / cl) * 5);
    }
  }
  // the room itself: very low air
  let lp = 0;
  for (let i = 0; i < d.length; i++) {
    lp += (rng.next() * 2 - 1 - lp) * 0.01;
    d[i]! += lp * 0.25;
  }
}

const GEN: Record<BedId, { secs: number; fill: (d: Float32Array, sr: number, r: Rng) => void }> = {
  crackle: { secs: 2.7, fill: crackle },
  rain: { secs: 3.3, fill: rain },
  press: { secs: (60 / 92) * 4, fill: press },
};

export function makeBed(ac: BaseAudioContext, id: BedId, seed = 0x5eed): AudioBuffer {
  const g = GEN[id];
  const sr = ac.sampleRate;
  const buf = ac.createBuffer(1, Math.round(g.secs * sr), sr);
  g.fill(buf.getChannelData(0), sr, new Rng(seed));
  return buf;
}
