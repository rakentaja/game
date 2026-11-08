/** Hand-inked icon markup (trusted static strings, palette colours via CSS vars). */

const INK = 'var(--ink)';

export const ICON_PAUSE = `<svg viewBox="0 0 26 26" aria-hidden="true"><path d="M8.5 5.5 L7.6 20.8 L11.6 20.4 L11.9 5.2 Z M15.2 5.4 L14.6 20.6 L18.6 20.9 L18.9 5.6 Z" fill="${INK}" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

export const ICON_SHARE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 V15 M7 7.5 L12 3 L17 7.5 M5 12 V20.5 H19 V12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 V15 M7 10.5 L12 15 L17 10.5 M5 19.5 H19" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const ICON_GEAR = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8 L13.6 5.2 L16.6 4.6 L17 7.6 L19.8 8.8 L18.6 11.6 L20.4 14 L17.8 15.4 L17.6 18.4 L14.6 18.2 L12.8 20.8 L10.6 18.8 L7.6 19.6 L7 16.6 L4.2 15.4 L5.6 12.6 L4 10 L6.6 8.8 L7 5.8 L10 6.2 Z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><circle cx="12.2" cy="12.4" r="3" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>`;

export const ICON_BOOK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5.5 C6 4.2 9 4.4 12 6.2 C15 4.4 18 4.2 21 5.5 V19 C18 17.8 15 18 12 19.8 C9 18 6 17.8 3 19 Z M12 6.2 V19.8" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linejoin="round"/></svg>`;

export const ICON_HOME = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11.5 L12 4 L20.5 11.5 M6 9.6 V20 H18 V9.6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const ICON_PLAY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5 L19.5 12.2 L6.6 19.6 Z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;

/** iOS-style share glyph used inside the add-to-home-screen hint. */
export const ICON_IOS_SHARE = `<svg class="share-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 V14 M8 6 L12 2.5 L16 6 M8 9.5 H5.5 V21 H18.5 V9.5 H16" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** Pencil used as the drawing cursor on the loading screen (tip at bottom-left). */
export const ICON_PENCIL = `<svg viewBox="0 0 54 54" aria-hidden="true"><g transform="rotate(-45 27 27)"><path d="M18 22 H52 V32 H18 Z" fill="var(--gold)" stroke="${INK}" stroke-width="2.4" stroke-linejoin="round"/><path d="M18 22 L6 27 L18 32 Z" fill="var(--ghost-2)" stroke="${INK}" stroke-width="2.4" stroke-linejoin="round"/><path d="M6 27 L10 25.4 V28.6 Z" fill="${INK}"/><path d="M45 22 V32" stroke="${INK}" stroke-width="2"/><path d="M48 22 H52 V32 H48" fill="var(--red-2)" stroke="${INK}" stroke-width="2.4"/><path d="M20 27 H44" stroke="var(--ember)" stroke-width="1.6"/></g></svg>`;

/** Finger-tap glyph for "tap to start". */
export const ICON_TAP = `<svg viewBox="0 0 60 60" aria-hidden="true"><circle cx="27" cy="16" r="10" fill="none" stroke="var(--red-2)" stroke-width="3" stroke-dasharray="5 4"/><path d="M24 16 C24 13 30 13 30 16 V30 L31 26 C32 23 37 24 36.5 27.5 L36 30 C37 27 42 28 41.5 31.5 L41 33 C42 30.5 47 31.5 46.5 35 C46 42 45 48 40 54 H27 C22 49 17 43 15 37 C14 34 18 32 20 34.5 L24 39 Z" fill="var(--paper)" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/></svg>`;

/** Comic starburst (used behind the death stamp & cover blurb). */
export function burstPath(cx: number, cy: number, r1: number, r2: number, n: number, seed = 1): string {
  let d = '';
  let a = seed * 0.7;
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? r2 * (0.86 + 0.14 * Math.sin(i * 2.3 + seed)) : r1 * (0.9 + 0.1 * Math.cos(i * 1.7));
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    d += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `;
    a += Math.PI / n;
  }
  return `${d}Z`;
}

/** Ink splat blob path (title logo backing). */
export function splatPath(cx: number, cy: number, r: number, n: number, seed = 1): string {
  let d = '';
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + 0.18 * Math.sin(a * 3 + seed) + 0.1 * Math.sin(a * 7 + seed * 2) + (i % 4 === 0 ? 0.22 : 0);
    const x = cx + Math.cos(a) * r * k * 1.9;
    const y = cy + Math.sin(a) * r * k * 0.62;
    d += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `;
  }
  return `${d}Z`;
}
