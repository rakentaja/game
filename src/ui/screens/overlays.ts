/** Death "page reprint" overlay and page title cards. */
import type { PageId } from '../../core/types';
import { frag, h, s, settle, wait } from '../dom';
import { burstPath } from '../icons';
import { Screen } from './screen';

export class DeathOverlay extends Screen {
  private phase: 'in' | 'out' | null = null;

  private covering: Promise<void> | null = null;

  /** Print a blank sheet over the scene. Resolves once the screen is fully covered. */
  cover(): Promise<void> {
    if (this.phase === 'in' && this.covering) return this.covering;
    this.covering = this.doCover();
    return this.covering;
  }

  private async doCover(): Promise<void> {
    this.phase = 'in';
    this.mount();
    this.el!.classList.add('in');
    this.env.sfx('page_turn');
    await settle(this.el!.querySelector('.death-sheet')!, 900);
    await wait(this.env.reduceMotion() ? 400 : 900);
  }

  /** Lift the reprinted sheet away (call after respawning behind it). */
  async reveal(): Promise<void> {
    // never lift before the sheet has landed and been read
    if (this.covering) await this.covering;
    this.covering = null;
    if (!this.el || this.phase !== 'in') return;
    this.phase = 'out';
    this.el.classList.remove('in');
    this.el.classList.add('out');
    this.env.sfx('page_turn');
    await settle(this.el.querySelector('.death-sheet')!, 800);
    this.phase = null;
    this.unmount();
  }

  get active(): boolean {
    return this.phase !== null;
  }

  protected build(): HTMLElement {
    const t = this.env.t;
    const burst = s(
      'svg',
      { class: 'death-burst', viewBox: '0 0 300 200', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      s('path', { d: burstPath(150, 100, 148, 96, 14, 2), fill: 'var(--ink)' }),
      s('path', { d: burstPath(150, 100, 132, 82, 14, 2), fill: 'var(--red-2)' }),
    );
    return h(
      'section',
      { class: `ui-screen scr-death${this.phase === 'in' ? ' in' : ''}`, role: 'alert' },
      h(
        'div',
        { class: 'death-sheet' },
        h('div', { class: 'death-title cx-display cx-hollow' }, burst, t('death.title')),
        h(
          'div',
          { class: 'death-sub' },
          t('death.reprint').replace(/…$/, ''),
          h(
            'span',
            { class: 'dots', 'aria-hidden': 'true' },
            h('i', null, '.'),
            h('i', null, '.'),
            h('i', null, '.'),
          ),
        ),
        h('div', { class: 'death-roller', 'aria-hidden': 'true' }),
        h(
          'div',
          { class: 'death-marks', 'aria-hidden': 'true' },
          ...['tl', 'tr', 'bl', 'br'].map((c) => frag(REG_MARK.replace('CLS', c))),
        ),
        h('div', { class: 'death-folio', 'aria-hidden': 'true' }, `INKWAKE · ${t('cover.number')}`),
      ),
    );
  }
}

export class TitleCard extends Screen {
  private page: PageId = 1;
  private timer = 0;

  show(page: PageId): Promise<void> {
    this.page = page;
    clearTimeout(this.timer);
    this.mount();
    this.env.sfx('panel_stinger');
    return new Promise((r) => {
      this.timer = window.setTimeout(() => {
        this.unmount();
        r();
      }, 2900);
    });
  }

  hide(): void {
    clearTimeout(this.timer);
    this.unmount();
  }

  protected build(): HTMLElement {
    const t = this.env.t;
    const boss = this.page === 'boss';
    const label = boss ? t('page.final') : t('page.label', { n: this.page });
    const name = t(`page.${this.page}`);
    return h(
      'div',
      { class: `ui-screen ui-layer-pass title-card${boss ? ' boss' : ''}`, role: 'status' },
      h(
        'div',
        { class: 'card', 'aria-label': t('page.card', { label, name }) },
        h('small', null, label),
        h('span', null, name),
      ),
    );
  }
}

/** Printer's registration mark (crosshair target) for the reprint sheet corners. */
const REG_MARK = `<svg class="CLS" viewBox="0 0 44 44"><circle cx="22" cy="22" r="11" fill="none" stroke="var(--staff-3)" stroke-width="2"/><circle cx="22" cy="22" r="5" fill="var(--staff-3)"/><path d="M22 2 V42 M2 22 H42" stroke="var(--staff-3)" stroke-width="2"/></svg>`;
