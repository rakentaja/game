/**
 * Second local player's input (`?local2p=1`): keyboard IJKL move, U hold crystal, O bolt,
 * H dash (Y snuff), or the SECOND connected gamepad (left stick, RT/LT crystal, A dash, X/B bolt).
 *
 * Player 1's Input also binds J/K (bolt/dash). While this input is alive its capture-phase key
 * listener swallows the second player's keys, so they never reach player 1.
 */
import * as THREE from 'three';
import type { InputAPI, InputState } from '../core/types';

const KEYS = new Set(['KeyI', 'KeyJ', 'KeyK', 'KeyL', 'KeyU', 'KeyO', 'KeyH', 'KeyY']);
const PAD_DEAD = 0.22;

export class SecondInput implements InputAPI {
  readonly state: InputState = {
    move: new THREE.Vector2(),
    crystalHeld: false,
    boltPressed: false,
    dashPressed: false,
    dashDir: new THREE.Vector2(),
    pausePressed: false,
    snuffPressed: false,
    device: 'keyboard',
  };
  private keys = new Set<string>();
  private bolt = false;
  private dash = false;
  private snuff = false;
  private enabled = true;
  private padPrev = new Uint8Array(16);
  private readonly target: EventTarget | null;

  constructor(target: EventTarget | null = typeof window !== 'undefined' ? window : null) {
    this.target = target;
    target?.addEventListener('keydown', this.onDown as EventListener, true);
    target?.addEventListener('keyup', this.onUp as EventListener, true);
  }

  private onDown = (e: KeyboardEvent): void => {
    if (!KEYS.has(e.code)) return;
    e.stopImmediatePropagation();
    if (!this.enabled || e.repeat) return;
    this.keys.add(e.code);
    this.state.device = 'keyboard';
    if (e.code === 'KeyO') this.bolt = true;
    else if (e.code === 'KeyH') this.dash = true;
    else if (e.code === 'KeyY') this.snuff = true;
  };

  private onUp = (e: KeyboardEvent): void => {
    if (!KEYS.has(e.code)) return;
    e.stopImmediatePropagation();
    this.keys.delete(e.code);
  };

  poll(): void {
    const s = this.state;
    let mx = (this.keys.has('KeyL') ? 1 : 0) - (this.keys.has('KeyJ') ? 1 : 0);
    let my = (this.keys.has('KeyI') ? 1 : 0) - (this.keys.has('KeyK') ? 1 : 0);
    let crystal = this.keys.has('KeyU');
    let bolt = this.bolt;
    let dash = this.dash;
    let snuff = this.snuff;
    this.bolt = this.dash = this.snuff = false;
    s.dashDir.set(0, 0);
    const pad = this.pad();
    if (pad && this.enabled) {
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      const len = Math.hypot(ax, ay);
      if (len > PAD_DEAD) {
        const m = Math.min(1, (len - PAD_DEAD) / (1 - PAD_DEAD));
        mx = (ax / len) * m;
        my = (-ay / len) * m;
        s.device = 'gamepad';
      }
      const b = pad.buttons;
      const on = (i: number) => !!b[i] && (b[i]!.pressed || b[i]!.value > 0.35);
      const edge = (i: number) => {
        const now = on(i) ? 1 : 0;
        const was = this.padPrev[i]!;
        this.padPrev[i] = now;
        return now === 1 && was === 0;
      };
      if (edge(0)) {
        dash = true;
        if (len > PAD_DEAD) s.dashDir.set(ax / len, -ay / len);
      }
      if (edge(1) || edge(2)) bolt = true;
      if (edge(3)) snuff = true;
      crystal = crystal || on(5) || on(6) || on(7);
    }
    const l = Math.hypot(mx, my);
    if (l > 1) {
      mx /= l;
      my /= l;
    }
    if (!this.enabled) {
      mx = my = 0;
      crystal = bolt = dash = snuff = false;
    }
    s.move.set(mx, my);
    s.crystalHeld = crystal;
    s.boltPressed = bolt;
    s.dashPressed = dash;
    s.snuffPressed = snuff;
    s.pausePressed = false;
  }

  /** The second connected gamepad (player 1's Input takes the first). */
  private pad(): Gamepad | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    let seen = 0;
    for (const p of navigator.getGamepads()) {
      if (!p?.connected) continue;
      if (seen++ === 1) return p;
    }
    return null;
  }

  setLeftHanded(_v: boolean): void {}

  setEnabled(v: boolean): void {
    this.enabled = v;
    if (!v) this.keys.clear();
  }

  dispose(): void {
    this.target?.removeEventListener('keydown', this.onDown as EventListener, true);
    this.target?.removeEventListener('keyup', this.onUp as EventListener, true);
  }
}

/** Input that never moves (remote wizards' visual body). Its state is written by its owner. */
export class PuppetInput implements InputAPI {
  readonly state: InputState = {
    move: new THREE.Vector2(),
    crystalHeld: false,
    boltPressed: false,
    dashPressed: false,
    dashDir: new THREE.Vector2(),
    pausePressed: false,
    snuffPressed: false,
    device: 'touch',
  };
  poll(): void {}
  setLeftHanded(_v: boolean): void {}
  setEnabled(_v: boolean): void {}
  dispose(): void {}
}
