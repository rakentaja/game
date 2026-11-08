/**
 * UI dev harness: /dev/ui.html?screen=loading|title|hud|pause|settings|cover|credits|death|card
 *   &lang=tr|en   &live=1 (simulate gameplay events on the HUD)   &p=0.6 (freeze loading progress)
 *   &clean=1 (hide the harness nav, for screenshots)   &boss=1 (HUD boss bar)   &hint=move|crystal|…
 * The "live scene" behind transparent screens is a static painting from the cover fallback art.
 */
import { EventBus, type GameEvents } from '../core/events';
import { DEFAULT_SETTINGS, type RunStats, type Settings } from '../core/types';
import { TUNING } from '../data/tuning';
import { install } from '../ui';
import type { Hint } from '../ui/hud/tutorial';
import { drawFallbackArt } from '../ui/screens/cover-art';

const q = new URLSearchParams(location.search);
const screen = q.get('screen') ?? 'title';
const live = q.get('live') === '1';

// fake live scene
const gl = document.getElementById('gl') as HTMLCanvasElement;
function paintScene() {
  const dpr = Math.min(2, devicePixelRatio);
  gl.width = innerWidth * dpr;
  gl.height = innerHeight * dpr;
  const g = gl.getContext('2d')!;
  drawFallbackArt(g, 0, 0, gl.width, gl.height, 11);
}
paintScene();
addEventListener('resize', paintScene);

const events = new EventBus<GameEvents>();
const settings: Settings = { ...DEFAULT_SETTINGS };
if (q.get('lang') === 'tr' || q.get('lang') === 'en') {
  // harness override without persisting
  localStorage.setItem(
    'inkwake:settings',
    JSON.stringify({ ...JSON.parse(localStorage.getItem('inkwake:settings') ?? '{}'), lang: q.get('lang') }),
  );
  localStorage.setItem('inkwake:settings-seen', '{"v":true}');
}
events.on('sfx:play', (e) => console.debug('[sfx]', e.id));
events.on('settings:changed', (e) => console.debug('[settings]', e.key, settings));
events.on('game:pause', (e) => console.debug('[pause]', e.paused));

const ui = install({ events, settings, tuning: TUNING }, { onQuit: () => console.debug('[quit]') });
(window as unknown as { ui: typeof ui; events: typeof events }).ui = ui;
(window as unknown as { events: typeof events }).events = events;

let last = performance.now();
function frame(now: number) {
  ui.update(Math.min(0.1, (now - last) / 1000));
  last = now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

const stats: RunStats = {
  timeS: 402,
  ghostsInked: 27,
  inkCollected: 318,
  pagesTorn: 6,
  deaths: 1,
  boltsFired: 64,
  boltsHit: 52,
  bestPanel: null,
};

function hudDemo() {
  ui.showHud();
  events.emit('player:damaged', { amount: 1, source: 'smudge', pagesLeft: 4 });
  events.emit('player:damaged', { amount: 1, source: 'smudge', pagesLeft: 3 });
  events.emit('energy:changed', { value: 62, max: 100 });
  if (q.get('boss') === '1') {
    events.emit('boss:phase', { phase: 2 });
    events.emit('boss:weakpoint', { index: 0, destroyed: true });
  }
  const hint = (q.get('hint') as Hint | null) ?? 'crystal';
  ui.hint(hint);
  if (q.get('ring') !== '0') {
    const ringT = Number(q.get('ring') ?? 0.62);
    const keep = () => {
      events.emit('sketch:progress', { id: 'bridge', t: ringT });
      setTimeout(keep, 200);
    };
    keep();
  }
  if (!live) return;
  let e = 62;
  let pages = 3;
  setInterval(() => {
    e = e <= 2 ? 100 : e - 3;
    events.emit('energy:changed', { value: e, max: 100 });
  }, 260);
  setInterval(() => {
    pages = pages <= 1 ? 5 : pages - 1;
    if (pages === 5) events.emit('player:respawn', { checkpointId: 'cp' });
    else events.emit('player:damaged', { amount: 1, source: 'smudge', pagesLeft: pages });
  }, 2400);
}

async function run() {
  switch (screen) {
    case 'loading': {
      ui.showLoading();
      const fixed = q.get('p');
      if (fixed != null) {
        ui.setProgress(Number(fixed));
        return;
      }
      let p = 0;
      const id = setInterval(() => {
        p += 0.03 + Math.random() * 0.05;
        ui.setProgress(p);
        if (p >= 1) clearInterval(id);
      }, 120);
      await ui.finishLoading();
      await ui.title();
      hudDemo();
      return;
    }
    case 'title':
      await ui.title({ continuePage: q.get('continue') ? Number(q.get('continue')) : null });
      hudDemo();
      return;
    case 'hud':
      hudDemo();
      return;
    case 'pause':
      hudDemo();
      ui.setPaused(true);
      return;
    case 'settings':
      await ui.openSettings();
      return;
    case 'credits':
      await ui.openCredits();
      return;
    case 'cover':
      await ui.cover(stats, { bestTimeS: 431 });
      await ui.title();
      return;
    case 'death':
      hudDemo();
      events.emit('player:died', {});
      if (live) setTimeout(() => events.emit('player:respawn', { checkpointId: 'cp' }), 3000);
      return;
    case 'card':
      hudDemo();
      events.emit('page:start', { page: (q.get('page') as '1' | 'boss' | null) === 'boss' ? 'boss' : 1 });
      return;
  }
}
void run();

if (q.get('clean') !== '1') {
  const nav = document.createElement('nav');
  nav.style.cssText =
    'position:fixed;z-index:99;left:50%;transform:translateX(-50%);bottom:max(4px,env(safe-area-inset-bottom));display:flex;gap:4px;flex-wrap:wrap;justify-content:center;font:12px monospace;opacity:.85';
  for (const s of ['loading', 'title', 'hud', 'pause', 'settings', 'cover', 'credits', 'death', 'card']) {
    const a = document.createElement('a');
    const u = new URLSearchParams(location.search);
    u.set('screen', s);
    a.href = `?${u}`;
    a.textContent = s;
    a.style.cssText = `background:${s === screen ? '#f6c35a' : '#efe1c9'};color:#16100e;padding:2px 6px;border:1px solid #16100e;text-decoration:none`;
    nav.append(a);
  }
  const l = document.createElement('a');
  const u = new URLSearchParams(location.search);
  u.set('lang', ui.i18n.lang === 'tr' ? 'en' : 'tr');
  l.href = `?${u}`;
  l.textContent = ui.i18n.lang === 'tr' ? 'EN' : 'TR';
  l.style.cssText = 'background:#16100e;color:#efe1c9;padding:2px 6px;text-decoration:none';
  nav.append(l);
  document.body.append(nav);
}
