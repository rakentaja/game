/**
 * On-screen ink feedback for touch controls: the joystick's hand-inked ring + knob, and marks for
 * action gestures (tap splat, hold ring, swipe streak). DOM + CSS transforms only (compositor
 * friendly); textures are drawn once into canvases at boot. Colours come from the palette.
 */
import { PAL } from '../../data/palette';

const STYLE_ID = 'inkwake-touch-style';
const CSS = `
.iw-touch{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:5;contain:strict}
.iw-touch>*{position:absolute;left:0;top:0;will-change:transform,opacity;pointer-events:none}
.iw-joy{opacity:0;transition:opacity .16s ease-out}
.iw-joy.on{opacity:.92;transition:opacity .05s}
.iw-knob{opacity:0;transition:opacity .16s ease-out}
.iw-knob.on{opacity:1;transition:opacity .04s}
.iw-hold{opacity:0;transition:opacity .2s}
.iw-hold.on{opacity:1;animation:iw-hold-grow .6s cubic-bezier(.2,.9,.25,1) both}
@keyframes iw-hold-grow{from{scale:.35}to{scale:1}}
.iw-splat{opacity:0}
.iw-splat.go{animation:iw-splat .32s ease-out both}
@keyframes iw-splat{0%{opacity:1;scale:.4}60%{opacity:.9;scale:1.05}100%{opacity:0;scale:1.2}}
.iw-streak{opacity:0;transform-origin:0 50%}
.iw-streak.go{animation:iw-streak .3s ease-out both}
@keyframes iw-streak{0%{opacity:1;scale:.2 1}40%{opacity:1;scale:1 1}100%{opacity:0;scale:1.15 .4}}
@media (prefers-reduced-motion: reduce){.iw-hold.on,.iw-splat.go,.iw-streak.go{animation-duration:.01s}}
`;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A rough brush ring: several jittered passes, ink under paper so it reads on any ground. */
function inkRing(size: number, dpr: number, seed: number, inner: string, width: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = Math.ceil(size * dpr);
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  const r = rng(seed);
  const cx = size / 2;
  const R = size / 2 - width * 1.6;
  const stroke = (col: string, w: number, passes: number) => {
    for (let p = 0; p < passes; p++) {
      g.beginPath();
      const start = r() * Math.PI * 2;
      const sweep = Math.PI * 2 * (0.92 + r() * 0.12);
      const steps = 64;
      for (let i = 0; i <= steps; i++) {
        const a = start + (sweep * i) / steps;
        const rr = R + (r() - 0.5) * width * 0.5 + Math.sin(a * 3 + p) * width * 0.25;
        const x = cx + Math.cos(a) * rr;
        const y = cx + Math.sin(a) * rr;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.strokeStyle = col;
      g.lineWidth = w * (0.8 + r() * 0.4);
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.stroke();
    }
  };
  stroke(PAL.ink, width * 2.2, 2);
  stroke(inner, width, 3);
  // A few dry-brush flecks.
  for (let i = 0; i < 14; i++) {
    const a = r() * Math.PI * 2;
    const rr = R + (r() - 0.5) * width * 3;
    g.fillStyle = r() > 0.5 ? PAL.ink : inner;
    g.beginPath();
    g.arc(cx + Math.cos(a) * rr, cx + Math.sin(a) * rr, 0.6 + r() * 1.6, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

function inkBlob(size: number, dpr: number, seed: number, fill: string, rim: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = Math.ceil(size * dpr);
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  const r = rng(seed);
  const cx = size / 2;
  const path = (rad: number) => {
    g.beginPath();
    const n = 18;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = rad * (0.9 + r() * 0.16);
      const x = cx + Math.cos(a) * rr;
      const y = cx + Math.sin(a) * rr;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
  };
  path(size * 0.44);
  g.fillStyle = rim;
  g.fill();
  path(size * 0.32);
  g.fillStyle = fill;
  g.fill();
  // highlight nick
  g.fillStyle = PAL.paper;
  g.beginPath();
  g.ellipse(cx - size * 0.1, cx - size * 0.12, size * 0.07, size * 0.04, -0.6, 0, Math.PI * 2);
  g.fill();
  return c;
}

function splat(size: number, dpr: number, seed: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = Math.ceil(size * dpr);
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  const r = rng(seed);
  const cx = size / 2;
  g.strokeStyle = PAL.ink;
  g.lineCap = 'round';
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + r() * 0.4;
    const r0 = size * 0.16;
    const r1 = size * (0.3 + r() * 0.16);
    g.lineWidth = 2.5 + r() * 2;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r0, cx + Math.sin(a) * r0);
    g.lineTo(cx + Math.cos(a) * r1, cx + Math.sin(a) * r1);
    g.stroke();
    g.fillStyle = i % 3 === 0 ? PAL.glowCore : PAL.ink;
    g.beginPath();
    g.arc(cx + Math.cos(a) * (r1 + 3), cx + Math.sin(a) * (r1 + 3), 1.5 + r() * 2, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

function streak(w: number, h: number, dpr: number, seed: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * dpr);
  c.height = Math.ceil(h * dpr);
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  const r = rng(seed);
  for (let p = 0; p < 3; p++) {
    g.beginPath();
    const y = h / 2 + (p - 1) * h * 0.22;
    g.moveTo(4, y);
    for (let i = 1; i <= 12; i++) {
      const x = (w - 8) * (i / 12) + 4;
      g.lineTo(x, y + (r() - 0.5) * 2);
    }
    g.strokeStyle = p === 1 ? PAL.glowCore : PAL.ink;
    g.lineWidth = p === 1 ? 3 : 2;
    g.lineCap = 'round';
    g.stroke();
  }
  // arrow head
  g.fillStyle = PAL.ink;
  g.beginPath();
  g.moveTo(w, h / 2);
  g.lineTo(w - 14, h / 2 - 9);
  g.lineTo(w - 14, h / 2 + 9);
  g.closePath();
  g.fill();
  return c;
}

const MAX_ACTION = 4;

export class TouchVisuals {
  readonly root: HTMLDivElement;
  private joy: HTMLCanvasElement;
  private knob: HTMLCanvasElement;
  private holds: HTMLCanvasElement[] = [];
  private splats: HTMLCanvasElement[] = [];
  private streaks: HTMLCanvasElement[] = [];
  private splatIdx = 0;
  private streakIdx = 0;
  private joyR: number;
  private knobR: number;

  constructor(parent: HTMLElement, joyRadiusPx: number) {
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.root = document.createElement('div');
    this.root.className = 'iw-touch';
    this.root.setAttribute('aria-hidden', 'true');
    this.joyR = joyRadiusPx + 14;
    this.knobR = Math.round(joyRadiusPx * 0.5);
    this.joy = inkRing(this.joyR * 2, dpr, 11, PAL.paper, 3);
    this.joy.className = 'iw-joy';
    this.knob = inkBlob(this.knobR * 2, dpr, 5, PAL.red[2], PAL.ink);
    this.knob.className = 'iw-knob';
    this.size(this.joy, this.joyR * 2, this.joyR * 2);
    this.size(this.knob, this.knobR * 2, this.knobR * 2);
    this.root.append(this.joy, this.knob);
    for (let i = 0; i < MAX_ACTION; i++) {
      const h = inkRing(120, dpr, 31 + i, PAL.glowCore, 3.5);
      h.className = 'iw-hold';
      this.size(h, 120, 120);
      const s = splat(84, dpr, 51 + i);
      s.className = 'iw-splat';
      this.size(s, 84, 84);
      const k = streak(120, 30, dpr, 71 + i);
      k.className = 'iw-streak';
      this.size(k, 120, 30);
      this.holds.push(h);
      this.splats.push(s);
      this.streaks.push(k);
      this.root.append(h, s, k);
    }
    parent.appendChild(this.root);
  }

  private size(el: HTMLCanvasElement, w: number, h: number): void {
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
  }

  private place(el: HTMLElement, x: number, y: number, half: number, halfH = half, rot = 0): void {
    el.style.transform = rot
      ? `translate3d(${x - half}px,${y - halfH}px,0) rotate(${rot}rad)`
      : `translate3d(${x - half}px,${y - halfH}px,0)`;
  }

  joyShow(x: number, y: number): void {
    this.place(this.joy, x, y, this.joyR);
    this.place(this.knob, x, y, this.knobR);
    this.joy.classList.add('on');
    this.knob.classList.add('on');
  }

  joyMove(ox: number, oy: number, kx: number, ky: number): void {
    this.place(this.joy, ox, oy, this.joyR);
    this.place(this.knob, kx, ky, this.knobR);
  }

  joyHide(): void {
    this.joy.classList.remove('on');
    this.knob.classList.remove('on');
  }

  hold(slot: number, x: number, y: number, on: boolean): void {
    const h = this.holds[slot % MAX_ACTION]!;
    if (on) {
      this.place(h, x, y, 60);
      h.classList.remove('on');
      void h.offsetWidth;
      h.classList.add('on');
    } else h.classList.remove('on');
  }

  holdMove(slot: number, x: number, y: number): void {
    const h = this.holds[slot % MAX_ACTION]!;
    if (h.classList.contains('on')) this.place(h, x, y, 60);
  }

  tap(x: number, y: number): void {
    const s = this.splats[this.splatIdx++ % MAX_ACTION]!;
    this.place(s, x, y, 42);
    s.classList.remove('go');
    void s.offsetWidth;
    s.classList.add('go');
  }

  swipe(x: number, y: number, dx: number, dy: number): void {
    const s = this.streaks[this.streakIdx++ % MAX_ACTION]!;
    s.style.transform = `translate3d(${x}px,${y - 15}px,0) rotate(${Math.atan2(dy, dx)}rad)`;
    s.classList.remove('go');
    void s.offsetWidth;
    s.classList.add('go');
  }

  clear(): void {
    this.joyHide();
    for (const h of this.holds) h.classList.remove('on');
  }

  dispose(): void {
    this.root.remove();
  }
}
