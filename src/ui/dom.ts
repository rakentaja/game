/** Minimal DOM helpers (no framework). Only used when building screens, never per frame. */

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

const SVGNS = 'http://www.w3.org/2000/svg';

export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVGNS, tag);
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

function applyProps(el: Element, props: Props): void {
  for (const k of Object.keys(props)) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'dataset' && typeof v === 'object') {
      Object.assign((el as HTMLElement).dataset, v);
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
}

function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c == null || c === false) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
}

/** Parse a static SVG/HTML snippet (trusted, authored in this repo). */
export function frag(html: string): DocumentFragment {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content;
}

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

/** Resolve after the element's CSS animation/transition ends (or after `maxMs`). */
export function settle(el: Element, maxMs = 1200): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      el.removeEventListener('animationend', end);
      el.removeEventListener('transitionend', end);
      resolve();
    };
    el.addEventListener('animationend', end);
    el.addEventListener('transitionend', end);
    setTimeout(end, maxMs);
  });
}

export function isTouchDevice(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
}
