import * as THREE from 'three';
import { FLAGS } from './core/flags';
import { FixedLoop } from './core/loop';
import { PAL } from './data/palette';
import { TUNING } from './data/tuning';

THREE.ColorManagement.enabled = false;

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(Math.min(devicePixelRatio, TUNING.quality.maxPixelRatio));
renderer.setSize(innerWidth, innerHeight, false);
renderer.setClearColor(PAL.void, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(TUNING.camera.fovPortrait, innerWidth / innerHeight, 0.1, 80);
camera.position.set(0, 4, 8);
camera.lookAt(0, 1, 0);

const loop = new FixedLoop(
  {
    step() {},
    render() {
      renderer.render(scene, camera);
    },
  },
  TUNING.sim.hz,
  TUNING.sim.maxStepsPerFrame,
);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
});

loop.start();
document.documentElement.dataset.ready = '1';
if (FLAGS.debug) void import('./debug/debug').then((m) => m.initDebug());
