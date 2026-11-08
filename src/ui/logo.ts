/**
 * The INKWAKE logo: hand-lettered block capitals built from stroke centre-lines, so the same data
 * drives the pencil-sketch loading animation (SVG dash offset), the inked/stamped title logo and
 * the canvas-drawn cover masthead. The "I" is the wizard's staff topped by the gold crystal.
 */
import { PAL } from '../data/palette';
import { s } from './dom';

interface Glyph {
  w: number;
  d: string;
}

const GLYPHS: Record<string, Glyph> = {
  I: { w: 24, d: 'M12 88 V12' },
  N: { w: 62, d: 'M10 88 V12 L52 88 V12' },
  K: { w: 56, d: 'M10 12 V88 M50 12 L13 57 M28 41 L52 88' },
  W: { w: 84, d: 'M5 12 L22 88 L42 34 L62 88 L79 12' },
  A: { w: 62, d: 'M6 88 L31 12 L56 88 M17 63 H45' },
  E: { w: 50, d: 'M46 12 H10 V88 H46 M10 50 H38' },
};

const WORD = 'INKWAKE';
const GAP = 10;
const BOUNCE = [0, -4, 2, -3, 3, -1, 2];
const TILT = [-2, 1.6, -1.2, 0.8, -1.6, 2, -1];
/** Crystal diamond above the I (local coords of the I glyph). */
export const CRYSTAL = 'M12 -30 L23 -13 L12 2 L1 -13 Z';
export const CRYSTAL_FACET = 'M1 -13 H23 M12 -30 L9 -13 L12 2';

export const LOGO_VIEWBOX = { x: -22, y: -50, w: 500, h: 170 };

export interface PlacedGlyph {
  ch: string;
  d: string;
  /** SVG transform for the glyph group. */
  transform: string;
  x: number;
  y: number;
  rot: number;
}

export function layout(): PlacedGlyph[] {
  let x = 0;
  const out: PlacedGlyph[] = [];
  for (let i = 0; i < WORD.length; i++) {
    const ch = WORD[i]!;
    const g = GLYPHS[ch]!;
    const y = BOUNCE[i]!;
    const rot = TILT[i]!;
    out.push({ ch, d: g.d, x, y, rot, transform: `translate(${x} ${y}) rotate(${rot} ${g.w / 2} 50)` });
    x += g.w + GAP;
  }
  return out;
}

export interface LogoSvg {
  root: SVGSVGElement;
  /** Draw the pencil sketch to `p` (0..1). Cheap: only style writes. */
  setPencil(p: number): void;
  /** Ink every letter (staggered CSS animation). Resolves when the crystal has lit. */
  ink(fast?: boolean): Promise<void>;
  /** Show fully inked instantly (title screen). */
  inked(): void;
  boil(on: boolean): void;
  dispose(): void;
}

let uid = 0;

/** Build the logo SVG. `pencil` adds the graphite construction layer for the loading screen. */
export function createLogo(opts: { pencil?: boolean; title?: string } = {}): LogoSvg {
  const id = `lg${uid++}`;
  const v = LOGO_VIEWBOX;
  const placed = layout();
  const turb = s('feTurbulence', {
    type: 'fractalNoise',
    baseFrequency: '0.035',
    numOctaves: '2',
    seed: '3',
    result: 'n',
  });
  const root = s(
    'svg',
    {
      class: 'logo',
      viewBox: `${v.x} ${v.y} ${v.w} ${v.h}`,
      role: 'img',
      'aria-label': opts.title ?? 'INKWAKE',
    },
    s(
      'defs',
      null,
      s(
        'filter',
        { id: `${id}-wob`, x: '-5%', y: '-10%', width: '110%', height: '120%' },
        turb,
        s('feDisplacementMap', { in: 'SourceGraphic', in2: 'n', scale: '3.2' }),
      ),
    ),
  );

  const pencilPaths: SVGPathElement[] = [];
  const guide = s('g', { class: 'logo-guides', transform: 'skewX(-6)' });
  if (opts.pencil) {
    // construction lines (cap/base line) first, then each letter twice (sketchy double pass)
    for (const y of [12, 88, 50]) {
      const p = s('path', { d: `M-12 ${y} H468`, pathLength: '1', class: 'pencil-guide' });
      guide.append(p);
      pencilPaths.push(p);
    }
    root.append(guide);
  }

  const pencil = s('g', { class: 'logo-pencil', transform: 'skewX(-6)' });
  const inkG = s('g', { class: 'logo-ink', filter: `url(#${id}-wob)` });
  const inkSkew = s('g', { transform: 'skewX(-6)' });
  const letters: SVGGElement[] = [];
  placed.forEach((g, i) => {
    if (opts.pencil) {
      const a = s('path', { d: g.d, pathLength: '1', class: 'pencil-a' });
      const b = s('path', {
        d: g.d,
        pathLength: '1',
        class: 'pencil-b',
        transform: 'translate(1.4 -1.1)',
      });
      pencil.append(s('g', { transform: g.transform }, a, b));
      pencilPaths.push(a, b);
    }
    const letter = s(
      'g',
      { class: 'logo-letter', transform: g.transform, style: `--i:${i}` },
      s('path', { d: g.d, pathLength: '1', class: 'ink-extrude', transform: 'translate(6 7)' }),
      s('path', { d: g.d, pathLength: '1', class: 'ink-outline' }),
      s('path', { d: g.d, pathLength: '1', class: 'ink-fill' }),
    );
    if (g.ch === 'I' && i === 0) {
      letter.append(
        s(
          'g',
          { class: 'logo-crystal' },
          s('path', {
            d: 'M12 -38 V-48 M-1 -30 L-9 -37 M25 -30 L33 -37 M-4 -13 H-14 M28 -13 H38',
            class: 'rays',
          }),
          s('path', { d: CRYSTAL, class: 'gem' }),
          s('path', { d: CRYSTAL_FACET, class: 'facet' }),
        ),
      );
    }
    letters.push(letter);
    inkSkew.append(letter);
  });
  inkG.append(inkSkew);
  if (opts.pencil) root.append(pencil);
  root.append(inkG);
  root.classList.toggle('has-pencil', !!opts.pencil);

  // Pencil progress is mapped sequentially: guides (first 6%), then letters left → right.
  const nGuides = opts.pencil ? 3 : 0;
  const setPencil = (p: number) => {
    const n = pencilPaths.length;
    if (!n) return;
    const gp = Math.min(1, p / 0.06);
    for (let i = 0; i < nGuides; i++) {
      pencilPaths[i]!.style.strokeDashoffset = String(1 - Math.min(1, Math.max(0, gp * 3 - i)));
    }
    const lp = Math.max(0, (p - 0.04) / 0.96) * WORD.length;
    for (let i = 0; i < WORD.length; i++) {
      const t = Math.min(1, Math.max(0, lp - i));
      const a = pencilPaths[nGuides + i * 2]!;
      const b = pencilPaths[nGuides + i * 2 + 1]!;
      a.style.strokeDashoffset = String(1 - t);
      b.style.strokeDashoffset = String(1 - Math.min(1, Math.max(0, t * 1.25 - 0.25)));
    }
  };
  setPencil(0);

  let boilTimer = 0;
  let seed = 3;
  const boil = (on: boolean) => {
    clearInterval(boilTimer);
    boilTimer = 0;
    if (on) {
      boilTimer = window.setInterval(() => {
        seed = (seed % 7) + 1;
        turb.setAttribute('seed', String(seed));
      }, 1000 / 12);
    }
  };

  return {
    root,
    setPencil,
    ink(fast = false) {
      root.classList.toggle('fast', fast);
      root.classList.add('inking');
      return new Promise((r) => setTimeout(r, fast ? 500 : 1500));
    },
    inked() {
      root.classList.add('inking', 'instant');
    },
    boil,
    dispose() {
      boil(false);
      root.remove();
    },
  };
}

/** Canvas masthead (cover). Draws the inked logo with its red extrude, centred on (cx, cy). */
export function drawLogo(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  width: number,
  colors: { extrude: string; outline: string; fill: string; gem?: boolean } = {
    extrude: PAL.red[2],
    outline: PAL.ink,
    fill: PAL.paper,
    gem: true,
  },
): void {
  const v = LOGO_VIEWBOX;
  const k = width / v.w;
  const placed = layout();
  g.save();
  g.translate(cx - (v.w / 2 + v.x) * k, cy - (v.h / 2 + v.y) * k);
  g.scale(k, k);
  g.transform(1, 0, -0.1, 1, 0, 0);
  g.lineCap = 'square';
  g.lineJoin = 'miter';
  g.miterLimit = 3.2;
  const pass = (color: string, w: number, dx: number, dy: number) => {
    g.strokeStyle = color;
    g.lineWidth = w;
    for (const p of placed) {
      const gw = GLYPHS[p.ch]!.w;
      g.save();
      g.translate(p.x + dx, p.y + dy);
      g.translate(gw / 2, 50);
      g.rotate((p.rot * Math.PI) / 180);
      g.translate(-gw / 2, -50);
      g.stroke(new Path2D(p.d));
      g.restore();
    }
  };
  pass(colors.extrude, 24, 6, 7);
  pass(colors.outline, 24, 0, 0);
  pass(colors.fill, 10, 0, 0);
  if (colors.gem !== false) {
    const p = placed[0]!;
    g.save();
    g.translate(p.x, p.y);
    g.translate(12, 50);
    g.rotate((p.rot * Math.PI) / 180);
    g.translate(-12, -50);
    const gem = new Path2D(CRYSTAL);
    g.fillStyle = PAL.glowCore;
    g.fill(gem);
    g.lineWidth = 4;
    g.lineJoin = 'round';
    g.strokeStyle = colors.outline;
    g.stroke(gem);
    g.lineWidth = 1.6;
    g.strokeStyle = PAL.glowEdge;
    g.stroke(new Path2D(CRYSTAL_FACET));
    g.restore();
  }
  g.restore();
}
