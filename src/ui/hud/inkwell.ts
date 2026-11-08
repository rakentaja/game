/**
 * Ink-bottle energy meter: a canvas liquid with a damped slosh spring (driven by energy changes
 * and player motion) under a hand-inked SVG bottle. Allocation-free per frame; skips drawing
 * when the liquid has settled.
 */
import { PAL } from '../../data/palette';
import { frag, h } from '../dom';

const W = 64;
const H = 70;
const BOTTLE =
  'M24 14 H40 V20 C52 22 58 28 58 40 V60 C58 65 54 67 49 67 H15 C10 67 6 65 6 60 V40 C6 28 12 22 24 20 Z';
const TOP = 21;
const BOTTOM = 67;

export class InkWell {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private clip: Path2D;
  private scale = 1;
  private level = 1;
  private shown = 1;
  private tilt = 0;
  private tiltV = 0;
  private amp = 0;
  private phase = 0;
  private dirty = true;
  private ro: ResizeObserver | null = null;
  private lowState = '';

  constructor() {
    this.canvas = h('canvas', { 'aria-hidden': 'true' });
    this.g = this.canvas.getContext('2d')!;
    this.clip = new Path2D(BOTTLE);
    this.el = h(
      'div',
      { class: 'hud-ink', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100' },
      this.canvas,
      frag(`<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">
        <path class="glass" d="${BOTTLE}"/>
        <path class="glass-hi" d="M13 36 C14 30 17 27 21 25 M11 42 V54"/>
        <path class="cork" d="M22.5 3.5 H41.5 L40.5 15 H23.5 Z"/>
        <path d="M26 8 H38" stroke="var(--ink)" stroke-width="1.6"/>
        <path class="label" d="M14 47 H50 L49 61 H15 Z"/>
        <path d="M32 48.6 C35 52.6 35.8 54.2 35.8 55.4 C35.8 57.6 34.2 58.8 32 58.8 C29.8 58.8 28.2 57.6 28.2 55.4 C28.2 54.2 29 52.6 32 48.6 Z" fill="var(--ink)" stroke="var(--ink)" stroke-width="1" stroke-linejoin="round"/>
        <path d="M30.6 54.8 C30.4 56 31 57 31.8 57.3" fill="none" stroke="var(--gold)" stroke-width="1.4" stroke-linecap="round"/>
      </svg>`),
    );
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this.el);
    }
  }

  private resize(): void {
    const r = this.el.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr));
    const hh = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== hh) {
      this.canvas.width = w;
      this.canvas.height = hh;
      this.scale = w / W;
      this.dirty = true;
    }
  }

  /** Energy 0..max. Kicks the slosh proportional to the change. */
  set(value: number, max: number, label: string): void {
    const L = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
    const d = L - this.level;
    if (Math.abs(d) < 1e-4) return;
    this.level = L;
    this.amp = Math.min(3.2, this.amp + Math.abs(d) * 24);
    this.tiltV += d * 6;
    if (d > 0.02) {
      this.el.classList.remove('gain');
      void this.el.offsetWidth;
      this.el.classList.add('gain');
    }
    const state = L <= 0.001 ? 'empty' : L < 0.2 ? 'low' : '';
    if (state !== this.lowState) {
      this.el.classList.toggle('low', state === 'low');
      this.el.classList.toggle('empty', state === 'empty');
      this.lowState = state;
    }
    this.el.setAttribute('aria-valuenow', String(Math.round(L * 100)));
    this.el.setAttribute('aria-label', label);
    this.dirty = true;
  }

  /** Lateral motion (e.g. player velocity x in m/s) sways the ink. */
  push(vx: number, dt: number): void {
    if (Math.abs(vx) > 0.05) {
      this.tiltV -= vx * 0.35 * dt;
      this.dirty = true;
    }
  }

  update(dt: number, reduceMotion: boolean): void {
    const k = 60;
    const c = 5.5;
    this.tiltV += (-k * this.tilt - c * this.tiltV) * dt;
    this.tilt += this.tiltV * dt;
    if (this.tilt > 0.6) this.tilt = 0.6;
    else if (this.tilt < -0.6) this.tilt = -0.6;
    this.amp *= Math.exp(-dt * 1.6);
    this.phase += dt * 7;
    const ease = 1 - Math.exp(-dt * 7);
    this.shown += (this.level - this.shown) * ease;
    if (reduceMotion) {
      this.tilt = 0;
      this.amp = 0;
      this.shown = this.level;
    }
    const moving =
      Math.abs(this.tilt) > 0.002 ||
      Math.abs(this.tiltV) > 0.002 ||
      this.amp > 0.02 ||
      Math.abs(this.level - this.shown) > 0.0008;
    if (moving || this.dirty) {
      this.draw();
      this.dirty = moving;
    }
  }

  private draw(): void {
    const g = this.g;
    const s = this.scale;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(s, 0, 0, s, 0, 0);
    // glass interior
    g.fillStyle = PAL.ghost[2];
    g.fill(this.clip);
    if (this.shown <= 0.002) return;
    g.save();
    g.clip(this.clip);
    const base = BOTTOM - this.shown * (BOTTOM - TOP);
    const amp = this.amp + 0.6;
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x += 4) {
      const y =
        base +
        this.tilt * ((x - 32) / 32) * 9 +
        Math.sin(x * 0.22 + this.phase) * amp * 0.6 +
        Math.sin(x * 0.5 - this.phase * 1.3) * amp * 0.25;
      g.lineTo(x, y);
    }
    g.lineTo(W, H);
    g.closePath();
    g.fillStyle = PAL.ink;
    g.fill();
    // teal sheen band + gold crystal glint on the meniscus
    g.strokeStyle = PAL.teal[1];
    g.lineWidth = 3;
    g.translate(0, 3.5);
    g.stroke();
    g.translate(0, -3.5);
    g.beginPath();
    for (let x = 8; x <= 30; x += 3) {
      const y =
        base +
        this.tilt * ((x - 32) / 32) * 9 +
        Math.sin(x * 0.22 + this.phase) * amp * 0.6 +
        Math.sin(x * 0.5 - this.phase * 1.3) * amp * 0.25 +
        1.8;
      if (x === 8) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.strokeStyle = PAL.glowCore;
    g.lineWidth = 1.8;
    g.lineCap = 'round';
    g.stroke();
    g.restore();
  }

  dispose(): void {
    this.ro?.disconnect();
  }
}
