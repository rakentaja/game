/**
 * Live instruments for the generative score. Each call schedules one note/chord at audio time
 * `t` on `dest`. Nodes are one-shot by Web Audio design (sources can't restart), so a note costs a
 * handful of nodes created on the scheduler tick (every 25 ms), never per animation frame.
 */
import { midiToHz, warmWave } from '../synth/dsp';
import type { Kit, KitId } from './kit';

export class Instruments {
  private ac: AudioContext;
  private kit: Kit | null = null;
  private rr = 0;
  constructor(ac: AudioContext) {
    this.ac = ac;
  }
  setKit(k: Kit): void {
    this.kit = k;
  }
  get ready(): boolean {
    return this.kit !== null;
  }

  /** Warm detuned pad; filter breathes open across the chord. */
  pad(dest: AudioNode, t: number, notes: readonly number[], dur: number, vel: number, bright = 1400): void {
    const ac = this.ac;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.6;
    lp.frequency.setValueAtTime(bright * 0.35, t);
    lp.frequency.linearRampToValueAtTime(bright, t + dur * 0.55);
    lp.frequency.linearRampToValueAtTime(bright * 0.55, t + dur + 2);
    const g = ac.createGain();
    const atk = Math.min(1.4, dur * 0.4);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel / Math.sqrt(notes.length), t + atk);
    g.gain.setValueAtTime(vel / Math.sqrt(notes.length), t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 2.2);
    const wave = warmWave(ac, 1.35, 24);
    for (const m of notes) {
      for (const det of [-9, 8]) {
        const o = ac.createOscillator();
        o.setPeriodicWave(wave);
        o.frequency.value = midiToHz(m);
        o.detune.value = det + (this.rand() - 0.5) * 4;
        o.connect(lp);
        o.start(t);
        o.stop(t + dur + 2.3);
      }
    }
    lp.connect(g);
    g.connect(dest);
  }

  /** Wordless "aah" choir: saw voices with vibrato through one shared formant bank. */
  choir(dest: AudioNode, t: number, notes: readonly number[], dur: number, vel: number): void {
    const ac = this.ac;
    const sum = ac.createGain();
    sum.gain.value = 1 / Math.sqrt(notes.length);
    const wave = warmWave(ac, 0.95, 40);
    for (const m of notes) {
      const o = ac.createOscillator();
      o.setPeriodicWave(wave);
      o.frequency.value = midiToHz(m);
      o.detune.value = (this.rand() - 0.5) * 10;
      const lfo = ac.createOscillator();
      lfo.frequency.value = 4.6 + this.rand() * 0.8;
      const lg = ac.createGain();
      lg.gain.value = 7;
      lfo.connect(lg);
      lg.connect(o.detune);
      o.connect(sum);
      o.start(t);
      lfo.start(t);
      o.stop(t + dur + 2);
      lfo.stop(t + dur + 2);
    }
    const out = ac.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(vel, t + Math.min(1, dur * 0.4));
    out.gain.setValueAtTime(vel, t + dur);
    out.gain.linearRampToValueAtTime(0, t + dur + 1.8);
    for (const [f, q, a] of [
      [720, 7, 1],
      [1150, 8, 0.55],
      [2600, 9, 0.22],
    ] as const) {
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = q;
      const fg = ac.createGain();
      fg.gain.value = a * 3;
      sum.connect(bp);
      bp.connect(fg);
      fg.connect(out);
    }
    out.connect(dest);
  }

  /** Music box / celesta: bell partials + a pin click. */
  musicBox(dest: AudioNode, t: number, m: number, vel: number, decay = 1.8): void {
    const ac = this.ac;
    const f = midiToHz(m);
    const g = ac.createGain();
    g.gain.value = vel;
    for (const [ratio, a, d] of [
      [1, 1, 1],
      [3.0, 0.16, 0.35],
      [5.93, 0.06, 0.15],
    ] as const) {
      const o = ac.createOscillator();
      o.frequency.value = f * ratio;
      const pg = ac.createGain();
      pg.gain.setValueAtTime(0, t);
      pg.gain.linearRampToValueAtTime(a, t + 0.003);
      pg.gain.setTargetAtTime(0, t + 0.003, (decay * d) / 4.6);
      o.connect(pg);
      pg.connect(g);
      o.start(t);
      o.stop(t + decay * d + 0.1);
    }
    g.connect(dest);
    this.hit(dest, 'pin', t, vel * 0.25, 1);
  }

  /** Plucked / staccato string: warm saw with a fast closing filter. */
  pluck(dest: AudioNode, t: number, m: number, dur: number, vel: number, bright = 2400): void {
    const ac = this.ac;
    const o = ac.createOscillator();
    o.setPeriodicWave(warmWave(ac, 1.1, 32));
    o.frequency.value = midiToHz(m);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 2;
    lp.frequency.setValueAtTime(bright, t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(120, bright * 0.12), t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.004);
    g.gain.setTargetAtTime(0, t + 0.004, dur / 3);
    o.connect(lp);
    lp.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + dur * 2 + 0.05);
  }

  /** Round sub bass. */
  bass(dest: AudioNode, t: number, m: number, dur: number, vel: number): void {
    const ac = this.ac;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.01);
    g.gain.setTargetAtTime(vel * 0.6, t + 0.01, 0.12);
    g.gain.setTargetAtTime(0, t + dur, 0.06);
    for (const [type, mul, a] of [
      ['sine', 1, 1],
      ['triangle', 2, 0.25],
    ] as const) {
      const o = ac.createOscillator();
      o.type = type;
      o.frequency.value = midiToHz(m) * mul;
      const og = ac.createGain();
      og.gain.value = a;
      o.connect(og);
      og.connect(g);
      o.start(t);
      o.stop(t + dur + 0.4);
    }
    g.connect(dest);
  }

  /** Brass stab / swell for the boss and the cover. */
  brass(dest: AudioNode, t: number, notes: readonly number[], dur: number, vel: number, attack = 0.03): void {
    const ac = this.ac;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(250, t);
    lp.frequency.exponentialRampToValueAtTime(3600, t + attack * 1.6);
    lp.frequency.exponentialRampToValueAtTime(1200, t + attack * 1.6 + 0.4);
    const g = ac.createGain();
    const v = vel / Math.sqrt(notes.length);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + attack);
    g.gain.setValueAtTime(v * 0.8, t + Math.max(attack, dur - 0.05));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.25);
    const wave = warmWave(ac, 1.0, 40);
    for (const m of notes) {
      for (const det of [-7, 6]) {
        const o = ac.createOscillator();
        o.setPeriodicWave(wave);
        o.frequency.value = midiToHz(m);
        o.detune.value = det;
        o.connect(lp);
        o.start(t);
        o.stop(t + dur + 0.3);
      }
    }
    lp.connect(g);
    g.connect(dest);
  }

  /** Long sustained drone (started once per track, stopped on track exit). */
  drone(dest: AudioNode, t: number, notes: readonly number[], vel: number): () => void {
    const ac = this.ac;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 4);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    lp.Q.value = 0.8;
    const lfo = ac.createOscillator();
    lfo.frequency.value = 0.07;
    const lg = ac.createGain();
    lg.gain.value = 140;
    lfo.connect(lg);
    lg.connect(lp.frequency);
    lfo.start(t);
    const oscs: OscillatorNode[] = [lfo];
    const wave = warmWave(ac, 1.6, 16);
    for (const m of notes) {
      for (const det of [-5, 5]) {
        const o = ac.createOscillator();
        o.setPeriodicWave(wave);
        o.frequency.value = midiToHz(m);
        o.detune.value = det;
        o.connect(lp);
        o.start(t);
        oscs.push(o);
      }
    }
    lp.connect(g);
    g.connect(dest);
    return () => {
      const now = ac.currentTime;
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(0, now + 2.5);
      for (const o of oscs) o.stop(now + 2.6);
    };
  }

  /** Kit sample hit with optional stereo placement. */
  hit(dest: AudioNode, id: KitId, t: number, vel: number, rate = 1, panV = 0): void {
    const list = this.kit?.[id];
    if (!list || list.length === 0) return;
    const ac = this.ac;
    const src = ac.createBufferSource();
    src.buffer = list[this.rr++ % list.length]!;
    src.playbackRate.value = rate;
    const g = ac.createGain();
    g.gain.value = vel;
    src.connect(g);
    if (panV !== 0 && typeof ac.createStereoPanner === 'function') {
      const p = ac.createStereoPanner();
      p.pan.value = panV;
      g.connect(p);
      p.connect(dest);
    } else g.connect(dest);
    src.start(t);
  }

  private rev = new Map<KitId, AudioBuffer>();
  /**
   * Kit sample played backwards (rewind bar). Reversed copies are made once, on first use.
   * `alignEnd`: the reversed sample *ends* at `t` (a reversed boom lands on the bar line).
   */
  hitReversed(dest: AudioNode, id: KitId, t: number, vel: number, rate = 1, alignEnd = false): number {
    let buf = this.rev.get(id);
    if (!buf) {
      const src = this.kit?.[id]?.[0];
      if (!src) return 0;
      buf = this.ac.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
      for (let ch = 0; ch < src.numberOfChannels; ch++) {
        const a = src.getChannelData(ch);
        const b = buf.getChannelData(ch);
        for (let i = 0, n = a.length; i < n; i++) b[i] = a[n - 1 - i]!;
      }
      this.rev.set(id, buf);
    }
    const s = this.ac.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    const g = this.ac.createGain();
    g.gain.value = vel;
    s.connect(g);
    g.connect(dest);
    const d = buf.duration / rate;
    s.start(alignEnd ? Math.max(this.ac.currentTime, t - d) : t);
    return d;
  }

  /**
   * Harmon-muted trumpet: bright wave through a nasal band-pass "mute" with delayed vibrato.
   * Used for the newsprint-noir leitmotif quote.
   */
  mutedTrumpet(dest: AudioNode, t: number, m: number, dur: number, vel: number): void {
    const ac = this.ac;
    const o = ac.createOscillator();
    o.setPeriodicWave(warmWave(ac, 0.8, 36));
    o.frequency.value = midiToHz(m);
    const vib = ac.createOscillator();
    vib.frequency.value = 5.2;
    const vg = ac.createGain();
    vg.gain.setValueAtTime(0, t);
    vg.gain.linearRampToValueAtTime(14, t + Math.min(0.5, dur * 0.7));
    vib.connect(vg);
    vg.connect(o.detune);
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 3.2;
    bp.frequency.setValueAtTime(900, t);
    bp.frequency.linearRampToValueAtTime(1500, t + 0.08);
    bp.frequency.setTargetAtTime(1150, t + 0.08, 0.2);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.035);
    g.gain.setTargetAtTime(vel * 0.7, t + 0.035, 0.15);
    g.gain.setTargetAtTime(0, t + dur, 0.07);
    o.connect(bp);
    bp.connect(g);
    g.connect(dest);
    o.start(t);
    vib.start(t);
    o.stop(t + dur + 0.5);
    vib.stop(t + dur + 0.5);
  }

  private seed = 0x51f15e;
  /** Cheap LCG — instruments only need decorrelation, not quality randomness. */
  rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
}
