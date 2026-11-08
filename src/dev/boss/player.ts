/**
 * DEV HARNESS ONLY — stub input (keyboard/mouse + simple touch), stub player (little wizard with
 * crystal, bolts, dash, pages) and bolts. Stand-ins for the player workstream.
 */
import * as THREE from 'three';
import type { DamageSource, GameContext, InputAPI, InputState, PlayerAPI } from '../../core/types';
import { PAL } from '../../data/palette';
import { TUNING } from '../../data/tuning';
import type { StubRender } from './render';

export class StubInput implements InputAPI {
  readonly state: InputState = {
    move: new THREE.Vector2(),
    crystalHeld: false,
    boltPressed: false,
    dashPressed: false,
    dashDir: new THREE.Vector2(),
    pausePressed: false,
    device: 'keyboard',
  };
  private keys = new Set<string>();
  private bolt = false;
  private dash = false;
  private mouseR = false;
  private enabled = true;
  /** touch */
  private joyId = -1;
  private joy0 = new THREE.Vector2();
  private joy = new THREE.Vector2();
  private act = new Map<number, { x: number; y: number; t: number; held: boolean }>();
  autoplay: ((s: InputState) => void) | null = null;

  constructor(el: HTMLElement) {
    addEventListener('keydown', (e: KeyboardEvent) => {
      this.keys.add(e.code);
      if (e.code === 'Space') this.dash = true;
      if (e.code === 'KeyJ' || e.code === 'Enter') this.bolt = true;
      this.state.device = 'keyboard';
    });
    addEventListener('keyup', (e: KeyboardEvent) => this.keys.delete(e.code));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') {
        if (e.button === 0) this.bolt = true;
        if (e.button === 2) this.mouseR = true;
        return;
      }
      this.state.device = 'touch';
      if (e.clientX < innerWidth / 2 && this.joyId < 0) {
        this.joyId = e.pointerId;
        this.joy0.set(e.clientX, e.clientY);
        this.joy.set(0, 0);
      } else this.act.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), held: false });
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.joyId) {
        this.joy.set(e.clientX - this.joy0.x, -(e.clientY - this.joy0.y)).divideScalar(60);
        if (this.joy.length() > 1) this.joy.normalize();
      }
    });
    const up = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') {
        if (e.button === 2) this.mouseR = false;
        return;
      }
      if (e.pointerId === this.joyId) {
        this.joyId = -1;
        this.joy.set(0, 0);
      }
      const a = this.act.get(e.pointerId);
      if (a) {
        const dt = performance.now() - a.t;
        const dx = e.clientX - a.x;
        const dy = e.clientY - a.y;
        const g = TUNING.gesture;
        if (Math.hypot(dx, dy) > g.swipeMinPx && dt < g.swipeMaxMs * 2) {
          this.dash = true;
          this.state.dashDir.set(dx, -dy).normalize();
        } else if (dt < g.tapMaxMs) this.bolt = true;
        this.act.delete(e.pointerId);
      }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  poll(): void {
    const s = this.state;
    s.boltPressed = false;
    s.dashPressed = false;
    if (!this.enabled) return;
    s.move.set(
      (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) -
        (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0),
      (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) -
        (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0),
    );
    if (this.joyId >= 0) s.move.copy(this.joy);
    if (s.move.length() > 1) s.move.normalize();
    let held =
      this.mouseR || this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.keys.has('KeyK');
    const now = performance.now();
    for (const a of this.act.values()) if (now - a.t > TUNING.gesture.holdMinMs) held = true;
    s.crystalHeld = held;
    s.boltPressed = this.bolt;
    if (this.dash) {
      s.dashPressed = true;
      if (s.device !== 'touch') s.dashDir.copy(s.move);
    }
    this.bolt = false;
    this.dash = false;
    this.autoplay?.(s);
  }
  setLeftHanded(): void {}
  setEnabled(v: boolean): void {
    this.enabled = v;
  }
  dispose(): void {}
}

interface Bolt {
  mesh: THREE.Mesh;
  target: import('../../core/types').Damageable | null;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  active: boolean;
}

export class StubPlayer implements PlayerAPI {
  readonly position = new THREE.Vector3(0, 0, 6.5);
  readonly velocity = new THREE.Vector3();
  readonly facing = new THREE.Vector3(0, 0, -1);
  readonly crystalPos = new THREE.Vector3();
  readonly object = new THREE.Group();
  pages = TUNING.player.maxPages;
  energy = TUNING.energy.start;
  invulnerable = false;
  crystalHeld = false;
  god = false;
  private iT = 0;
  private dashT = 0;
  private dashCd = 0;
  private dashDir = new THREE.Vector3();
  private controllable = true;
  private crystal: THREE.Mesh;
  private body: THREE.Group;
  private bolts: Bolt[] = [];
  private boltCd = 0;
  private hurtAcc = 0;
  private trailT = 0;
  private flash = 0;
  private bodyMats: THREE.ShaderMaterial[] = [];
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector2();
  private camFwd = new THREE.Vector3();
  private camRight = new THREE.Vector3();

  constructor(
    private ctx: GameContext,
    render: StubRender,
  ) {
    const robe = render.createInkMaterial({ ramp: 'red', reveal: false, keyAmt: 0.85, glowAmt: 1.4 });
    const skin = render.createInkMaterial({ ramp: 'ghost', reveal: false, keyAmt: 0.85, glowAmt: 1.4 });
    const staff = render.createInkMaterial({ ramp: 'staff', reveal: false, keyAmt: 0.85, glowAmt: 1.4 });
    this.bodyMats.push(robe, skin, staff);
    const b = new THREE.Group();
    const cloak = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.25, 12, 3), robe);
    cloak.position.y = 0.62;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 10), skin);
    head.position.y = 1.38;
    const beard = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.45, 8), skin);
    beard.position.set(0, 1.12, 0.12);
    beard.rotation.x = Math.PI + 0.25;
    const hat = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.75, 10), robe);
    hat.position.set(0, 1.78, -0.04);
    hat.rotation.x = -0.25;
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.05, 14), robe);
    brim.position.y = 1.5;
    const st = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 2.0, 6), staff);
    st.position.set(0.38, 1.0, 0.1);
    st.rotation.z = -0.08;
    b.add(cloak, head, beard, hat, brim, st);
    this.body = b;
    this.object.add(b);
    this.crystal = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.15, 0),
      new THREE.ShaderMaterial({
        uniforms: {
          core: { value: new THREE.Color(PAL.glowCore) },
          edge: { value: new THREE.Color(PAL.glowEdge) },
          uTime: render.shared.uTime!,
        },
        vertexShader:
          'varying vec3 vVP; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); vVP = mv.xyz; gl_Position = projectionMatrix*mv; }',
        fragmentShader:
          'uniform vec3 core, edge; uniform float uTime; varying vec3 vVP; void main(){ vec3 n = normalize(cross(dFdx(vVP), dFdy(vVP))); float f = abs(dot(n, normalize(-vVP))); float flick = 0.04*sin(uTime*7.0); gl_FragColor = vec4(mix(edge, core, step(0.62+flick, f)), 1.); }',
      }),
    );
    this.crystal.scale.set(0.62, 1.9, 0.45);
    this.crystal.position.set(0.4, 2.12, 0.1);
    this.object.add(this.crystal);
    this.object.position.copy(this.position);
    // bolt pool
    const bg = new THREE.SphereGeometry(0.14, 8, 6);
    const bm = new THREE.MeshBasicMaterial({ color: new THREE.Color(PAL.ink) });
    const halo = new THREE.MeshBasicMaterial({ color: new THREE.Color(PAL.glowEdge) });
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(bg, bm);
      const h = new THREE.Mesh(bg, halo);
      h.scale.setScalar(1.5);
      h.layers.set(1);
      m.add(h);
      m.visible = false;
      m.layers.set(1);
      render.scene.add(m);
      this.bolts.push({
        mesh: m,
        target: null,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        active: false,
      });
    }
  }

  damage(amount: number, source: DamageSource): void {
    if (this.invulnerable || this.god) return;
    const mul = TUNING.difficulty[this.ctx.settings.difficulty].damageTaken;
    this.hurtAcc += amount * mul;
    let torn = 0;
    while (this.hurtAcc >= 1) {
      this.hurtAcc -= 1;
      torn++;
    }
    this.iT = TUNING.player.iFramesOnHit;
    this.flash = 1;
    if (torn > 0) {
      this.pages = Math.max(0, this.pages - torn);
      this.ctx.stats.pagesTorn += torn;
    }
    this.ctx.events.emit('player:damaged', { amount, source, pagesLeft: this.pages });
    this.ctx.audio.play('player_hurt', { position: this.position });
    this.ctx.events.emit('fx:shake', { intensity: 0.5, duration: 0.3 });
    if (this.pages <= 0) {
      this.ctx.events.emit('player:died', {});
      this.pages = TUNING.player.maxPages;
    }
  }
  addEnergy(a: number): void {
    this.energy = Math.min(TUNING.energy.max, this.energy + a);
    this.ctx.events.emit('energy:changed', { value: this.energy, max: TUNING.energy.max });
  }
  teleport(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
  }
  setControllable(v: boolean): void {
    this.controllable = v;
  }
  playClip(): void {}

  step(dt: number, input: InputState, cam: THREE.Camera): void {
    const P = TUNING.player;
    const s = input;
    const cost = TUNING.difficulty[this.ctx.settings.difficulty].energyCost;
    this.iT = Math.max(0, this.iT - dt);
    this.dashCd = Math.max(0, this.dashCd - dt);
    this.boltCd = Math.max(0, this.boltCd - dt);
    this.flash = Math.max(0, this.flash - dt * 3);
    // camera-relative move
    cam.getWorldDirection(this.camFwd);
    this.camFwd.y = 0;
    this.camFwd.normalize();
    this.camRight.set(-this.camFwd.z, 0, this.camFwd.x);
    const mv = this.controllable ? s.move : this.tmp2.set(0, 0);
    this.tmp.copy(this.camRight).multiplyScalar(mv.x).addScaledVector(this.camFwd, mv.y);
    const speed = P.runSpeed * Math.min(1, mv.length());
    if (this.dashT > 0) {
      this.dashT -= dt;
      this.velocity.copy(this.dashDir).multiplyScalar(TUNING.dash.distance / TUNING.dash.duration);
      this.trailT -= dt;
      if (this.trailT <= 0) {
        this.trailT = 0.05;
        this.ctx.reveal.addSource(this.position.x, this.position.z, 1.4, TUNING.dash.trailLife);
      }
    } else {
      this.velocity.x += (this.tmp.x * speed - this.velocity.x) * Math.min(1, P.accel * dt);
      this.velocity.z += (this.tmp.z * speed - this.velocity.z) * Math.min(1, P.accel * dt);
    }
    if (this.tmp.lengthSq() > 0.01) {
      const a = Math.atan2(this.tmp.x, this.tmp.z);
      let d = a - this.body.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.body.rotation.y += d * Math.min(1, P.turnRate * dt);
      this.facing.set(Math.sin(this.body.rotation.y), 0, Math.cos(this.body.rotation.y));
    }
    this.position.addScaledVector(this.velocity, dt);
    this.ctx.collision.resolveCircle(this.position.x, this.position.z, P.radius, this.tmp2);
    this.position.x = this.tmp2.x;
    this.position.z = this.tmp2.y;
    this.invulnerable = this.iT > 0 || this.dashT > 0;

    // dash
    if (s.dashPressed && this.dashCd <= 0 && this.controllable) {
      const dd = s.dashDir.lengthSq() > 0.01 ? s.dashDir : null;
      if (dd)
        this.dashDir.copy(this.camRight).multiplyScalar(dd.x).addScaledVector(this.camFwd, dd.y).normalize();
      else this.dashDir.copy(this.facing);
      this.dashT = TUNING.dash.duration;
      this.dashCd = TUNING.dash.cooldown;
      this.ctx.audio.play('dash', { position: this.position });
      const p = this.position;
      this.ctx.events.emit('player:dash', {
        from: [p.x, p.y, p.z],
        to: [p.x + this.dashDir.x * 4, p.y, p.z + this.dashDir.z * 4],
      });
    }

    // crystal
    const want = s.crystalHeld && this.controllable;
    if (want !== this.crystalHeld) this.ctx.events.emit('crystal:hold', { held: want });
    this.crystalHeld = want && this.energy > 0;
    if (this.crystalHeld) this.energy = Math.max(0, this.energy - TUNING.crystal.drainPerSec * cost * dt);
    this.ctx.reveal.targetRadius = this.crystalHeld
      ? TUNING.crystal.radiusHeld
      : this.energy <= 0
        ? TUNING.crystal.radiusDim
        : TUNING.crystal.radiusIdle;

    // bolts
    if (s.boltPressed && this.boltCd <= 0 && this.energy >= TUNING.bolt.cost * cost) {
      const tgt = this.ctx.targets.nearest(this.crystalPos, TUNING.bolt.maxRange);
      const b = this.bolts.find((x) => !x.active);
      if (b) {
        this.boltCd = TUNING.bolt.cooldown;
        this.energy -= TUNING.bolt.cost * cost;
        b.active = true;
        b.target = tgt;
        b.pos.copy(this.crystalPos);
        b.life = 1.6;
        if (tgt) b.vel.copy(tgt.position).sub(b.pos).normalize().multiplyScalar(TUNING.bolt.speed);
        else b.vel.copy(this.facing).multiplyScalar(TUNING.bolt.speed).setY(0.5);
        b.mesh.visible = true;
        this.ctx.stats.boltsFired++;
        this.ctx.audio.play('bolt_fire', { position: this.crystalPos });
        this.ctx.events.emit('bolt:fire', { targetId: tgt ? tgt.id : null });
      }
    }
    for (const b of this.bolts) {
      if (!b.active) continue;
      b.life -= dt;
      if (b.target?.alive) {
        this.tmp.copy(b.target.position).sub(b.pos);
        const d = this.tmp.length();
        if (d < b.target.radius + 0.2) {
          b.target.hit(TUNING.bolt.damage, this.crystalPos);
          this.ctx.stats.boltsHit++;
          this.ctx.events.emit('bolt:hit', {
            enemyId: b.target.id,
            position: [b.pos.x, b.pos.y, b.pos.z],
            critical: false,
          });
          this.ctx.audio.play('bolt_hit', { position: b.pos });
          b.active = false;
        } else b.vel.lerp(this.tmp.normalize().multiplyScalar(TUNING.bolt.speed), Math.min(1, dt * 12));
      }
      b.pos.addScaledVector(b.vel, dt);
      b.mesh.position.copy(b.pos);
      if (b.life <= 0 || b.pos.y < 0) b.active = false;
      if (!b.active) b.mesh.visible = false;
    }

    // visuals
    this.object.position.copy(this.position);
    this.body.position.y =
      Math.abs(Math.sin(performance.now() * 0.012)) * 0.06 * Math.min(1, this.velocity.length() / 3);
    this.body.visible = !(this.iT > 0 && Math.floor(this.iT * 16) % 2 === 0);
    const cs = this.crystalHeld ? 1.35 : 1;
    this.crystal.scale.set(0.62 * cs, 1.9 * cs, 0.45 * cs);
    this.crystal.rotation.y += dt * 1.5;
    this.crystal.position.set(
      Math.cos(this.body.rotation.y) * 0.4,
      2.12,
      -Math.sin(this.body.rotation.y) * 0.4,
    );
    this.object.updateMatrixWorld(true);
    this.crystal.getWorldPosition(this.crystalPos);
    this.ctx.render.shared.uCrystalPos!.value.copy(this.crystalPos);
    (this.ctx.reveal.center as THREE.Vector3).set(this.position.x, 0, this.position.z);
  }
}
