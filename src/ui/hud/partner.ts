/**
 * Co-op partner HUD (lazy: only the co-op chunk imports it). Partner card (pages, ink,
 * connection tier + RTT, status), off-screen partner arrow, tether page-curl vignette,
 * "UNFINISHED" labels + reprint rings over downed wizards, and a centre banner (MEANWHILE…,
 * reconnecting countdown, solo, waiting at the exit). `update` is allocation-free.
 */
import type { Camera } from 'three';
import { Vector3 } from 'three';

export interface DownedView {
  pos: Vector3;
  revive: number;
  on: boolean;
}

export interface PartnerView {
  name: string;
  pages: number;
  maxPages: number;
  ink: number;
  inkMax: number;
  /** i18n'd tier label + RTT ms (online only). */
  tier: string | null;
  rtt: number;
  status: string | null;
  /** Partner world position (null hides the arrow). */
  partner: Vector3 | null;
  downed: DownedView[];
  strain: number;
  reduceMotion: boolean;
  /** Partner's Splash (ultimate) meter 0..1; undefined hides the bar. */
  splash?: number;
}

const CSS = `
.coop-hud{position:fixed;inset:0;pointer-events:none;z-index:40;font-family:var(--f-letter,sans-serif);color:var(--ink,#16100e)}
.coop-card{position:absolute;top:calc(var(--pad-t,0px) + 58px);right:calc(var(--pad-r,0px) + 10px);background:var(--paper,#efe1c9);border:2px solid var(--ink,#16100e);padding:4px 8px 5px;min-width:96px;font-size:12px;line-height:1.2;transform:rotate(1.5deg);box-shadow:3px 3px 0 var(--ink,#16100e)}
.coop-card b{font-family:var(--f-display,sans-serif);letter-spacing:.04em;display:block;font-size:13px}
.coop-pips{display:flex;gap:2px;margin:2px 0}
.coop-pips i{display:block;width:9px;height:12px;border:1.5px solid var(--ink,#16100e);background:var(--paper,#efe1c9)}
.coop-pips i.on{background:var(--red-2,#b8655c)}
.coop-ink{height:5px;border:1.5px solid var(--ink,#16100e);margin:2px 0}
.coop-ink span{display:block;height:100%;background:var(--ink,#16100e)}
.coop-splash{height:4px;border:1.5px solid var(--ink,#16100e);margin:2px 0}
.coop-splash span{display:block;height:100%;background:var(--gold,#f6c35a)}
.coop-splash.full span{background:var(--red-2,#b8655c)}
.coop-net{font-size:10px;opacity:.8}
.coop-status{font-size:10px;color:var(--red-1,#6e2f2c)}
.coop-arrow{position:absolute;width:0;height:0;border-left:11px solid transparent;border-right:11px solid transparent;border-bottom:22px solid var(--teal-1,#1d3a38);margin:-11px 0 0 -11px;filter:drop-shadow(1px 1px 0 var(--paper,#efe1c9))}
.coop-vig{position:absolute;inset:0;opacity:0;background:radial-gradient(ellipse at center,transparent 55%,var(--ink,#16100e) 130%)}
.coop-label{position:absolute;transform:translate(-50%,-100%);font-family:var(--f-display,sans-serif);font-size:13px;letter-spacing:.08em;background:var(--paper,#efe1c9);border:1.5px dashed var(--staff-3,#6c5d63);padding:1px 6px;color:var(--staff-2,#4b3f44)}
.coop-label s{display:block;height:3px;background:var(--gold,#f6c35a);text-decoration:none;margin-top:2px}
.coop-banner{position:absolute;left:50%;top:22%;transform:translate(-50%,-50%) rotate(-2deg);font-family:var(--f-display,sans-serif);font-size:22px;letter-spacing:.06em;background:var(--paper,#efe1c9);border:3px solid var(--ink,#16100e);padding:6px 16px;box-shadow:4px 4px 0 var(--ink,#16100e);white-space:nowrap}
`;

let styled = false;
const _p = new Vector3();

export class PartnerHud {
  readonly el: HTMLElement;
  private card: HTMLElement;
  private nameEl: HTMLElement;
  private pips: HTMLElement;
  private pipEls: HTMLElement[] = [];
  private inkFill: HTMLElement;
  private splashBar: HTMLElement;
  private splashFill: HTMLElement;
  private netEl: HTMLElement;
  private statusEl: HTMLElement;
  private arrow: HTMLElement;
  private vig: HTMLElement;
  private labels: { el: HTMLElement; bar: HTMLElement }[] = [];
  private bannerEl: HTMLElement;
  private bannerUntil = 0;
  private clock = 0;
  private last = { pages: -1, ink: -1, splash: -2, net: '', status: '', name: '' };

  constructor(t: (k: string, vars?: Record<string, string | number>) => string, root: HTMLElement) {
    if (!styled && typeof document !== 'undefined') {
      styled = true;
      const st = document.createElement('style');
      st.textContent = CSS;
      document.head.append(st);
    }
    const mk = (cls: string, parent: HTMLElement, tag = 'div') => {
      const e = document.createElement(tag);
      e.className = cls;
      parent.append(e);
      return e;
    };
    this.el = document.createElement('div');
    this.el.className = 'coop-hud';
    this.el.setAttribute('aria-hidden', 'true');
    this.vig = mk('coop-vig', this.el);
    this.card = mk('coop-card', this.el);
    this.card.setAttribute('role', 'status');
    this.nameEl = mk('', this.card, 'b');
    this.pips = mk('coop-pips', this.card);
    this.inkFill = mk('', mk('coop-ink', this.card), 'span');
    this.splashBar = mk('coop-splash', this.card);
    this.splashFill = mk('', this.splashBar, 'span');
    this.splashBar.style.display = 'none';
    this.netEl = mk('coop-net', this.card);
    this.statusEl = mk('coop-status', this.card);
    this.arrow = mk('coop-arrow', this.el);
    for (let i = 0; i < 2; i++) {
      const el = mk('coop-label', this.el);
      el.textContent = t('coop.run.unfinished');
      const bar = mk('', el, 's');
      el.style.display = 'none';
      this.labels.push({ el, bar });
    }
    this.bannerEl = mk('coop-banner', this.el);
    this.bannerEl.style.display = 'none';
    root.append(this.el);
  }

  /** Show a centre banner for `seconds` (Infinity until `banner(null)`). */
  banner(text: string | null, seconds = 2.2): void {
    if (!text) {
      this.bannerEl.style.display = 'none';
      this.bannerUntil = 0;
      return;
    }
    this.bannerEl.textContent = text;
    this.bannerEl.style.display = '';
    this.bannerUntil = this.clock + seconds;
  }

  setVisible(v: boolean): void {
    this.el.style.display = v ? '' : 'none';
  }

  update(dt: number, v: PartnerView, cam: Camera | null, w: number, h: number): void {
    this.clock += dt;
    if (this.bannerUntil > 0 && this.clock > this.bannerUntil) this.banner(null);
    const L = this.last;
    if (v.name !== L.name) this.nameEl.textContent = L.name = v.name;
    const pages = Math.ceil(v.pages);
    if (pages !== L.pages || this.pipEls.length !== v.maxPages) {
      L.pages = pages;
      while (this.pipEls.length < v.maxPages)
        this.pipEls.push(this.pips.appendChild(document.createElement('i')));
      while (this.pipEls.length > v.maxPages) this.pipEls.pop()!.remove();
      for (let i = 0; i < this.pipEls.length; i++) this.pipEls[i]!.className = i < pages ? 'on' : '';
    }
    const sp = v.splash === undefined ? -1 : Math.round(Math.min(1, Math.max(0, v.splash)) * 100);
    if (sp !== L.splash) {
      L.splash = sp;
      this.splashBar.style.display = sp < 0 ? 'none' : '';
      this.splashFill.style.width = `${Math.max(0, sp)}%`;
      this.splashBar.classList.toggle('full', sp >= 100);
    }
    const ink = Math.round((v.ink / Math.max(1, v.inkMax)) * 100);
    if (ink !== L.ink) {
      L.ink = ink;
      this.inkFill.style.width = `${ink}%`;
    }
    const net = v.tier ? `${v.tier} · ${Number.isFinite(v.rtt) ? Math.round(v.rtt) : '—'} ms` : '';
    if (net !== L.net) this.netEl.textContent = L.net = net;
    const status = v.status ?? '';
    if (status !== L.status) this.statusEl.textContent = L.status = status;
    this.vig.style.opacity = String(Math.min(0.85, v.strain * 0.9));

    // off-screen partner arrow
    let showArrow = false;
    if (cam && v.partner) {
      _p.copy(v.partner).project(cam);
      const behind = _p.z > 1;
      const sx = _p.x * (behind ? -1 : 1);
      const sy = _p.y * (behind ? -1 : 1);
      if (behind || Math.abs(sx) > 0.95 || Math.abs(sy) > 0.95) {
        showArrow = true;
        const k = 0.88 / Math.max(Math.abs(sx), Math.abs(sy), 1e-3);
        const ax = sx * Math.min(1, k);
        const ay = sy * Math.min(1, k);
        const px = (ax * 0.5 + 0.5) * w;
        const py = (-ay * 0.5 + 0.5) * h;
        const ang = Math.atan2(sx, sy);
        this.arrow.style.transform = `translate(${px.toFixed(1)}px,${py.toFixed(1)}px) rotate(${ang.toFixed(3)}rad)`;
      }
    }
    this.arrow.style.display = showArrow ? '' : 'none';

    for (let i = 0; i < this.labels.length; i++) {
      const lab = this.labels[i]!;
      const d = v.downed[i];
      if (!d?.on || !cam) {
        lab.el.style.display = 'none';
        continue;
      }
      _p.set(d.pos.x, d.pos.y + 1.7, d.pos.z).project(cam);
      if (_p.z > 1) {
        lab.el.style.display = 'none';
        continue;
      }
      lab.el.style.display = '';
      lab.el.style.left = `${((_p.x * 0.5 + 0.5) * w).toFixed(1)}px`;
      lab.el.style.top = `${((-_p.y * 0.5 + 0.5) * h).toFixed(1)}px`;
      lab.bar.style.width = `${Math.round(d.revive * 100)}%`;
    }
  }

  dispose(): void {
    this.el.remove();
  }
}
