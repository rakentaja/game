/**
 * InputAPI implementation: touch (dynamic joystick + action gestures), keyboard + mouse, Gamepad.
 * Sources write into pending latches; `poll()` (once per sim step) publishes them to `state`, so
 * edge flags are true for exactly one step and nothing is lost between frames.
 */
import * as THREE from 'three';
import { TUNING } from '../../data/tuning';
import type { InputAPI, InputState } from '../types';
import { GestureClassifier, type GestureKind } from './gesture';
import { haptics } from './haptics';
import { Joystick } from './joystick';
import { TouchVisuals } from './touch-visual';

export interface InputOptions {
  /** Element receiving pointer events (canvas or app root). */
  element: HTMLElement;
  /** Where to mount touch visuals (defaults to element's parent). Pass null to disable. */
  overlay?: HTMLElement | null;
  leftHanded?: boolean;
  /** Keyboard target (default window). */
  keyTarget?: Window | HTMLElement;
}

/** Diagnostics hook for the dev harness gesture overlay. */
export type GestureDebug = (
  kind: GestureKind,
  info: { ms: number; px: number; x: number; y: number },
) => void;

const MAX_ACTION = 4;
const PAD_DEAD = 0.18;

interface ActionSlot {
  id: number;
  x: number;
  y: number;
  cls: GestureClassifier;
}

export class Input implements InputAPI {
  readonly state: InputState = {
    move: new THREE.Vector2(),
    crystalHeld: false,
    boltPressed: false,
    dashPressed: false,
    dashDir: new THREE.Vector2(),
    pausePressed: false,
    device: 'touch',
  };

  onGesture: GestureDebug | null = null;
  readonly joystick: Joystick;
  readonly visuals: TouchVisuals | null;

  private el: HTMLElement;
  private keyTarget: Window | HTMLElement;
  private leftHanded: boolean;
  private enabled = true;
  private joyId = -1;
  private slots: ActionSlot[] = [];
  private rect = { left: 0, top: 0, width: 1, height: 1 };

  // latches
  private boltLatch = false;
  private dashLatch = false;
  private pauseLatch = false;
  private dashX = 0;
  private dashY = 0;
  private mouseCrystal = false;
  private keys = new Set<string>();
  private padPrev = new Uint8Array(17);
  private padMoveX = 0;
  private padMoveY = 0;
  private padCrystal = false;

  constructor(opts: InputOptions) {
    this.el = opts.element;
    this.keyTarget = opts.keyTarget ?? window;
    this.leftHanded = !!opts.leftHanded;
    const g = TUNING.gesture;
    this.joystick = new Joystick(g.joyRadiusPx, g.deadZone, true);
    const overlayParent = opts.overlay === undefined ? this.el.parentElement : opts.overlay;
    this.visuals = overlayParent ? new TouchVisuals(overlayParent, g.joyRadiusPx) : null;
    for (let i = 0; i < MAX_ACTION; i++) {
      const slot: ActionSlot = { id: -1, x: 0, y: 0, cls: null as unknown as GestureClassifier };
      slot.cls = new GestureClassifier(TUNING.gesture, (k, dx, dy) => this.onAction(slot, i, k, dx, dy));
      this.slots.push(slot);
    }
    this.el.style.touchAction = 'none';
    this.el.addEventListener('pointerdown', this.onDown, { passive: false });
    this.el.addEventListener('pointermove', this.onMove, { passive: false });
    this.el.addEventListener('pointerup', this.onUp, { passive: false });
    this.el.addEventListener('pointercancel', this.onCancel);
    this.el.addEventListener('lostpointercapture', this.onCancel);
    this.el.addEventListener('contextmenu', this.prevent);
    this.el.addEventListener('touchstart', this.prevent, { passive: false });
    this.keyTarget.addEventListener('keydown', this.onKeyDown as EventListener);
    this.keyTarget.addEventListener('keyup', this.onKeyUp as EventListener);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('resize', this.measure);
    this.measure();
  }

  // ───────── InputAPI ─────────

  poll(): void {
    const s = this.state;
    s.boltPressed = false;
    s.dashPressed = false;
    s.pausePressed = false;
    if (!this.enabled) {
      // Pause stays live so Esc / Start can resume.
      this.pollPad();
      s.pausePressed = this.pauseLatch;
      this.boltLatch = this.dashLatch = this.pauseLatch = false;
      s.move.set(0, 0);
      s.crystalHeld = false;
      return;
    }
    const now = performance.now();
    let touchHold = false;
    for (const sl of this.slots) {
      if (sl.id < 0) continue;
      sl.cls.update(now);
      if (sl.cls.phase === 'holding') touchHold = true;
    }
    this.pollPad();

    // Move: touch stick > keyboard > pad (whichever is live).
    const kx = (this.key('KeyD', 'ArrowRight') ? 1 : 0) - (this.key('KeyA', 'ArrowLeft') ? 1 : 0);
    const ky = (this.key('KeyW', 'ArrowUp') ? 1 : 0) - (this.key('KeyS', 'ArrowDown') ? 1 : 0);
    if (this.joystick.active) s.move.set(this.joystick.x, this.joystick.y);
    else if (kx || ky) {
      s.move.set(kx, ky);
      if (kx && ky) s.move.multiplyScalar(Math.SQRT1_2);
      // Alt walks (keyboard is digital).
      if (this.keys.has('AltLeft') || this.keys.has('AltRight')) s.move.multiplyScalar(0.45);
    } else s.move.set(this.padMoveX, this.padMoveY);

    const keyCrystal = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.keys.has('KeyL');
    s.crystalHeld = touchHold || this.mouseCrystal || keyCrystal || this.padCrystal;

    if (this.boltLatch) s.boltPressed = true;
    if (this.pauseLatch) s.pausePressed = true;
    if (this.dashLatch) {
      s.dashPressed = true;
      if (this.dashX || this.dashY) s.dashDir.set(this.dashX, this.dashY);
      else if (s.move.lengthSq() > 0.01) s.dashDir.copy(s.move).normalize();
      else s.dashDir.set(0, 0);
    }
    this.boltLatch = this.dashLatch = this.pauseLatch = false;
    this.dashX = this.dashY = 0;
  }

  setLeftHanded(v: boolean): void {
    this.leftHanded = v;
  }

  setEnabled(v: boolean): void {
    if (this.enabled === v) return;
    this.enabled = v;
    if (!v) this.releaseAll();
  }

  dispose(): void {
    this.el.removeEventListener('pointerdown', this.onDown);
    this.el.removeEventListener('pointermove', this.onMove);
    this.el.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('pointercancel', this.onCancel);
    this.el.removeEventListener('lostpointercapture', this.onCancel);
    this.el.removeEventListener('contextmenu', this.prevent);
    this.el.removeEventListener('touchstart', this.prevent);
    this.keyTarget.removeEventListener('keydown', this.onKeyDown as EventListener);
    this.keyTarget.removeEventListener('keyup', this.onKeyUp as EventListener);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('resize', this.measure);
    this.visuals?.dispose();
  }

  // ───────── Synthetic input (autoplay bot, tests, cinematics) ─────────

  pressBolt(): void {
    this.boltLatch = true;
  }

  pressDash(dx = 0, dy = 0): void {
    this.dashLatch = true;
    this.dashX = dx;
    this.dashY = dy;
  }

  pressPause(): void {
    this.pauseLatch = true;
  }

  // ───────── Pointer ─────────

  private measure = (): void => {
    const r = this.el.getBoundingClientRect();
    this.rect.left = r.left;
    this.rect.top = r.top;
    this.rect.width = Math.max(1, r.width);
    this.rect.height = Math.max(1, r.height);
    const g = TUNING.gesture;
    // Scale the stick a little on tablets, keep it thumb-sized on phones.
    const short = Math.min(this.rect.width, this.rect.height);
    this.joystick.radius = Math.max(44, Math.min(g.joyRadiusPx * 1.25, g.joyRadiusPx * (short / 390)));
    this.joystick.deadZone = g.deadZone;
  };

  private prevent = (e: Event): void => {
    if (e.cancelable) e.preventDefault();
  };

  private isMoveSide(x: number): boolean {
    const left = x - this.rect.left < this.rect.width * 0.5;
    return this.leftHanded ? !left : left;
  }

  private onDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    if (e.cancelable) e.preventDefault();
    const x = e.clientX - this.rect.left;
    const y = e.clientY - this.rect.top;
    if (e.pointerType === 'mouse') {
      this.state.device = 'keyboard';
      if (e.button === 0) {
        this.boltLatch = true;
        this.onGesture?.('tap', { ms: 0, px: 0, x, y });
      } else if (e.button === 2) this.mouseCrystal = true;
      return;
    }
    this.state.device = 'touch';
    this.capture(e);
    if (this.isMoveSide(e.clientX)) {
      if (this.joyId >= 0) return;
      this.joyId = e.pointerId;
      this.joystick.radius = this.joystick.radius || TUNING.gesture.joyRadiusPx;
      this.joystick.start(x, y);
      this.visuals?.joyShow(x, y);
      return;
    }
    const slotIdx = this.slots.findIndex((s) => s.id < 0);
    if (slotIdx < 0) return;
    const sl = this.slots[slotIdx]!;
    sl.id = e.pointerId;
    sl.x = x;
    sl.y = y;
    sl.cls.down(e.timeStamp || performance.now(), x, y);
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.enabled || e.pointerType === 'mouse') return;
    const x = e.clientX - this.rect.left;
    const y = e.clientY - this.rect.top;
    if (e.pointerId === this.joyId) {
      // Coalesced events give the latest finger position at full rate; we only need the last.
      this.joystick.move(x, y);
      this.visuals?.joyMove(this.joystick.ox, this.joystick.oy, this.joystick.kx, this.joystick.ky);
      return;
    }
    for (let i = 0; i < this.slots.length; i++) {
      const sl = this.slots[i]!;
      if (sl.id !== e.pointerId) continue;
      sl.x = x;
      sl.y = y;
      sl.cls.move(e.timeStamp || performance.now(), x, y);
      this.visuals?.holdMove(i, x, y);
      return;
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') {
      if (e.button === 2) this.mouseCrystal = false;
      return;
    }
    const x = e.clientX - this.rect.left;
    const y = e.clientY - this.rect.top;
    if (e.pointerId === this.joyId) {
      this.joyId = -1;
      this.joystick.end();
      this.visuals?.joyHide();
      return;
    }
    for (const sl of this.slots) {
      if (sl.id !== e.pointerId) continue;
      sl.x = x;
      sl.y = y;
      sl.cls.up(e.timeStamp || performance.now(), x, y);
      sl.id = -1;
      return;
    }
  };

  private onCancel = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') {
      this.mouseCrystal = false;
      return;
    }
    if (e.pointerId === this.joyId) {
      this.joyId = -1;
      this.joystick.end();
      this.visuals?.joyHide();
      return;
    }
    for (const sl of this.slots) {
      if (sl.id !== e.pointerId) continue;
      sl.cls.cancel();
      sl.id = -1;
    }
  };

  private capture(e: PointerEvent): void {
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
  }

  private onAction(sl: ActionSlot, idx: number, kind: GestureKind, dx: number, dy: number): void {
    const g = TUNING.haptics;
    switch (kind) {
      case 'tap':
        this.boltLatch = true;
        this.visuals?.tap(sl.x, sl.y);
        haptics.pulse(g.tap);
        break;
      case 'swipe':
        this.dashLatch = true;
        this.dashX = dx;
        this.dashY = -dy;
        this.visuals?.swipe(sl.cls.x0, sl.cls.y0, dx, dy);
        haptics.pulse(g.dash);
        break;
      case 'holdStart':
        this.visuals?.hold(idx, sl.x, sl.y, true);
        haptics.pulse(g.crystal);
        break;
      case 'holdEnd':
        this.visuals?.hold(idx, sl.x, sl.y, false);
        break;
      default:
        break;
    }
    if (this.onGesture) {
      const ms = (performance.now() - sl.cls.t0) | 0;
      this.onGesture(kind, { ms, px: sl.cls.maxTravel | 0, x: sl.x, y: sl.y });
    }
  }

  private releaseAll(): void {
    this.joyId = -1;
    this.joystick.end();
    for (const sl of this.slots) {
      sl.cls.cancel();
      sl.id = -1;
    }
    this.mouseCrystal = false;
    this.keys.clear();
    this.boltLatch = this.dashLatch = this.pauseLatch = false;
    this.visuals?.clear();
    this.state.move.set(0, 0);
    this.state.crystalHeld = false;
  }

  private onBlur = (): void => {
    // Never leave a key or the crystal stuck on when the tab loses focus.
    const was = this.enabled;
    this.releaseAll();
    this.enabled = was;
  };

  // ───────── Keyboard ─────────

  private key(a: string, b: string): boolean {
    return this.keys.has(a) || this.keys.has(b);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const c = e.code;
    if ((c === 'Escape' || c === 'KeyP') && !e.repeat) this.pauseLatch = true;
    if (!this.enabled) return;
    if (c === 'Space' || c.startsWith('Arrow')) e.preventDefault();
    this.state.device = 'keyboard';
    if (e.repeat) return;
    this.keys.add(c);
    if (c === 'Space' || c === 'KeyK') this.dashLatch = true;
    else if (c === 'KeyJ' || c === 'Enter') this.boltLatch = true;
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  // ───────── Gamepad ─────────

  private pollPad(): void {
    this.padMoveX = this.padMoveY = 0;
    this.padCrystal = false;
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    let pad: Gamepad | null = null;
    for (const p of pads) {
      if (p?.connected) {
        pad = p;
        break;
      }
    }
    if (!pad) return;
    if (!this.enabled) {
      if (pad.buttons[9]?.pressed && !this.padPrev[9]) this.pauseLatch = true;
      this.padPrev[9] = pad.buttons[9]?.pressed ? 1 : 0;
      return;
    }
    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    const len = Math.hypot(ax, ay);
    let used = false;
    if (len > PAD_DEAD) {
      const m = Math.min(1, (len - PAD_DEAD) / (1 - PAD_DEAD));
      this.padMoveX = (ax / len) * m;
      this.padMoveY = (-ay / len) * m;
      used = true;
    }
    const b = pad.buttons;
    const pressed = (i: number) => {
      const btn = b[i];
      return !!btn && (btn.pressed || btn.value > 0.35);
    };
    const edge = (i: number) => {
      const now = pressed(i) ? 1 : 0;
      const was = this.padPrev[i]!;
      this.padPrev[i] = now;
      if (now) used = true;
      return now === 1 && was === 0;
    };
    if (edge(0)) {
      this.dashLatch = true;
      if (used && len > PAD_DEAD) {
        this.dashX = ax / len;
        this.dashY = -ay / len;
      }
    }
    const boltX = edge(2);
    const boltB = edge(1);
    if (boltX || boltB) this.boltLatch = true;
    if (edge(9)) this.pauseLatch = true;
    edge(5);
    edge(6);
    edge(7);
    this.padCrystal = pressed(7) || pressed(6) || pressed(5);
    if (used) this.state.device = 'gamepad';
  }
}
