/**
 * Title menu over the live scene (transparent). Logo is stamped in ink; "Read Issue #1" resolves
 * the `play` promise; Settings / Credits open on top.
 */
import type { Lang } from '../../core/types';
import { frag, h, s } from '../dom';
import { ICON_BOOK, ICON_GEAR, ICON_PLAY } from '../icons';
import { createLogo, type LogoSvg } from '../logo';
import { Screen, type UIEnv } from './screen';

export interface TitleHandlers {
  play(): void;
  settings(): void;
  credits(): void;
  /** Optional "continue from page N" (save data). */
  continuePage?: number | null;
  continue?(): void;
  /**
   * Optional override for the "Co-op" button. When absent, the title opens the lazily loaded
   * co-op lobby itself (src/ui/screens/coop.ts) and returns here on Back.
   */
  coop?(joinCode: string | null): void;
}

export const VERSION = '0.1.0';

export class TitleScreen extends Screen {
  private logo: LogoSvg | null = null;
  private handlers: TitleHandlers | null = null;
  /** `?room=CODE` invite links open the lobby once, on the first title show. */
  private inviteHandled = false;

  constructor(env: UIEnv) {
    super(env);
  }

  show(handlers: TitleHandlers): void {
    this.handlers = handlers;
    this.mount();
    this.focusFirst('.cx-btn.primary');
    if (!this.inviteHandled) {
      this.inviteHandled = true;
      const room = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('room') : null;
      if (room) this.openCoop(room);
    }
  }

  /** Co-op lobby: lazy chunk (net code is never downloaded by solo players). */
  private openCoop(joinCode: string | null = null): void {
    const hd = this.handlers!;
    if (hd.coop) {
      hd.coop(joinCode);
      return;
    }
    void import('./coop').then(({ CoopScreen }) => {
      if (!this.visible) return;
      this.hide();
      const lobby = new CoopScreen(this.env);
      lobby.show({ joinCode, onBack: () => this.show(hd) });
    });
  }

  hide(): void {
    this.logo?.dispose();
    this.logo = null;
    this.unmount();
  }

  protected build(): HTMLElement {
    const t = this.env.t;
    const hd = this.handlers!;
    this.logo?.dispose();
    this.logo = createLogo({ title: 'INKWAKE' });
    this.logo.inked();
    this.logo.boil(!this.env.reduceMotion());

    const splat = s(
      'svg',
      { class: 'title-splat', viewBox: '0 0 400 140', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      s('path', { d: SPLAT, fill: 'var(--ink)' }),
      s('path', { d: SPLAT_DROPS, fill: 'var(--ink)' }),
    );

    const lang = this.env.settings.get('lang');
    const langBtn = (l: Lang, label: string) =>
      this.btn(
        h('button', { 'aria-pressed': String(lang === l), lang: l, 'aria-label': label }, l.toUpperCase()),
        () => this.env.settings.set('lang', l),
      );

    const primary = this.btn(
      h('button', { class: 'cx-btn primary' }, frag(ICON_PLAY), h('span', null, t('title.play'))),
      () => hd.play(),
    );
    const cont =
      hd.continuePage != null && hd.continue
        ? this.btn(
            h(
              'button',
              { class: 'cx-btn small' },
              h('span', null, t('title.continue', { page: hd.continuePage })),
            ),
            () => hd.continue!(),
          )
        : null;

    return h(
      'section',
      { class: 'ui-screen scr-title', 'aria-label': 'INKWAKE' },
      h('div', { class: 'title-vignette', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'title-lang', role: 'group', 'aria-label': t('settings.language') },
        langBtn('tr', 'Türkçe'),
        langBtn('en', 'English'),
      ),
      h(
        'header',
        { class: 'title-head' },
        h('h1', { class: 'title-logo-wrap', style: 'margin:0' }, splat, this.logo.root),
        h(
          'div',
          { class: 'title-ribbon' },
          h('b', null, t('title.issue')),
          h('span', { 'aria-hidden': 'true' }, '✦'),
          h('span', null, t('title.subtitle')),
        ),
        h('p', { class: 'title-tagline' }, t('title.tagline')),
      ),
      h(
        'nav',
        { class: 'title-menu' },
        primary,
        cont,
        h(
          'div',
          { class: 'row' },
          this.btn(
            h('button', { class: 'cx-btn small' }, frag(ICON_GEAR), h('span', null, t('title.settings'))),
            () => hd.settings(),
          ),
          this.btn(
            h('button', { class: 'cx-btn small' }, frag(ICON_BOOK), h('span', null, t('title.credits'))),
            () => hd.credits(),
          ),
        ),
        this.btn(
          h('button', { class: 'cx-btn small', 'data-act': 'coop' }, h('span', null, t('coop.button'))),
          () => this.openCoop(),
        ),
        h('div', { class: 'title-version' }, t('title.version', { v: VERSION })),
      ),
    );
  }
}

const SPLAT =
  'M40 70 C30 40 70 18 120 26 C150 6 200 14 228 22 C262 4 330 14 352 40 C392 46 396 84 366 98 C380 124 330 134 300 120 C270 140 214 128 190 120 C160 138 96 134 80 116 C40 124 10 100 40 70 Z';
const SPLAT_DROPS =
  'M18 40 a7 7 0 1 0 0.1 0 Z M384 24 a5 5 0 1 0 0.1 0 Z M372 128 a6 6 0 1 0 0.1 0 Z M30 118 a4 4 0 1 0 0.1 0 Z M210 136 a4 4 0 1 0 0.1 0 Z';
