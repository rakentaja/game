/**
 * In-game debug tooling (PLAN §13): `?debug=1` adds a stats overlay and a tool strip
 * (free cam, page jump, god mode, reveal-mask / palette-violation views, spawns, panel cut,
 * boil, outline mode, quality); `?bench=1&page=N` runs a 30 s fixed camera tour and logs frame
 * times. Hooked from the shell with one line: `install(game)`.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FLAGS } from '../core/flags';
import type { EnemyKind, GameContext, QualityLevel } from '../core/types';
import { TUNING } from '../data/tuning';
import type { InkRenderer, OutlineMode } from '../render';
import { getLevel } from '../world/levels';

/** The slice of Game the tools need (structural, so there is no import cycle with the shell). */
export interface DebugHost {
  readonly ctx: GameContext;
  readonly render: InkRenderer;
}

export function install(game: DebugHost): () => void {
  const offs: (() => void)[] = [];
  const start = () => {
    if (FLAGS.debug) offs.push(installTools(game));
    if (FLAGS.bench) offs.push(runBench(game));
  };
  if (document.documentElement.dataset.ready === '1') start();
  else {
    const mo = new MutationObserver(() => {
      if (document.documentElement.dataset.ready !== '1') return;
      mo.disconnect();
      start();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ready'] });
    offs.push(() => mo.disconnect());
  }
  return () => {
    for (const o of offs) o();
  };
}

// ───────────────────────────── overlay + tools ─────────────────────────────

const CSS = `
#ink-dbg{position:fixed;left:6px;top:calc(6px + env(safe-area-inset-top));z-index:9999;font:11px/1.25 ui-monospace,Menlo,monospace;
  color:#efe1c9;pointer-events:none;max-width:calc(100vw - 12px)}
#ink-dbg pre{margin:0;padding:5px 7px;background:rgba(22,16,14,.78);border-left:3px solid #e2794e;white-space:pre}
#ink-dbg .row{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;pointer-events:auto}
#ink-dbg button{font:700 10px/1 ui-monospace,Menlo,monospace;text-transform:uppercase;color:#16100e;background:#efe1c9;
  border:1.5px solid #16100e;box-shadow:2px 2px 0 #16100e;padding:5px 6px;border-radius:2px}
#ink-dbg button.on{background:#f6c35a}
#ink-dbg.min .row{display:none}
@media (max-width:700px){.lil-gui.root.autoPlace{top:auto!important;bottom:calc(150px + env(safe-area-inset-bottom));max-height:45vh}}
`;

function installTools(game: DebugHost): () => void {
  const { ctx, render } = game;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.id = 'ink-dbg';
  const pre = document.createElement('pre');
  root.appendChild(pre);
  document.body.appendChild(root);
  const rows: HTMLDivElement[] = [];
  const row = () => {
    const r = document.createElement('div');
    r.className = 'row';
    root.appendChild(r);
    rows.push(r);
    return r;
  };
  const button = (
    r: HTMLDivElement,
    label: string,
    fn: (b: HTMLButtonElement) => void,
    on?: () => boolean,
  ) => {
    const b = document.createElement('button');
    b.textContent = label;
    const sync = () => b.classList.toggle('on', on?.() ?? false);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn(b);
      sync();
    });
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    sync();
    r.appendChild(b);
    return b;
  };

  // free cam: an orbit camera whose pose overrides the rig right before the frame is drawn
  const free = { on: false, cam: new THREE.PerspectiveCamera(), controls: null as OrbitControls | null };
  const offFree = render.onFrame(() => {
    if (!free.on || !free.controls) return;
    free.controls.update();
    render.camera.position.copy(free.cam.position);
    render.camera.quaternion.copy(free.cam.quaternion);
    render.camera.updateMatrixWorld();
  });
  const setFree = (on: boolean) => {
    free.on = on;
    ctx.input.setEnabled(!on);
    if (on) {
      free.cam.copy(render.camera);
      free.controls = new OrbitControls(free.cam, render.renderer.domElement);
      free.controls.enableDamping = true;
      const p = ctx.player?.position;
      free.controls.target.set(p?.x ?? 0, (p?.y ?? 0) + 1, p?.z ?? 0);
      free.controls.update();
    } else {
      free.controls?.dispose();
      free.controls = null;
    }
  };

  const r1 = row();
  button(r1, '–', () => root.classList.toggle('min'));
  button(
    r1,
    'free cam',
    () => setFree(!free.on),
    () => free.on,
  );
  button(
    r1,
    'god',
    () => {
      const p = ctx.player as unknown as { godMode?: boolean } | null;
      if (p) p.godMode = !p.godMode;
    },
    () => !!(ctx.player as unknown as { godMode?: boolean } | null)?.godMode,
  );
  const views = ['scene', 'mask', 'palette'];
  button(r1, 'view scene', (b) => {
    render.post.view = (render.post.view + 1) % 3;
    b.textContent = `view ${views[render.post.view]}`;
  });
  button(
    r1,
    'boil',
    () => {
      render.boil.enabled = !render.boil.enabled;
      render.shared.uBoilAmt!.value = render.boil.enabled ? 1 : 0;
    },
    () => render.boil.enabled,
  );
  const modes: OutlineMode[] = ['AB', 'A', 'B'];
  button(r1, `lines ${render.outlineMode}`, (b) => {
    const m = modes[(modes.indexOf(render.outlineMode) + 1) % modes.length]!;
    render.setOutlineMode(m);
    b.textContent = `lines ${m}`;
  });
  const qs: QualityLevel[] = ['auto', 'low', 'high'];
  button(r1, `q ${ctx.settings.quality}`, (b) => {
    const q = qs[(qs.indexOf(ctx.settings.quality) + 1) % qs.length]!;
    ctx.settings.quality = q;
    render.setQuality(q);
    b.textContent = `q ${q}`;
  });

  const r2 = row();
  for (const p of ['1', '2', '3', 'boss']) {
    button(
      r2,
      `p${p === 'boss' ? 'B' : p}`,
      () => {
        const u = new URL(location.href);
        u.searchParams.set('page', p);
        u.searchParams.set('debug', '1');
        location.href = u.toString();
      },
      () => FLAGS.page === p,
    );
  }
  const spawn = (kind: EnemyKind) => {
    const p = ctx.player?.position;
    const f = ctx.player?.facing;
    if (!p) return;
    ctx.events.emit('spawn:request', {
      kind,
      x: p.x + (f?.x ?? 0) * 4,
      z: p.z + (f?.z ?? 1) * 4,
      source: 'debug',
    });
  };
  button(r2, '+smudge', () => spawn('smudge'));
  button(r2, '+scrib', () => spawn('scribbler'));
  button(r2, '+blot', () => spawn('blot'));
  button(r2, 'panel', () => {
    const p = ctx.player?.position;
    ctx.events.emit('fx:panelCut', {
      word: 'krak',
      focus: [p?.x ?? 0, p?.y ?? 0, p?.z ?? 0],
      reason: 'debug',
    });
  });
  button(r2, 'ctx loss', () => render.simulateContextLoss(700));

  let acc = 0;
  let frames = 0;
  let worst = 0;
  const offHud = render.onFrame((dt) => {
    acc += dt;
    frames++;
    worst = Math.max(worst, dt);
    if (acc < 0.5) return;
    const s = render.stats;
    const prof = render.qualityProfile;
    pre.textContent =
      `${(frames / acc).toFixed(0)} fps  ${((acc / frames) * 1000).toFixed(1)}ms  worst ${(worst * 1000).toFixed(0)}ms\n` +
      `draws ${s.drawCalls}${s.drawCalls > 120 ? '!' : ''}  tris ${(s.triangles / 1000).toFixed(0)}k${s.triangles > 200_000 ? '!' : ''}\n` +
      `pr ${s.pixelRatio.toFixed(2)}  ${ctx.settings.quality}${prof.halfResEdges ? ' ½edge' : ''}  lines ${render.outlineMode}\n` +
      `page ${FLAGS.page ?? '-'}  reveal r ${ctx.reveal.radius.toFixed(1)}  energy ${ctx.player?.energy.toFixed(0) ?? '-'}`;
    acc = 0;
    frames = 0;
    worst = 0;
  });

  return () => {
    offHud();
    offFree();
    setFree(false);
    root.remove();
    style.remove();
  };
}

// ───────────────────────────── bench ─────────────────────────────

export interface BenchResult {
  page: string;
  seconds: number;
  frames: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxDraws: number;
  avgDraws: number;
  maxTris: number;
  avgTris: number;
  pixelRatio: number;
  viewport: string;
}

/**
 * 30 s tour along the level's path at the game-camera angle. Player control is off; the sim
 * keeps running (enemies, reveal), so it measures the real frame, not a static scene.
 */
function runBench(game: DebugHost): () => void {
  const { ctx, render } = game;
  const page = FLAGS.page ?? '1';
  const def = getLevel(page === 'boss' ? 'boss' : (Number(page) as 1 | 2 | 3));
  const pts = def.path.map(([x, z]) => new THREE.Vector3(x, 0, z));
  const curve = pts.length >= 2 ? new THREE.CatmullRomCurve3(pts) : null;
  const DURATION = 30;
  const WARMUP = 2;
  const pitch = THREE.MathUtils.degToRad(TUNING.camera.pitchDeg);
  const at = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  const times: number[] = [];
  let t = 0;
  let draws = 0;
  let tris = 0;
  let maxDraws = 0;
  let maxTris = 0;
  let done = false;
  ctx.input.setEnabled(false);
  ctx.player?.setControllable(false);
  // the bench must not be thrown by a hurt / dead player
  const pl = ctx.player as unknown as { godMode?: boolean } | null;
  if (pl) pl.godMode = true;
  const off = render.onFrame((dt) => {
    if (done) return;
    t += dt;
    const u = Math.min(1, Math.max(0, (t - WARMUP) / DURATION));
    if (curve) {
      curve.getPointAt(u, at);
      curve.getPointAt(Math.min(1, u + 0.02), ahead);
    } else at.set(0, 0, 0);
    // keep the reveal on the tour so the measured frame has ink in it
    ctx.reveal.center.set(at.x, 1.6, at.z);
    ctx.reveal.targetRadius = Math.sin(t * 0.7) > 0.3 ? TUNING.crystal.radiusHeld : TUNING.crystal.radiusIdle;
    const cam = render.camera;
    const d = TUNING.camera.distance;
    cam.position.set(at.x, at.y + Math.sin(pitch) * d, at.z + Math.cos(pitch) * d);
    cam.lookAt(at.x, at.y + 0.8, at.z);
    cam.updateMatrixWorld();
    if (t < WARMUP) return;
    // stats are from the previous frame's draw
    times.push(dt * 1000);
    const s = render.stats;
    draws += s.drawCalls;
    tris += s.triangles;
    maxDraws = Math.max(maxDraws, s.drawCalls);
    maxTris = Math.max(maxTris, s.triangles);
    if (u >= 1) {
      done = true;
      const sorted = [...times].sort((a, b) => a - b);
      const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
      const n = times.length;
      const result: BenchResult = {
        page: String(page),
        seconds: DURATION,
        frames: n,
        avgMs: +(times.reduce((a, b) => a + b, 0) / n).toFixed(2),
        p50Ms: +q(0.5).toFixed(2),
        p95Ms: +q(0.95).toFixed(2),
        p99Ms: +q(0.99).toFixed(2),
        maxDraws,
        avgDraws: Math.round(draws / n),
        maxTris,
        avgTris: Math.round(tris / n),
        pixelRatio: render.stats.pixelRatio,
        viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
      };
      console.log('[bench]', JSON.stringify(result));
      document.documentElement.dataset.bench = JSON.stringify(result);
      (window as unknown as { __bench?: BenchResult }).__bench = result;
    }
  });
  return off;
}
