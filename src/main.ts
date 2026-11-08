import * as THREE from 'three';
import { FLAGS } from './core/flags';
import { Game } from './game/Game';

THREE.ColorManagement.enabled = false;

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const game = new Game(canvas);
void game.boot().catch((e) => {
  console.error(e);
  document.documentElement.dataset.bootError = String(e);
});
if (FLAGS.debug) void import('./debug/debug').then((m) => m.initDebug());
if (FLAGS.debug || FLAGS.bench) void import('./debug/tools').then((m) => m.install(game));
Object.assign(window as unknown as Record<string, unknown>, { __game: game });
