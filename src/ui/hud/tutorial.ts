/** Wordless tutorial hints: animated hand / key icons and hand-drawn arrows. */
import { frag, h } from '../dom';

export type Hint = 'move' | 'crystal' | 'bolt' | 'dash' | 'print';
export type Device = 'touch' | 'keyboard' | 'gamepad';

// pointing hand, fingertip at (0,0), ≈ 70×90
const HAND = `<path class="hand" d="M-7 4 C-7 -5 7 -5 7 4 V36 L9.5 27 C12 20 23.5 22.5 22.5 30.5 L21.5 36 C24 29 35.5 31.5 34.5 39.5 L33.5 43 C36 37.5 47.5 40 46.5 48 C45.5 63 43 76 31.5 90 H1.5 C-10 79 -20.5 66 -25 52 C-27 45.5 -18 41 -13.5 46.5 L-7 54 Z"/>
<path class="nail" d="M-3.5 2 C-3.5 -1.6 3.5 -1.6 3.5 2"/>`;

function svg(body: string): DocumentFragment {
  return frag(`<svg viewBox="0 0 200 200" aria-hidden="true">${body}</svg>`);
}

function arrow(d: string, head: string): string {
  return `<path class="arrow-ink" d="${d}"/><path class="arrow-ink" d="${head}"/><path class="arrow" d="${d}" pathLength="1"/><path class="arrow" d="${head}"/>`;
}

function key(x: number, y: number, w: number, label: string, k = 0): string {
  return `<g class="key-g" style="--k:${k}"><rect class="key-shadow" x="${x + 3}" y="${y + 5}" width="${w}" height="38" rx="6"/><rect class="key" x="${x}" y="${y}" width="${w}" height="38" rx="6"/><text class="key-t" x="${x + w / 2}" y="${y + 27}">${label}</text></g>`;
}

const TOUCH: Record<Hint, string> = {
  move: `<circle class="ring-ink" cx="100" cy="112" r="50"/><circle class="ring" cx="100" cy="112" r="50"/>
    ${arrow('M48 78 C66 44 134 44 152 78', 'M136 70 L152 78 L150 60')}
    <g class="hand-g"><circle cx="100" cy="112" r="19" fill="var(--gold)" stroke="var(--ink)" stroke-width="3.5"/><g transform="translate(100 112) scale(0.82)">${HAND}</g></g>`,
  crystal: `<circle class="pulse" cx="100" cy="92" r="44"/><circle class="pulse" cx="100" cy="92" r="26" style="animation-delay:.3s"/>
    <path d="M100 50 L112 70 L100 86 L88 70 Z" fill="var(--gold)" stroke="var(--ink)" stroke-width="3.5" stroke-linejoin="round"/>
    <g class="hand-g"><g transform="translate(100 100) scale(0.9)">${HAND}</g></g>`,
  bolt: `${arrow('M106 82 C112 56 132 36 164 26', 'M146 22 L164 26 L156 42')}
    <path class="burst" d="M100 74 L106 86 L120 80 L112 92 L126 100 L110 102 L114 116 L102 106 L92 118 L92 104 L76 106 L88 96 L76 86 L92 88 Z"/>
    <g class="hand-g"><g transform="translate(100 96) scale(0.9)">${HAND}</g></g>`,
  dash: `${arrow('M30 140 C70 132 120 114 168 76', 'M150 74 L168 76 L162 94')}
    <g class="hand-g"><g transform="translate(100 108) scale(0.9)">${HAND}</g></g>`,
  print: `<path d="M30 132 H170 M40 132 V120 M160 132 V120 M50 132 L66 118 H134 L150 132" fill="none" stroke="var(--paper)" stroke-width="3.5" stroke-dasharray="7 6"/>
    <circle class="pulse" cx="100" cy="92" r="44"/>
    <g class="hand-g"><g transform="translate(100 96) scale(0.9)">${HAND}</g></g>`,
};

const MOUSE = (btn: 'l' | 'r') => `<g transform="translate(62 50)">
  <path d="M38 0 C60 0 76 16 76 40 V64 C76 88 60 102 38 102 C16 102 0 88 0 64 V40 C0 16 16 0 38 0 Z" fill="var(--paper)" stroke="var(--ink)" stroke-width="4"/>
  <path class="burst" style="animation:none" d="${btn === 'l' ? 'M36 2 C18 3 3 16 2 38 H36 Z' : 'M40 2 C58 3 73 16 74 38 H40 Z'}"/>
  <path d="M2 40 H74 M38 2 V40" stroke="var(--ink)" stroke-width="4" fill="none"/>
</g>`;

const KEYS: Record<Hint, string> = {
  move: `${key(76, 50, 48, 'W', 0)}${key(22, 98, 48, 'A', 1)}${key(76, 98, 48, 'S', 2)}${key(130, 98, 48, 'D', 3)}`,
  crystal: `<circle class="pulse" cx="100" cy="70" r="40"/><g class="tut-hold-key">${key(40, 120, 120, '⇧ SHIFT')}</g>`,
  bolt: `<g class="hand-g">${MOUSE('l')}</g>`,
  dash: `${arrow('M40 80 C80 70 120 60 160 40', 'M142 38 L160 40 L154 58')}<g class="key-g" style="--k:0"><rect class="key-shadow" x="23" y="123" width="160" height="38" rx="6"/><rect class="key" x="20" y="118" width="160" height="38" rx="6"/><path d="M78 128 V140 H122 V128" fill="none" stroke="var(--ink)" stroke-width="4" stroke-linejoin="round"/></g>`,
  print: `<path d="M30 92 H170 M50 92 L66 78 H134 L150 92" fill="none" stroke="var(--paper)" stroke-width="3.5" stroke-dasharray="7 6"/><circle class="pulse" cx="100" cy="70" r="40"/><g class="tut-hold-key">${key(40, 120, 120, '⇧ SHIFT')}</g>`,
};

const ANIM: Record<Hint, string> = {
  move: 'tut-move',
  crystal: 'tut-hold',
  bolt: 'tut-tap',
  dash: 'tut-swipe',
  print: 'tut-hold',
};

export class Tutorial {
  readonly el = h('div', { class: 'hud-tut' });
  private shown = new Map<Hint, HTMLElement>();
  private moveAcc = 0;

  constructor(private label: (hint: Hint, keys: boolean) => string) {}

  show(hint: Hint, device: Device, leftHanded: boolean): void {
    this.hide(hint, true);
    const keys = device === 'keyboard';
    const side = keys ? 'center' : (hint === 'move') !== leftHanded ? 'left' : 'right';
    const el = h(
      'div',
      {
        class: `tut ${side} ${keys ? `tut-keys ${ANIM[hint] === 'tut-tap' ? 'tut-tap' : ''}` : ANIM[hint]}`,
        role: 'img',
        'aria-label': this.label(hint, keys),
      },
      svg(keys ? KEYS[hint] : TOUCH[hint]),
    );
    if (hint === 'move') this.moveAcc = 0;
    this.el.append(el);
    this.shown.set(hint, el);
    requestAnimationFrame(() => el.classList.add('on'));
  }

  hide(hint: Hint, instant = false): void {
    const el = this.shown.get(hint);
    if (!el) return;
    this.shown.delete(hint);
    if (instant) {
      el.remove();
      return;
    }
    el.classList.remove('on');
    setTimeout(() => el.remove(), 450);
  }

  isShown(hint: Hint): boolean {
    return this.shown.has(hint);
  }

  /** Auto-complete "move" once the player has walked a little. Allocation-free. */
  trackMove(moveLen: number, dt: number): void {
    if (!this.shown.has('move')) return;
    if (moveLen > 0.35) this.moveAcc += dt;
    if (this.moveAcc > 0.8) this.hide('move');
  }

  clear(): void {
    for (const h of [...this.shown.keys()]) this.hide(h, true);
  }
}
