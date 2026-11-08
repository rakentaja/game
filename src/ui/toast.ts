import { frag, h } from './dom';
import type { ToastOpts } from './screens/screen';

/** Speech-balloon toasts stacked at the bottom (SW update, saved cover, add-to-home-screen). */
export class Toasts {
  readonly el = h('div', { class: 'ui-toasts', role: 'status', 'aria-live': 'polite' });

  constructor(private click: () => void) {}

  show(msg: string | Node, opts: ToastOpts = {}): () => void {
    const close = () => {
      if (!el.isConnected || el.classList.contains('out')) return;
      el.classList.add('out');
      setTimeout(() => el.remove(), 280);
    };
    const action = opts.action
      ? h('button', { class: 'cx-btn small', type: 'button' }, opts.action.label)
      : null;
    action?.addEventListener('click', () => {
      this.click();
      opts.action!.run();
      close();
    });
    const x = opts.closable ? h('button', { class: 'x', type: 'button', 'aria-label': '×' }, '×') : null;
    x?.addEventListener('click', () => {
      this.click();
      close();
    });
    const el = h(
      'div',
      { class: 'ui-toast' },
      opts.icon ? h('span', { class: 'ico', 'aria-hidden': 'true' }, frag(opts.icon)) : null,
      h('span', { class: 'msg' }, msg),
      action,
      x,
    );
    if (opts.host) {
      el.classList.add('inline');
      opts.host.append(el);
    } else this.el.append(el);
    if (opts.ms) setTimeout(close, opts.ms);
    return close;
  }
}
