/**
 * Loading screen: INKWAKE is pencilled onto a blank page in step with real load progress, then
 * inked when loading completes. `complete()` resolves on the first tap — the user gesture the
 * audio engine needs to unlock.
 */
import { frag, h } from '../dom';
import { ICON_PENCIL, ICON_TAP } from '../icons';
import { createLogo, type LogoSvg } from '../logo';
import { Screen } from './screen';

export class LoadingScreen extends Screen {
  private logo: LogoSvg | null = null;
  private pencil: HTMLElement | null = null;
  private pct: HTMLElement | null = null;
  private meta: HTMLElement | null = null;
  private target = 0;
  private shown = 0;
  private raf = 0;
  private last = 0;
  private finished = false;

  show(): void {
    this.finished = false;
    this.target = 0;
    this.shown = 0;
    this.mount();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  hide(): void {
    cancelAnimationFrame(this.raf);
    this.logo?.dispose();
    this.logo = null;
    this.unmount();
  }

  /** Real progress 0..1 (monotonic; lower values are ignored). */
  setProgress(p: number): void {
    if (Number.isFinite(p)) this.target = Math.max(this.target, Math.min(1, Math.max(0, p)));
  }

  get progress(): number {
    return this.shown;
  }

  /**
   * Finish: catch the pencil up, ink the logo, then wait for a tap/click/key.
   * Pass `waitForTap: false` to skip the gesture (e.g. ?skip=1).
   */
  async complete(opts: { waitForTap?: boolean } = {}): Promise<void> {
    this.target = 1;
    const reduce = this.env.reduceMotion();
    await new Promise<void>((r) => {
      const check = () => (this.shown >= 0.999 || reduce ? r() : setTimeout(check, 30));
      check();
    });
    this.finished = true;
    this.logo?.setPencil(1);
    if (this.pencil) this.pencil.style.opacity = '0';
    this.env.sfx('sketch_done');
    await this.logo?.ink(reduce);
    this.logo?.boil(!reduce);
    if (opts.waitForTap === false) return;
    const touch = matchMedia('(pointer: coarse)').matches;
    if (this.meta) {
      this.meta.replaceChildren(
        h(
          'div',
          { class: 'loading-tap', role: 'button', tabindex: '0' },
          frag(ICON_TAP),
          this.env.t(touch ? 'loading.ready' : 'loading.readyDesktop'),
        ),
      );
    }
    const el = this.el;
    if (!el) return;
    await new Promise<void>((resolve) => {
      const go = (e: Event) => {
        if (e instanceof KeyboardEvent && !['Enter', ' ', 'Space'].includes(e.key)) return;
        el.removeEventListener('pointerup', go);
        removeEventListener('keydown', go);
        resolve();
      };
      el.addEventListener('pointerup', go);
      addEventListener('keydown', go);
    });
  }

  /** Show an error with a retry button (asset load failure). */
  error(onRetry: () => void): void {
    if (!this.meta) return;
    const retry = this.btn(h('button', { class: 'cx-btn red small' }, this.env.t('loading.retry')), () => {
      this.setProgressReset();
      onRetry();
    });
    this.meta.replaceChildren(
      h('div', { class: 'loading-error', role: 'alert' }, h('div', null, this.env.t('loading.error')), retry),
    );
  }

  private setProgressReset(): void {
    this.target = 0;
    this.shown = 0;
    this.finished = false;
    this.logo?.setPencil(0);
    this.renderMeta();
  }

  private tick = (now: number) => {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (!this.finished && this.shown < this.target) {
      // ease toward real progress but keep a minimum pencil speed so it never looks stuck
      this.shown = Math.min(
        this.target,
        this.shown + Math.max((this.target - this.shown) * dt * 5, dt * 0.18),
      );
      this.logo?.setPencil(this.shown);
      this.placePencil();
      if (this.pct) this.pct.textContent = this.env.t('loading.percent', { n: Math.round(this.shown * 100) });
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private placePencil(): void {
    const svg = this.logo?.root;
    const pencil = this.pencil;
    if (!svg || !pencil) return;
    const paths = svg.querySelectorAll<SVGPathElement>('.pencil-a');
    const lp = Math.max(0, (this.shown - 0.04) / 0.96) * paths.length;
    const i = Math.min(paths.length - 1, Math.floor(lp));
    const path = paths[i];
    const m = path?.getScreenCTM();
    const host = this.el?.getBoundingClientRect();
    if (!path || !m || !host) return;
    const len = path.getTotalLength();
    const pt = path.getPointAtLength(Math.min(1, lp - i) * len).matrixTransform(m);
    pencil.style.transform = `translate(${pt.x - host.left}px, ${pt.y - host.top}px)`;
  }

  private renderMeta(): void {
    this.pct = h(
      'div',
      { class: 'loading-pct', 'aria-hidden': 'true' },
      this.env.t('loading.percent', { n: 0 }),
    );
    this.meta?.replaceChildren(h('div', { class: 'loading-status' }, this.env.t('loading.inking')), this.pct);
  }

  protected build(): HTMLElement {
    this.logo?.dispose();
    this.logo = createLogo({ pencil: true });
    this.pencil = h('div', { class: 'loading-pencil' }, frag(ICON_PENCIL));
    this.meta = h('div', { class: 'loading-meta', 'aria-live': 'polite' });
    this.renderMeta();
    const el = h(
      'section',
      {
        class: 'ui-screen scr-loading',
        role: 'progressbar',
        'aria-label': this.env.t('loading.inking'),
        'aria-valuemin': '0',
        'aria-valuemax': '100',
      },
      h('div', { class: 'paper-grain' }, frag(PAPER_GRAIN)),
      h('div', { class: 'page-edge' }),
      h('div', { class: 'loading-logo' }, this.logo.root),
      this.meta,
      h('div', { class: 'loading-issue' }, `${this.env.t('title.issue')} · ${this.env.t('title.subtitle')}`),
      this.pencil,
    );
    return el;
  }

  override refresh(): void {
    // language change while loading: only the captions change
    if (!this.visible) return;
    if (!this.finished) this.renderMeta();
    // (also when the lazily loaded dictionary lands after the screen was built)
    const el = this.el;
    if (!el) return;
    el.setAttribute('aria-label', this.env.t('loading.inking'));
    const issue = el.querySelector('.loading-issue');
    if (issue) issue.textContent = `${this.env.t('title.issue')} · ${this.env.t('title.subtitle')}`;
  }
}

/** Static paper fibres + foxing in ink at low coverage (palette colours only). */
const PAPER_GRAIN = `<svg preserveAspectRatio="none" aria-hidden="true">
<filter id="pg-f" x="0" y="0" width="100%" height="100%">
  <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="11"/>
  <feColorMatrix values="0 0 0 0 0.086  0 0 0 0 0.063  0 0 0 0 0.055  0 0 0 -2.4 1.32"/>
</filter>
<filter id="pg-b" x="0" y="0" width="100%" height="100%">
  <feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="3" seed="4"/>
  <feColorMatrix values="0 0 0 0 0.737  0 0 0 0 0.682  0 0 0 0 0.576  0 0 0 -3 1.55"/>
</filter>
<rect width="100%" height="100%" filter="url(#pg-b)" opacity="0.5"/>
<rect width="100%" height="100%" filter="url(#pg-f)" opacity="0.22"/>
</svg>`;
