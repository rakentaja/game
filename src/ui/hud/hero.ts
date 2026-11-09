/**
 * Hero HUD (lazy chunk, loaded on the first gameplay page): the Splash meter (ultimate) and the
 * per-page perk card. DOM only, palette colours, no per-frame work (event-driven).
 */
import type { GameContext, HeroId } from '../../core/types';
import type { HeroHudAPI } from '../../entities/heroes/runtime';
import { h } from '../dom';
import '../i18n/heroes';
import './hero.css';

const SPLAT =
  'M32 4 C40 2 44 10 50 9 C58 8 62 18 58 25 C64 32 61 42 54 44 C56 54 46 60 39 56 C33 63 24 61 21 55 C12 58 5 50 8 42 C1 37 2 27 9 24 C6 15 14 8 22 10 C25 4 29 5 32 4 Z';

class HeroHud implements HeroHudAPI {
  readonly el: HTMLElement;
  private meter: HTMLElement;
  private fill: SVGRectElement;
  private label: HTMLElement;
  private card: HTMLElement | null = null;
  private value = -1;

  constructor(private ctx: GameContext) {
    const t = ctx.t;
    this.label = h('b', { class: 'hs-label' }, t('heroes.splash'));
    this.meter = h('div', {
      class: 'hero-splash',
      role: 'meter',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-label': t('heroes.splash'),
    });
    this.meter.insertAdjacentHTML(
      'beforeend',
      `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><clipPath id="hs-clip"><path d="${SPLAT}"/></clipPath></defs>
      <path class="bg" d="${SPLAT}"/><g clip-path="url(#hs-clip)"><rect class="fill" x="0" y="64" width="64" height="64"/></g>
      <path class="rim" d="${SPLAT}"/></svg>`,
    );
    this.fill = this.meter.querySelector('.fill') as SVGRectElement;
    this.meter.append(this.label);
    this.el = h('div', { class: 'hero-hud', hidden: true }, this.meter);
    (document.getElementById('ui-root') ?? document.body).append(this.el);
  }

  setHero(id: HeroId): void {
    this.el.dataset.hero = id;
  }

  setVisible(v: boolean): void {
    this.el.hidden = !v;
    this.el.classList.toggle('left-handed', !!this.ctx.settings.leftHanded);
    if (!v) this.closeCard();
  }

  setSplash(v: number): void {
    const pct = Math.round(Math.max(0, Math.min(1, v)) * 100);
    if (pct === this.value) return;
    this.value = pct;
    this.fill.setAttribute('y', String(64 - (pct / 100) * 64));
    this.meter.setAttribute('aria-valuenow', String(pct));
    const full = pct >= 100;
    this.meter.classList.toggle('full', full);
    this.label.textContent = this.ctx.t(full ? 'heroes.splashReady' : 'heroes.splash');
  }

  perk(hero: HeroId, options: readonly [string, string], autoS: number): Promise<string> {
    this.closeCard();
    const t = this.ctx.t;
    return new Promise((resolve) => {
      let done = false;
      const pick = (id: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.ctx.events.emit('sfx:play', { id: 'ui_click' });
        this.closeCard();
        resolve(id);
      };
      const btn = (id: string, i: number) => {
        const b = h(
          'button',
          { class: 'cx-btn hp-opt', type: 'button', 'data-perk': id, 'data-i': i },
          h('b', { class: 'cx-display' }, t(`heroes.perk.${id}`)),
          h('small', null, t(`heroes.perkDesc.${id}`)),
        );
        b.addEventListener('click', () => pick(id));
        return b;
      };
      const bar = h('i', { class: 'hp-timer' });
      bar.style.animationDuration = `${autoS}s`;
      this.card = h(
        'section',
        {
          class: 'hero-perk cx-panel',
          role: 'dialog',
          'aria-label': t('heroes.perkTitle'),
          'data-hero': hero,
        },
        h('h3', { class: 'cx-caption' }, t('heroes.perkTitle')),
        h('div', { class: 'hp-row' }, btn(options[0], 0), btn(options[1], 1)),
        bar,
      );
      this.el.append(this.card);
      // never block the page: the first option is taken if the reader keeps playing
      const timer = setTimeout(() => pick(options[0]), Math.max(0, autoS) * 1000);
    });
  }

  private closeCard(): void {
    this.card?.remove();
    this.card = null;
  }

  dispose(): void {
    this.el.remove();
  }
}

export function createHeroHud(ctx: GameContext): HeroHudAPI {
  return new HeroHud(ctx);
}
