import type { EventBus, GameEvents } from '../../core/events';
import type { SfxId } from '../../core/types';
import type { I18n, Vars } from '../i18n';
import type { SettingsStore } from '../settings';

/** Shared services every screen receives from the UI root. */
export interface UIEnv {
  root: HTMLElement;
  i18n: I18n;
  t: (key: string, vars?: Vars) => string;
  settings: SettingsStore;
  bus: EventBus<GameEvents> | null;
  sfx(id: SfxId): void;
  haptic(pattern: number | number[]): void;
  reduceMotion(): boolean;
  toast(msg: string | Node, opts?: ToastOpts): () => void;
}

export interface ToastOpts {
  action?: { label: string; run: () => void };
  icon?: string;
  ms?: number;
  closable?: boolean;
  /** Render inline inside this element instead of the bottom stack. */
  host?: HTMLElement | null;
}

let keyboardMode = false;
if (typeof window !== 'undefined') {
  addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Tab' || e.key.startsWith('Arrow') || e.key === 'Enter') keyboardMode = true;
  });
  addEventListener('pointerdown', () => {
    keyboardMode = false;
  });
}

/** A DOM screen that is (re)built on demand and rebuilt on language change while visible. */
export abstract class Screen {
  el: HTMLElement | null = null;
  protected abstract build(): HTMLElement;

  constructor(protected env: UIEnv) {}

  get visible(): boolean {
    return !!this.el?.isConnected;
  }

  protected mount(): HTMLElement {
    this.unmount();
    this.el = this.build();
    this.env.root.append(this.el);
    return this.el;
  }

  protected unmount(): void {
    this.el?.remove();
    this.el = null;
  }

  /** Rebuild in place (language change). Subclasses with live state override. */
  refresh(): void {
    if (!this.visible) return;
    const old = this.el!;
    const next = this.build();
    next.classList.add('no-anim');
    old.replaceWith(next);
    this.el = next;
  }

  /** Move focus into the screen, but only for keyboard users (no focus rings on touch). */
  protected focusFirst(selector: string): void {
    if (keyboardMode) this.el?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  }

  /** Wire a button: click sound + handler; pointer-down press state for crisp mobile feedback. */
  protected btn(el: HTMLButtonElement, fn: () => void): HTMLButtonElement {
    el.type = 'button';
    el.addEventListener('click', () => {
      this.env.sfx('ui_click');
      this.env.haptic(8);
      fn();
    });
    el.addEventListener('pointerenter', (e) => {
      if ((e as PointerEvent).pointerType === 'mouse') this.env.sfx('ui_hover');
    });
    return el;
  }
}
