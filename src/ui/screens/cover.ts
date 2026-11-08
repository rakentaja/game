/** Cover screen: printed comic cover + stats, Share (Web Share files) / PNG fallback, teaser, A2HS. */
import type { RunStats } from '../../core/types';
import { frag, h, s } from '../dom';
import { ICON_BOOK, ICON_DOWNLOAD, ICON_HOME, ICON_SHARE } from '../icons';
import { type CoverText, drawCover } from './cover-art';
import { Screen } from './screen';

export interface CoverHandlers {
  title(): void;
  credits(): void;
  /** Previous best time (seconds) for the "new best" badge. */
  bestTimeS?: number | null;
  /** Shown a couple of seconds after the cover lands (add-to-home-screen prompt). */
  afterReveal?(): void;
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export class CoverScreen extends Screen {
  private stats: RunStats | null = null;
  private hd: CoverHandlers | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private blob: Promise<Blob | null> | null = null;
  private revealTimer = 0;

  show(stats: RunStats, hd: CoverHandlers): void {
    this.stats = stats;
    this.hd = hd;
    this.mount();
    this.env.sfx('fanfare');
    clearTimeout(this.revealTimer);
    this.revealTimer = window.setTimeout(() => hd.afterReveal?.(), 2600);
  }

  hide(): void {
    clearTimeout(this.revealTimer);
    this.unmount();
  }

  private coverText(): CoverText {
    const t = this.env.t;
    const st = this.stats!;
    const acc = st.boltsFired > 0 ? Math.round((st.boltsHit / st.boltsFired) * 100) : 0;
    const lang = this.env.i18n.lang === 'tr' ? 'tr-TR' : 'en-US';
    return {
      complete: t('cover.complete'),
      number: t('cover.number'),
      price: t('cover.price'),
      month: new Intl.DateTimeFormat(lang, { month: 'short' }).format(new Date()).replace('.', ''),
      subtitle: t('title.subtitle'),
      blurb: t('cover.blurb'),
      featuring: t('cover.featuring'),
      seal: t('cover.seal'),
      stats: [
        { label: t('cover.time'), value: formatTime(st.timeS) },
        { label: t('cover.ghosts'), value: String(st.ghostsInked) },
        { label: t('cover.accuracy'), value: `${acc}%` },
      ],
      upper: (x) => this.env.i18n.upper(x),
    };
  }

  private async paint(): Promise<void> {
    if (!this.canvas || !this.stats) return;
    await drawCover(this.canvas, this.stats, this.coverText());
    const c = this.canvas;
    this.blob = new Promise((r) => c.toBlob((b) => r(b), 'image/png'));
    this.el?.classList.add('painted');
  }

  private async share(): Promise<void> {
    const blob = await this.blob;
    if (!blob) return;
    const t = this.env.t;
    const file = new File([blob], 'inkwake-issue-1.png', { type: 'image/png' });
    const data: ShareData = {
      files: [file],
      title: 'INKWAKE — Issue #1',
      text: t('cover.shareText', { time: formatTime(this.stats!.timeS) }),
    };
    if (navigator.canShare?.(data) && navigator.share) {
      try {
        await navigator.share(data);
        return;
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return;
      }
    }
    this.download(blob);
  }

  private download(blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: 'inkwake-issue-1.png' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    this.env.toast(this.env.t('cover.saved'), { ms: 2200 });
  }

  protected build(): HTMLElement {
    const t = this.env.t;
    const st = this.stats!;
    const hd = this.hd!;
    const acc = st.boltsFired > 0 ? Math.round((st.boltsHit / st.boltsFired) * 100) : 0;
    const best = hd.bestTimeS;
    const newBest = best == null || st.timeS < best;
    this.canvas = h('canvas', {
      width: '1000',
      height: '1500',
      role: 'img',
      'aria-label': t('cover.complete'),
    });
    void this.paint();

    const stat = (label: string, value: string, extra?: Node | null) =>
      h('div', null, h('dt', null, label), h('dd', null, value, extra ?? null));

    const canShareFiles = typeof navigator !== 'undefined' && !!navigator.share && !!navigator.canShare;
    const shareBtn = this.btn(
      h(
        'button',
        { class: 'cx-btn primary' },
        frag(canShareFiles ? ICON_SHARE : ICON_DOWNLOAD),
        h('span', null, t(canShareFiles ? 'cover.share' : 'cover.download')),
      ),
      () => void this.share(),
    );
    const saveBtn = canShareFiles
      ? this.btn(
          h('button', { class: 'cx-btn small' }, frag(ICON_DOWNLOAD), h('span', null, t('cover.download'))),
          () => void this.blob?.then((b) => b && this.download(b)),
        )
      : null;

    return h(
      'section',
      { class: 'ui-screen scr-cover', 'aria-labelledby': 'cv-h' },
      h(
        'div',
        { class: 'cover-wrap' },
        h('div', { class: 'cover-art' }, this.canvas),
        h(
          'div',
          { class: 'cover-side' },
          h(
            'div',
            { class: 'cx-panel cover-stats' },
            h('h2', { id: 'cv-h', class: 'cx-caption' }, t('cover.stats')),
            h(
              'dl',
              null,
              stat(
                t('cover.time'),
                formatTime(st.timeS),
                newBest ? h('span', { class: 'cover-best' }, t('cover.newBest')) : null,
              ),
              stat(t('cover.ghosts'), String(st.ghostsInked)),
              stat(t('cover.ink'), String(Math.round(st.inkCollected))),
              stat(t('cover.accuracy'), `${acc}%`),
              stat(t('cover.torn'), String(st.pagesTorn)),
              stat(t('cover.deaths'), String(st.deaths)),
            ),
          ),
          h(
            'div',
            { class: 'cover-actions' },
            shareBtn,
            saveBtn,
            this.btn(
              h('button', { class: 'cx-btn small' }, frag(ICON_BOOK), h('span', null, t('cover.credits'))),
              () => hd.credits(),
            ),
            this.btn(
              h('button', { class: 'cx-btn small' }, frag(ICON_HOME), h('span', null, t('cover.title'))),
              () => hd.title(),
            ),
          ),
          h(
            'div',
            { class: 'cover-next', role: 'note' },
            s(
              'svg',
              { class: 'silhouette', viewBox: '0 0 46 64', 'aria-hidden': 'true' },
              s('path', {
                d: 'M3 3 H43 V61 H3 Z',
                fill: 'var(--paper)',
                stroke: 'var(--ink)',
                'stroke-width': '3',
              }),
              s('path', {
                d: 'M3 3 H43 V18 H3 Z',
                fill: 'var(--red-2)',
                stroke: 'var(--ink)',
                'stroke-width': '3',
              }),
              s('path', {
                d: 'M10 56 C14 40 18 30 23 26 C28 30 32 40 36 56 Z',
                fill: 'var(--staff-2)',
                stroke: 'var(--ink)',
                'stroke-width': '2.5',
              }),
              s(
                'text',
                {
                  x: '23',
                  y: '45',
                  'text-anchor': 'middle',
                  'font-family': 'Bangers',
                  'font-size': '16',
                  fill: 'var(--gold)',
                },
                '?',
              ),
            ),
            h('span', { class: 'num' }, '#2'),
            h('div', { class: 'txt' }, h('b', null, t('cover.next')), h('span', null, '· · ·')),
            h('span', { class: 'soon' }, t('cover.nextSoon')),
          ),
        ),
      ),
    );
  }
}
