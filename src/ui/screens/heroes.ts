/**
 * Hero select (lazy chunk; the title opens it before a solo run). Four comic "credits" cards —
 * Inker, Penciller, Letterer, Colorist — with inline SVG role art, a kit summary and a Pick button.
 * The last pick is remembered (storage key `hero`) and preselected.
 * Test hooks: `.scr-heroes`, `[data-hero]` cards, `[data-act="pick"]`, `[data-act="back"]`.
 */
import { load, save } from '../../core/storage';
import type { HeroId } from '../../core/types';
import { HERO_IDS, isHeroId } from '../../entities/heroes/perks';
import { frag, h } from '../dom';
import '../i18n/heroes';
import { Screen, type UIEnv } from './screen';
import './heroes.css';

export interface HeroPickHandlers {
  pick(id: HeroId): void;
  back(): void;
}

/** Comic-role art: brush + crystal, pencil + ruler, balloon, three plates. Palette only. */
const ART: Record<HeroId, string> = {
  inker: `<svg viewBox="0 0 120 90" aria-hidden="true"><path d="M8 80 Q40 60 70 66 T112 58" stroke="var(--ink)" stroke-width="9" fill="none" stroke-linecap="round"/>
    <path d="M60 14 L74 36 L60 58 L46 36 Z" fill="var(--gold)" stroke="var(--ink)" stroke-width="4"/><path d="M60 22 L66 36 L60 50" fill="none" stroke="var(--ember)" stroke-width="3"/>
    <path d="M20 22 l6 6 M100 18 l-6 7 M96 50 l8 2" stroke="var(--ink)" stroke-width="4" stroke-linecap="round"/></svg>`,
  penciller: `<svg viewBox="0 0 120 90" aria-hidden="true"><rect x="10" y="58" width="100" height="14" fill="var(--gold)" stroke="var(--ink)" stroke-width="4" transform="rotate(-8 60 65)"/>
    <path d="M22 60 v-6 M34 58 v-8 M46 56 v-6 M58 55 v-8 M70 53 v-6 M82 51 v-8 M94 49 v-6" stroke="var(--ink)" stroke-width="3" transform="rotate(-8 60 65)"/>
    <path d="M30 40 L86 12 L94 22 L38 50 Z" fill="var(--teal-3)" stroke="var(--ink)" stroke-width="4"/><path d="M30 40 L38 50 L22 52 Z" fill="var(--ghost-2)" stroke="var(--ink)" stroke-width="4"/>
    <path d="M14 30 q10 -14 26 -16" stroke="var(--staff-3)" stroke-width="3" fill="none" stroke-dasharray="6 5"/></svg>`,
  letterer: `<svg viewBox="0 0 120 90" aria-hidden="true"><path d="M14 14 H106 Q112 14 112 22 V54 Q112 62 104 62 H50 L30 80 L36 62 H16 Q8 62 8 54 V22 Q8 14 14 14 Z" fill="var(--paper)" stroke="var(--ink)" stroke-width="4"/>
    <text x="60" y="50" text-anchor="middle" font-family="Bangers, Impact, sans-serif" font-size="34" fill="var(--red-2)" stroke="var(--ink)" stroke-width="2" paint-order="stroke">POW!</text></svg>`,
  colorist: `<svg viewBox="0 0 120 90" aria-hidden="true"><circle cx="46" cy="38" r="24" fill="var(--teal-3)" stroke="var(--ink)" stroke-width="4"/>
    <circle cx="74" cy="38" r="24" fill="var(--red-3)" stroke="var(--ink)" stroke-width="4"/><circle cx="60" cy="60" r="24" fill="var(--gold)" stroke="var(--ink)" stroke-width="4"/>
    <circle cx="60" cy="46" r="7" fill="var(--ink)"/></svg>`,
};

const KEY = 'hero';

export function lastHero(): HeroId {
  const v = load<{ id: string }>(KEY, { id: 'inker' }).id;
  return isHeroId(v) ? v : 'inker';
}

export class HeroPickScreen extends Screen {
  private hd: HeroPickHandlers | null = null;
  private sel: HeroId = 'inker';

  constructor(env: UIEnv) {
    super(env);
  }

  show(hd: HeroPickHandlers): void {
    this.hd = hd;
    this.sel = lastHero();
    this.mount();
    this.focusFirst(`[data-hero="${this.sel}"]`);
  }

  hide(): void {
    this.unmount();
  }

  private choose(id: HeroId): void {
    save(KEY, { id });
    this.hide();
    this.hd?.pick(id);
  }

  protected build(): HTMLElement {
    const t = this.env.t;
    const cards = HERO_IDS.map((id) => {
      const card = h(
        'li',
        { class: 'hero-card cx-panel', 'data-hero': id, 'aria-selected': String(id === this.sel) },
        h('div', { class: 'hc-art' }, frag(ART[id])),
        h('h3', { class: 'cx-display' }, t(`heroes.name.${id}`)),
        h('p', { class: 'hc-role' }, t(`heroes.role.${id}`)),
        h(
          'ul',
          { class: 'hc-kit' },
          ...(['tap', 'hold', 'swipe', 'ult'] as const).map((k) =>
            h('li', null, h('b', null, t(`heroes.verb.${k}`)), ' ', t(`heroes.kit.${id}.${k}`)),
          ),
        ),
        this.btn(
          h(
            'button',
            { class: `cx-btn small${id === this.sel ? ' primary' : ''}`, 'data-act': 'pick', 'data-id': id },
            t('heroes.pick'),
          ),
          () => this.choose(id),
        ),
      );
      return card;
    });
    const el = h(
      'section',
      { class: 'ui-screen scr-heroes', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'heroes-h' },
      h('div', { class: 'cx-scrim' }),
      h('h2', { id: 'heroes-h', class: 'cx-caption heroes-head' }, t('heroes.title')),
      h('ul', { class: 'hero-cards' }, ...cards),
      h(
        'div',
        { class: 'modal-foot' },
        this.btn(h('button', { class: 'cx-btn small', 'data-act': 'back' }, t('common.back')), () => {
          this.hide();
          this.hd?.back();
        }),
      ),
    );
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.hide();
        this.hd?.back();
      }
    });
    return el;
  }
}
