/** Pause menu: Resume, Settings, Back to title (with an in-panel confirm, no browser dialogs). */
import { frag, h, s } from '../dom';
import { ICON_GEAR, ICON_HOME, ICON_PLAY } from '../icons';
import { Screen } from './screen';

export interface PauseHandlers {
  resume(): void;
  settings(): void;
  quit(): void;
}

export class PauseScreen extends Screen {
  private hd: PauseHandlers | null = null;
  private confirming = false;
  private onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !this.visible) return;
    if (this.env.root.querySelector('.scr-settings')) return;
    e.preventDefault();
    if (this.confirming) this.setConfirm(false);
    else this.hd?.resume();
  };

  show(hd: PauseHandlers): void {
    this.hd = hd;
    this.confirming = false;
    this.mount();
    addEventListener('keydown', this.onKey);
    this.focusFirst('.cx-btn.primary');
  }

  hide(): void {
    removeEventListener('keydown', this.onKey);
    this.unmount();
  }

  private setConfirm(on: boolean): void {
    this.confirming = on;
    this.refresh();
    this.focusFirst(on ? '.pause-confirm .cx-btn' : '.cx-btn.primary');
  }

  protected build(): HTMLElement {
    const t = this.env.t;
    const hd = this.hd!;
    const body = this.confirming
      ? h(
          'div',
          { class: 'pause-confirm', role: 'alertdialog', 'aria-describedby': 'pz-c' },
          h('p', { id: 'pz-c' }, t('pause.confirm')),
          h(
            'div',
            { class: 'row' },
            this.btn(h('button', { class: 'cx-btn small' }, t('pause.confirmNo')), () =>
              this.setConfirm(false),
            ),
            this.btn(h('button', { class: 'cx-btn red small' }, t('pause.confirmYes')), () => hd.quit()),
          ),
        )
      : [
          h('p', { class: 'pause-sub' }, t('pause.subtitle')),
          this.btn(
            h('button', { class: 'cx-btn primary' }, frag(ICON_PLAY), h('span', null, t('pause.resume'))),
            () => hd.resume(),
          ),
          this.btn(
            h('button', { class: 'cx-btn' }, frag(ICON_GEAR), h('span', null, t('pause.settings'))),
            () => hd.settings(),
          ),
          this.btn(h('button', { class: 'cx-btn' }, frag(ICON_HOME), h('span', null, t('pause.quit'))), () =>
            this.setConfirm(true),
          ),
        ];
    const panel = h(
      'div',
      { class: 'cx-panel modal-body' },
      DRIP(),
      ...(Array.isArray(body) ? body : [body]),
    );
    return h(
      'section',
      {
        class: 'ui-screen scr-modal scr-pause',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'pz-h',
      },
      h('div', { class: 'cx-scrim' }),
      h(
        'div',
        { class: 'modal-card pause-card', style: 'width:min(100%, 400px)' },
        h('h2', { id: 'pz-h', class: 'cx-caption modal-head' }, t('pause.title')),
        panel,
      ),
    );
  }
}

/** An ink drip running off the panel's top edge. */
function DRIP(): SVGSVGElement {
  return s(
    'svg',
    { class: 'pause-drip', viewBox: '0 0 52 64', 'aria-hidden': 'true' },
    s('path', {
      d: 'M0 0 H52 C46 6 42 4 40 10 C38 20 41 34 36 40 C31 46 25 42 26 34 C27 24 24 12 18 9 C12 6 6 8 0 4 Z',
      fill: 'var(--ink)',
    }),
    s('circle', { cx: '31', cy: '54', r: '4.5', fill: 'var(--ink)' }),
  );
}
