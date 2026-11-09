/**
 * Margin notes (player workstream): the Editor's Red Pen style grade, scrawled in Kalam in the
 * right margin under the pause button, plus a small "struck out" hint while the Editor has cut
 * a verb (`boss:rewrite`). Self-contained DOM + CSS; listens to the bus itself. Text is i18n'd
 * (`style.*`, `rewrite.*`). Allocation-free after construction.
 */
import type { EventBus, GameEvents } from '../../core/events';
import type { PlayerVerb } from '../../core/types';

const CSS = `
.hud-margin{position:absolute;top:calc(var(--pad-t,14px) + 64px);right:var(--pad-r,14px);
  display:flex;flex-direction:column;align-items:flex-end;gap:6px;pointer-events:none;
  font-family:var(--f-letter,"Kalam",cursive);color:var(--red-2,#b8655c);z-index:3}
.hud-margin[hidden]{display:none}
.hud-grade{display:flex;flex-direction:column;align-items:center;transform:rotate(-7deg);
  transition:opacity .4s, transform .25s}
.hud-grade.off{opacity:0}
.hud-grade .letter{font-weight:700;font-size:calc(var(--unit,16px) * 2.6);line-height:1;
  width:1.5em;height:1.3em;display:grid;place-items:center;
  border:2.5px solid currentColor;border-radius:var(--wobbly,50%);
  text-shadow:1px 1px 0 var(--ink,#16100e)}
.hud-grade .word{font-size:calc(var(--unit,16px) * 0.85);margin-top:2px;
  text-shadow:1px 1px 0 var(--ink,#16100e)}
.hud-grade.pop{transform:rotate(-7deg) scale(1.25)}
.hud-grade.g-P .letter,.hud-grade.g-S .letter{color:var(--gold,#f6c35a)}
.hud-cut{font-size:calc(var(--unit,16px) * 0.85);max-width:11em;text-align:right;
  padding:2px 6px;background:var(--paper,#efe1c9);color:var(--red-1,#6e2f2c);
  border:2px solid var(--red-1,#6e2f2c);border-radius:var(--wobbly-2,6px);transform:rotate(2deg)}
.hud-cut[hidden]{display:none}
.hud-cut s{text-decoration-thickness:2px}
@media (prefers-reduced-motion: reduce){.hud-grade,.hud-grade.pop{transition:none;transform:rotate(-7deg)}}
`;

let cssInjected = false;
const ORDER = 'DCBASP';

export class MarginNotes {
  readonly el: HTMLElement;
  private grade: HTMLElement;
  private letter: HTMLElement;
  private word: HTMLElement;
  private cut: HTMLElement;
  private cuts: Record<PlayerVerb, boolean> = { bolt: false, dash: false, crystal: false, print: false };
  private current = 'D';
  private popT = 0;
  private offs: (() => void)[] = [];

  constructor(
    events: EventBus<GameEvents>,
    private t: () => (key: string, vars?: Record<string, string | number>) => string,
    private reduceMotion: () => boolean = () => false,
  ) {
    if (!cssInjected && typeof document !== 'undefined') {
      cssInjected = true;
      const st = document.createElement('style');
      st.textContent = CSS;
      document.head.append(st);
    }
    this.el = document.createElement('div');
    this.el.className = 'hud-margin';
    this.el.hidden = true;
    this.el.setAttribute('aria-live', 'polite');
    this.grade = document.createElement('div');
    this.grade.className = 'hud-grade off';
    this.letter = document.createElement('div');
    this.letter.className = 'letter';
    this.word = document.createElement('div');
    this.word.className = 'word';
    this.grade.append(this.letter, this.word);
    this.cut = document.createElement('div');
    this.cut.className = 'hud-cut';
    this.cut.hidden = true;
    this.el.append(this.grade, this.cut);
    this.offs.push(
      events.on('style:grade', (e) => this.setGrade(e.grade)),
      events.on('boss:rewrite', (e) => {
        if (!(e.verb in this.cuts)) return;
        this.cuts[e.verb] = e.cut;
        this.renderCut();
      }),
      events.on('page:start', () => this.clearCuts()),
      events.on('boss:defeated', () => this.clearCuts()),
      events.on('settings:changed', (e) => {
        if (e.key === 'lang' || e.key === '*') this.refresh();
      }),
    );
    this.refresh();
  }

  setVisible(v: boolean): void {
    this.el.hidden = !v;
    if (v) this.refresh();
  }

  /** Per frame (real time): ends the grade-change pop. */
  update(dt: number): void {
    if (this.popT <= 0) return;
    this.popT -= dt;
    if (this.popT <= 0) this.grade.classList.remove('pop');
  }

  dispose(): void {
    for (const o of this.offs) o();
    this.offs.length = 0;
    this.el.remove();
  }

  private setGrade(g: string): void {
    const up = ORDER.indexOf(g) > ORDER.indexOf(this.current);
    this.current = g;
    this.refresh();
    if (up && g !== 'D' && !this.reduceMotion()) {
      this.grade.classList.add('pop');
      this.popT = 0.18;
    }
  }

  private refresh(): void {
    const t = this.t();
    const g = this.current;
    this.letter.textContent = g;
    this.word.textContent = t(`style.grade.${g}`);
    this.grade.className = `hud-grade g-${g}${g === 'D' ? ' off' : ''}${this.popT > 0 ? ' pop' : ''}`;
    this.grade.setAttribute('aria-label', t('style.label', { grade: g }));
    this.renderCut();
  }

  private clearCuts(): void {
    const c = this.cuts;
    c.bolt = c.dash = c.crystal = c.print = false;
    this.renderCut();
  }

  private renderCut(): void {
    const t = this.t();
    let txt = '';
    for (const v of ['bolt', 'dash', 'crystal', 'print'] as const) {
      if (!this.cuts[v]) continue;
      txt = txt ? `${txt} · ${t(`rewrite.${v}`)}` : t(`rewrite.${v}`);
    }
    this.cut.hidden = txt === '';
    this.cut.textContent = txt ? t('rewrite.cut', { verbs: txt }) : '';
  }
}
