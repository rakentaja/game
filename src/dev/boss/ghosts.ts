/**
 * DEV HARNESS ONLY — minimal paper ghosts answering `spawn:request` (stand-in for enemies/spawner).
 */
import * as THREE from 'three';
import type { Damageable, EnemyKind, GameContext } from '../../core/types';
import { TUNING } from '../../data/tuning';
import type { StubRender } from './render';

let nextId = 1;

class Ghost implements Damageable {
  readonly id = nextId++;
  readonly position = new THREE.Vector3();
  readonly radius = 0.45;
  alive = true;
  hp: number;
  rise = 0;
  hitFlash = 0;
  dieT = 0;
  constructor(
    readonly kind: EnemyKind,
    readonly mesh: THREE.Object3D,
    private ctx: GameContext,
    x: number,
    z: number,
  ) {
    this.hp = kind === 'smudge' ? TUNING.enemies.smudge.hp : TUNING.enemies.scribbler.hp;
    this.position.set(x, 0.8, z);
  }
  get revealed(): boolean {
    return this.alive && this.rise > 0.6 && this.ctx.reveal.isRevealed(this.position.x, this.position.z);
  }
  hit(amount: number): void {
    if (!this.alive) return;
    this.hp -= amount;
    this.hitFlash = 1;
    if (this.hp <= 0) {
      this.alive = false;
      this.dieT = 0.4;
      this.ctx.player?.addEnergy(TUNING.enemies[this.kind].inkDrop);
      this.ctx.stats.ghostsInked++;
      this.ctx.audio.play('ghost_die', { position: this.position });
      this.ctx.events.emit('enemy:died', {
        id: this.id,
        kind: this.kind,
        position: [this.position.x, this.position.y, this.position.z],
      });
    }
  }
}

export class StubGhosts {
  private list: Ghost[] = [];
  private geo: THREE.BufferGeometry;
  private mats: Record<'smudge' | 'scribbler', THREE.Material>;
  private eye = new THREE.MeshBasicMaterial({ color: 0x16100e });
  private tmp = new THREE.Vector3();

  constructor(
    private ctx: GameContext,
    render: StubRender,
  ) {
    const g = new THREE.SphereGeometry(0.45, 10, 8);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      const n = Math.sin(p.getX(i) * 9) * Math.cos(p.getZ(i) * 7) * 0.06;
      p.setXYZ(
        i,
        p.getX(i) * (1 + n),
        y < 0 ? y * 1.8 + Math.sin(p.getX(i) * 14) * 0.08 : y * 1.1,
        p.getZ(i) * (1 + n),
      );
    }
    g.computeVertexNormals();
    this.geo = g;
    this.mats = {
      smudge: render.createInkMaterial({ ramp: 'ghost', reveal: false, keyAmt: 0.8, glowAmt: 1.2 }),
      scribbler: render.createInkMaterial({ ramp: 'staff', reveal: false, keyAmt: 0.9, glowAmt: 1.4 }),
    };
    ctx.events.on('spawn:request', (e) => this.spawn(e.kind, e.x, e.z, render.scene));
  }

  get count(): number {
    return this.list.filter((g) => g.alive).length;
  }

  spawn(kind: EnemyKind, x: number, z: number, scene: THREE.Scene): void {
    if (this.count >= TUNING.enemies.maxActive) return;
    const k = kind === 'scribbler' ? 'scribbler' : 'smudge';
    const m = new THREE.Mesh(this.geo, this.mats[k]);
    for (const sx of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 4), this.eye);
      e.position.set(sx * 0.15, 0.2, 0.4);
      e.scale.y = 1.6;
      m.add(e);
    }
    if (k === 'scribbler') m.scale.set(0.8, 1.6, 0.8);
    scene.add(m);
    const g = new Ghost(k, m, this.ctx, x, z);
    this.list.push(g);
    this.ctx.targets.add(g);
    this.ctx.events.emit('enemy:spawn', { id: g.id, kind: k });
  }

  step(dt: number): void {
    const pl = this.ctx.player;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const g = this.list[i]!;
      if (!g.alive) {
        g.dieT -= dt;
        g.mesh.scale.multiplyScalar(1 - dt * 6);
        g.mesh.rotation.y += dt * 20;
        if (g.dieT <= 0) {
          g.mesh.parent?.remove(g.mesh);
          this.ctx.targets.remove(g);
          this.list.splice(i, 1);
        }
        continue;
      }
      g.rise = Math.min(1, g.rise + dt * 0.8);
      if (pl && g.rise >= 1) {
        this.tmp.copy(pl.position).sub(g.position).setY(0);
        const d = this.tmp.length();
        const sp = g.kind === 'smudge' ? TUNING.enemies.smudge.speed : TUNING.enemies.scribbler.speed;
        if (d > 0.6) g.position.addScaledVector(this.tmp.normalize(), sp * 0.8 * dt);
        else pl.damage(1, g.kind);
        g.mesh.rotation.y = Math.atan2(this.tmp.x, this.tmp.z);
      }
      const r = this.ctx.reveal.revealAt(g.position.x, g.position.z);
      g.mesh.visible = r > 0.35;
      g.position.y = -1 + g.rise * 1.8 + Math.sin(performance.now() * 0.004 + g.id) * 0.12;
      g.mesh.position.copy(g.position);
      g.hitFlash = Math.max(0, g.hitFlash - dt * 5);
      const s = 1 + g.hitFlash * 0.3;
      if (g.kind === 'smudge') g.mesh.scale.setScalar(s);
    }
  }

  clear(): void {
    for (const g of this.list) {
      g.mesh.parent?.remove(g.mesh);
      this.ctx.targets.remove(g);
    }
    this.list.length = 0;
  }
}
