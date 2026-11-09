/**
 * Narration captions ("The Editor Writes Back"): pulp-yellow boxes under the HUD's top band.
 * Consumes `caption:show` / `caption:cancel` / `caption:effect`. A caption that threatens an
 * effect shows a burning fuse; tapping it `tapsToCancel` times scratches it out and emits
 * `caption:cancel`. Each box is a real <button data-no-gesture>, so Input never turns the tap
 * into a bolt or a move (either handedness). Placement keeps clear of pages/ink (top-left),
 * pause (top-right) and the boss bar (top-centre).
 */
import type { EventBus, GameEvents } from '../../core/events';
import { TUNING } from '../../data/tuning';
import { h, s } from '../dom';

interface Live {
  id: string;
  el: HTMLButtonElement;
  taps: number;
  threat: boolean;
  timer: number;
  scratches: SVGSVGElement;
}

const SCRATCH = ['M4 30 Q40 18 80 34 T156 26', 'M6 14 Q60 40 104 12 T158 36', 'M2 40 Q70 6 120 30 T160 10'];

export class Captions {
  readonly el = h('div', { class: 'ui-captions', 'aria-live': 'polite' });
  private readonly live: Live[] = [];
  private readonly offs: (() => void)[] = [];
  private enabled = false;

  constructor(
    private readonly bus: EventBus<GameEvents>,
    private readonly t: (k: string) => string,
    private readonly upper: (s: string) => string,
    private readonly fx: { sfx(): void; haptic(p: number): void },
  ) {
    this.offs.push(
      bus.on('caption:show', (e) => this.show(e.id, e.key, !!e.effect, e.delay ?? 0)),
      bus.on('caption:cancel', (e) => this.remove(e.id, 'scratched')),
      bus.on('caption:effect', (e) => this.remove(e.id, 'fired')),
    );
  }

  /** Only shown while the HUD is (title / cover never get captions). */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.clear();
  }

  private show(id: string, key: string, threat: boolean, delay: number): void {
    if (!this.enabled) return;
    // one at a time: a newer narration replaces an older plain one (threats stay until resolved)
    for (const l of [...this.live]) if (!l.threat) this.remove(l.id, 'out');
    const text = this.upper(this.t(key));
    const scratches = s('svg', { class: 'scratch', viewBox: '0 0 160 44', preserveAspectRatio: 'none' });
    const el = h(
      'button',
      {
        class: `ui-caption${threat ? ' threat' : ''}`,
        type: 'button',
        'data-no-gesture': '',
        'aria-label': threat ? `${text} — ${this.t('caption.scratchHint')}` : text,
      },
      h('span', { class: 'txt' }, text),
      threat ? h('span', { class: 'fuse', style: `--d:${Math.max(0.5, delay)}s` }) : null,
      threat ? h('span', { class: 'hint', 'aria-hidden': 'true' }, this.t('caption.scratchHint')) : null,
      scratches,
    ) as HTMLButtonElement;
    const l: Live = { id, el, taps: 0, threat, timer: 0, scratches };
    el.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    el.addEventListener('click', () => this.tap(l));
    this.el.append(el);
    this.live.push(l);
    if (!threat)
      l.timer = window.setTimeout(() => this.remove(id, 'out'), TUNING.worldMeta.captions.showS * 1000);
  }

  private tap(l: Live): void {
    if (!l.threat || !l.el.isConnected) return;
    const need = TUNING.worldMeta.captions.tapsToCancel;
    l.taps++;
    this.fx.sfx();
    this.fx.haptic(12);
    const d = SCRATCH[(l.taps - 1) % SCRATCH.length]!;
    l.scratches.append(s('path', { d, pathLength: '1' }));
    if (l.taps >= need) this.bus.emit('caption:cancel', { id: l.id });
  }

  private remove(id: string, how: 'out' | 'scratched' | 'fired'): void {
    const i = this.live.findIndex((l) => l.id === id);
    if (i < 0) return;
    const l = this.live[i]!;
    this.live.splice(i, 1);
    clearTimeout(l.timer);
    l.el.disabled = true;
    l.el.classList.add(how);
    setTimeout(() => l.el.remove(), how === 'out' ? 260 : 900);
  }

  clear(): void {
    for (const l of this.live) {
      clearTimeout(l.timer);
      l.el.remove();
    }
    this.live.length = 0;
  }

  dispose(): void {
    for (const o of this.offs) o();
    this.clear();
    this.el.remove();
  }
}
