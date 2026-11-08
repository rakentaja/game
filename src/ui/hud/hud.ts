/**
 * In-game HUD: torn-page health (top-left), ink-bottle energy (under it), pause (top-right),
 * boss bar (top-centre), sketch-print ring (projected over the crystal) and tutorial hints.
 * `update(dt)` runs every frame and must stay allocation-free.
 */

import type { Camera } from 'three';
import { Vector3 } from 'three';
import { frag, h } from '../dom';
import { ICON_PAUSE } from '../icons';
import type { UIEnv } from '../screens/screen';
import { InkWell } from './inkwell';
import { type Device, type Hint, Tutorial } from './tutorial';

const PAGE_TILT = [-4, 3, -2, 4, -3, 2, -1];
const PAGE_SVG = `<svg viewBox="0 0 30 38" aria-hidden="true">
<path class="slot" d="M3 3 H22 L27 8 V35 H3 Z"/>
<g class="half l"><path class="sheet" d="M3 3 H16 L13 9 L17 14 L13 20 L17 26 L14 31 L16 35 H3 Z"/><path class="lines" d="M6 12 H14 M6 17 H14 M6 22 H14 M6 27 H13"/></g>
<g class="half r"><path class="sheet" d="M16 3 H22 L27 8 V35 H16 L14 31 L17 26 L13 20 L17 14 L13 9 Z"/><path class="lines" d="M17 12 H24 M18 17 H24 M17 22 H24 M18 27 H24"/><path class="fold" d="M22 3 L27 8 H22 Z"/></g>
</svg>`;

export interface HudSources {
  camera?: () => Camera | null;
  /** World position to anchor the print ring (crystal tip). */
  anchor?: () => Vector3 | null;
  playerVelX?: () => number;
  moveLen?: () => number;
  device?: () => Device;
}

export class Hud {
  readonly el: HTMLElement;
  private pagesEl: HTMLElement;
  private pages: HTMLElement[] = [];
  private maxPages = 5;
  private pagesLeft = 5;
  private ink = new InkWell();
  private energy = 100;
  private energyMax = 100;
  private boss: HTMLElement;
  private bossFill: HTMLElement;
  private bossTicks: HTMLElement;
  private bossPhases: HTMLElement[] = [];
  private bossHp = 1;
  private ring: HTMLElement;
  private ringArc: SVGCircleElement;
  private ringT = -1;
  private ringHideAt = 0;
  private ringX = -1;
  private ringY = -1;
  readonly tutorial: Tutorial;
  private tmp = new Vector3();
  private clock = 0;
  onPause: (() => void) | null = null;

  constructor(
    private env: UIEnv,
    private src: HudSources = {},
  ) {
    const t = env.t;
    this.pagesEl = h('div', { class: 'hud-pages', role: 'meter', 'aria-valuemin': '0' });
    this.boss = h('div', {
      class: 'hud-boss',
      hidden: true,
      role: 'meter',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
    });
    this.bossFill = h('div', { class: 'fill' });
    this.bossTicks = h('div', { class: 'ticks' });
    this.buildBoss();
    this.ring = h('div', { class: 'hud-ring', 'aria-hidden': 'true' });
    this.ring.append(
      frag(`<svg viewBox="0 0 76 76"><circle class="bg" cx="38" cy="38" r="30"/><circle class="pencil" cx="38" cy="38" r="22"/><circle class="arc" cx="38" cy="38" r="22" pathLength="1"/>
      <path class="stamp" d="M30 26 H46 L43 34 H50 V40 H26 V34 H33 Z M24 44 H52 V49 H24 Z"/></svg>`),
    );
    this.ringArc = this.ring.querySelector('.arc') as SVGCircleElement;
    this.tutorial = new Tutorial((hint, keys) => t(`tutorial.${hint}${keys ? 'Keys' : ''}`));
    const pause = h(
      'button',
      { class: 'cx-icon-btn hud-pause', 'aria-label': t('hud.pause') },
      frag(ICON_PAUSE),
    );
    pause.type = 'button';
    pause.addEventListener('click', () => {
      env.sfx('ui_click');
      this.onPause?.();
    });
    this.el = h(
      'div',
      { class: 'hud', hidden: true },
      h('div', { class: 'hud-tl' }, this.pagesEl, this.ink.el),
      h('div', { class: 'hud-tr' }, pause),
      this.boss,
      this.ring,
      this.tutorial.el,
    );
    this.setPages(5, 5, false);
    this.setEnergy(100, 100);
  }

  show(): void {
    this.el.hidden = false;
    this.el.classList.toggle('left-handed', this.env.settings.get('leftHanded'));
  }

  hide(): void {
    this.el.hidden = true;
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  // ─── pages ───
  setPages(left: number, max = this.maxPages, animate = true): void {
    left = Math.max(0, Math.min(max, Math.round(left)));
    if (max !== this.pages.length) {
      this.pagesEl.replaceChildren();
      this.pages = [];
      for (let i = 0; i < max; i++) {
        const p = h(
          'div',
          { class: 'hud-page', style: `--r:${PAGE_TILT[i % PAGE_TILT.length]}deg;--i:${i}` },
          frag(PAGE_SVG),
        );
        this.pages.push(p);
        this.pagesEl.append(p);
      }
    }
    const prev = this.pagesLeft;
    this.maxPages = max;
    this.pagesLeft = left;
    for (let i = 0; i < max; i++) {
      const p = this.pages[i]!;
      const torn = i >= left;
      p.classList.toggle('torn', torn);
      if (animate && !torn && i >= prev) {
        p.classList.remove('reprint');
        void p.offsetWidth;
        p.classList.add('reprint');
      }
    }
    this.pagesEl.classList.toggle('last', left === 1);
    if (animate && left < prev) {
      this.pagesEl.classList.remove('hit');
      void this.pagesEl.offsetWidth;
      this.pagesEl.classList.add('hit');
    }
    this.pagesEl.setAttribute('aria-valuemax', String(max));
    this.pagesEl.setAttribute('aria-valuenow', String(left));
    this.pagesEl.setAttribute('aria-label', this.env.t('hud.pages', { n: left, max }));
  }

  // ─── energy ───
  setEnergy(value: number, max: number): void {
    this.energy = value;
    this.energyMax = max;
    const pct = max > 0 ? Math.round((value / max) * 100) : 0;
    this.ink.set(value, max, this.env.t(pct < 20 ? 'hud.energyLow' : 'hud.energy', { n: pct }));
  }

  // ─── boss ───
  private buildBoss(): void {
    const t = this.env.t;
    for (let i = 0; i < 9; i++) this.bossTicks.append(h('i'));
    this.bossPhases = [h('b', null, 'I'), h('b', null, 'II'), h('b', null, 'III')];
    this.boss.replaceChildren(
      h('div', { class: 'name' }, t('hud.boss')),
      h('div', { class: 'bar' }, this.bossFill, this.bossTicks),
      h('div', { class: 'phases' }, ...this.bossPhases),
    );
  }

  showBoss(on: boolean): void {
    this.boss.hidden = !on;
  }

  setBossPhase(phase: 1 | 2 | 3): void {
    this.showBoss(true);
    this.bossPhases.forEach((b, i) => {
      b.classList.toggle('on', i === phase - 1);
      b.classList.toggle('done', i < phase - 1);
    });
    this.boss.setAttribute(
      'aria-label',
      `${this.env.t('hud.boss')} — ${this.env.t('hud.phase', { n: phase })}`,
    );
  }

  setBossHealth(v: number): void {
    v = Math.max(0, Math.min(1, v));
    if (v < this.bossHp) {
      this.boss.classList.remove('hurt');
      void this.boss.offsetWidth;
      this.boss.classList.add('hurt');
    }
    this.bossHp = v;
    this.bossFill.style.setProperty('--hp', String(v));
    this.boss.setAttribute('aria-valuenow', String(Math.round(v * 100)));
  }

  get bossHealth(): number {
    return this.bossHp;
  }

  // ─── sketch print ring ───
  setPrint(t: number): void {
    this.ringT = t;
    this.ringHideAt = this.clock + 0.35;
    this.ring.classList.remove('done');
    this.ring.classList.add('on');
    this.ringArc.style.strokeDashoffset = String(1 - Math.max(0, Math.min(1, t)));
  }

  printDone(): void {
    this.ringT = -1;
    this.ring.classList.add('done');
    setTimeout(() => this.ring.classList.remove('on', 'done'), 450);
  }

  // ─── tutorial ───
  showHint(hint: Hint): void {
    const coarse = matchMedia('(pointer: coarse)').matches;
    let device = this.src.device?.() ?? (coarse ? 'touch' : 'keyboard');
    // Input defaults to 'touch' until a key is pressed; on a mouse/keyboard machine show keys
    if (device === 'touch' && !coarse) device = 'keyboard';
    this.tutorial.show(hint, device, this.env.settings.get('leftHanded'));
  }

  hideHint(hint: Hint): void {
    this.tutorial.hide(hint);
  }

  refreshText(): void {
    this.buildBoss();
    this.setPages(this.pagesLeft, this.maxPages, false);
    this.setEnergy(this.energy, this.energyMax);
    this.el.querySelector('.hud-pause')?.setAttribute('aria-label', this.env.t('hud.pause'));
  }

  /** Per frame. Allocation-free. */
  update(dt: number): void {
    if (this.el.hidden) return;
    this.clock += dt;
    const reduce = this.env.reduceMotion();
    if (this.src.playerVelX) this.ink.push(this.src.playerVelX(), dt);
    this.ink.update(dt, reduce);
    if (this.src.moveLen) this.tutorial.trackMove(this.src.moveLen(), dt);
    if (this.ringT >= 0) {
      if (this.clock > this.ringHideAt) {
        this.ringT = -1;
        this.ring.classList.remove('on');
      } else this.placeRing();
    }
  }

  private placeRing(): void {
    const cam = this.src.camera?.();
    const anchor = this.src.anchor?.();
    let x = innerWidth * 0.5;
    let y = innerHeight * 0.4;
    if (cam && anchor) {
      this.tmp.copy(anchor).project(cam);
      x = (this.tmp.x * 0.5 + 0.5) * innerWidth;
      y = (-this.tmp.y * 0.5 + 0.5) * innerHeight - 70;
    }
    if (Math.abs(x - this.ringX) > 0.5 || Math.abs(y - this.ringY) > 0.5) {
      this.ringX = x;
      this.ringY = y;
      this.ring.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
    }
  }

  dispose(): void {
    this.ink.dispose();
    this.el.remove();
  }
}
