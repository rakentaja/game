/**
 * Co-op gameplay wire format (message ids ≥ 32 on NET_REGISTRY).
 *
 *   SNAP   40  host→guest  unreliable 20 Hz: tick, host time, epoch, host wizard, boss block,
 *                          delta-compressed enemy rows (SnapshotEncoder, ≤ 12 nearest)
 *   PSTATE 41  guest→host  unreliable 30 Hz: ack, the last 3 guest wizard states (seq-tagged)
 *   EVT    42  both        reliable: tick-tagged gameplay events (JSON, low volume)
 *   SYNC   43  host→guest  reliable: full state for a (re)join (page save + reveal history)
 */
import { ByteReader, type ByteWriter, type MessageDef } from '../net/codec';
import { NET_REGISTRY } from '../net/protocol';
import { SnapshotSchema } from '../net/snapshot';

// ───────────────────────────── wizard state ─────────────────────────────

export const WF = { held: 1, dashing: 2, downed: 4, alive: 8, invuln: 16, fading: 32 } as const;

export interface WizState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  cx: number;
  cy: number;
  cz: number;
  /** Current animated crystal radius (m). */
  cr: number;
  flags: number;
  pages: number;
  energy: number;
  /** Increments on every dash start / bolt cast (edge detection on the receiver). */
  dashSerial: number;
  castSerial: number;
}

export function emptyWiz(): WizState {
  return {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    vx: 0,
    vz: 0,
    cx: 0,
    cy: 2,
    cz: 0,
    cr: 0,
    flags: WF.alive,
    pages: 5,
    energy: 100,
    dashSerial: 0,
    castSerial: 0,
  };
}

const cm = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 100)));
const TAU = Math.PI * 2;

export function writeWiz(w: ByteWriter, s: WizState): void {
  w.i16(cm(s.x)).i16(cm(s.y)).i16(cm(s.z));
  w.u8(Math.round((((s.yaw % TAU) + TAU) % TAU) * (256 / TAU)) & 255);
  w.i16(cm(s.vx)).i16(cm(s.vz));
  w.i16(cm(s.cx)).i16(cm(s.cy)).i16(cm(s.cz));
  w.u16(Math.max(0, Math.min(65535, Math.round(s.cr * 100))));
  w.u8(s.flags & 255);
  w.u8(Math.max(0, Math.min(255, Math.round(s.pages * 10))));
  w.u8(Math.max(0, Math.min(255, Math.round(s.energy))));
  w.u8(s.dashSerial & 255).u8(s.castSerial & 255);
}

export function readWiz(r: ByteReader, s: WizState): WizState {
  s.x = r.i16() / 100;
  s.y = r.i16() / 100;
  s.z = r.i16() / 100;
  s.yaw = (r.u8() * TAU) / 256;
  s.vx = r.i16() / 100;
  s.vz = r.i16() / 100;
  s.cx = r.i16() / 100;
  s.cy = r.i16() / 100;
  s.cz = r.i16() / 100;
  s.cr = r.u16() / 100;
  s.flags = r.u8();
  s.pages = r.u8() / 10;
  s.energy = r.u8();
  s.dashSerial = r.u8();
  s.castSerial = r.u8();
  return s;
}

// ───────────────────────────── enemies ─────────────────────────────

/** Enemy row: kind|elite, state|phase, position, yaw, hp, flags and the visual channels. */
export const ENEMY_SCHEMA = new SnapshotSchema([
  { name: 'kind', kind: 'u8' },
  { name: 'state', kind: 'u8' },
  { name: 'x', kind: 'q16' },
  { name: 'z', kind: 'q16' },
  { name: 'yaw', kind: 'yaw8' },
  { name: 'hp', kind: 'u16' },
  { name: 'flags', kind: 'u8' },
  { name: 'windup', kind: 'unit8' },
  { name: 'lunge', kind: 'unit8' },
  { name: 'drain', kind: 'unit8' },
  { name: 'shield', kind: 'unit8' },
  { name: 'expose', kind: 'unit8' },
  { name: 'align', kind: 'unit8' },
  { name: 'box', kind: 'u8' },
]);
export const EF = { vulnerable: 1, attacking: 2, stunned: 4, worn: 8, inked: 16, recoil: 32 } as const;
/** hp is sent ×100 (fractional co-op HP). */
export const HP_SCALE = 100;

// ───────────────────────────── boss block ─────────────────────────────

export interface BossAttackWire {
  active: boolean;
  stage: number;
  t: number;
  headX: number;
  headZ: number;
}

export interface BossBlock {
  state: number;
  phase: number;
  blank: number;
  bowT: number;
  staggerT: number;
  p2Active: number;
  health: number;
  /** Per weak point: bit0 alive, bit1 exposed, bit2 printed; hp; drawIn; print. */
  wps: { flags: number; hp: number; drawIn: number; print: number }[];
  attacks: BossAttackWire[];
  spread: boolean;
  gutterX: number;
  stet: { active: boolean; target: number; t: number; erase: number; held: boolean; x: number; z: number };
}

export const BOSS_STATES = ['dormant', 'intro', 'phase', 'transition', 'dying', 'dead'] as const;
export const ATTACK_STAGES = ['idle', 'telegraph', 'strike', 'recover'] as const;

export function emptyBoss(): BossBlock {
  return {
    state: 0,
    phase: 1,
    blank: 0,
    bowT: 0,
    staggerT: 0,
    p2Active: -1,
    health: 1,
    wps: Array.from({ length: 7 }, () => ({ flags: 0, hp: 0, drawIn: 0, print: 0 })),
    attacks: Array.from({ length: 3 }, () => ({ active: false, stage: 0, t: 0, headX: 0, headZ: 0 })),
    spread: false,
    gutterX: 0,
    stet: { active: false, target: 0, t: 0, erase: 0, held: false, x: 0, z: 0 },
  };
}

const u8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

function writeBoss(w: ByteWriter, b: BossBlock): void {
  w.u8(b.state)
    .u8(b.phase)
    .u8(u8(b.blank * 255))
    .u8(u8(b.bowT * 50))
    .u8(u8(b.staggerT * 50));
  w.u8(b.p2Active < 0 ? 255 : b.p2Active).u8(u8(b.health * 255));
  w.u8(b.wps.length);
  for (const p of b.wps)
    w.u8(p.flags)
      .u8(u8(p.hp * 10))
      .u8(u8(p.drawIn * 255))
      .u8(u8(p.print * 255));
  w.u8(b.attacks.length);
  for (const a of b.attacks) {
    w.u8((a.active ? 1 : 0) | (a.stage << 1));
    w.u16(Math.min(65535, Math.round(a.t * 1000)));
    w.i16(cm(a.headX)).i16(cm(a.headZ));
  }
  const s = b.stet;
  w.u8((b.spread ? 1 : 0) | (s.active ? 2 : 0) | (s.held ? 4 : 0) | (s.target << 3));
  w.i16(cm(b.gutterX));
  w.u16(Math.min(65535, Math.round(s.t * 1000))).u8(u8(s.erase * 255));
  w.i16(cm(s.x)).i16(cm(s.z));
}

function readBoss(r: ByteReader, b: BossBlock): void {
  b.state = r.u8();
  b.phase = r.u8();
  b.blank = r.u8() / 255;
  b.bowT = r.u8() / 50;
  b.staggerT = r.u8() / 50;
  const pa = r.u8();
  b.p2Active = pa === 255 ? -1 : pa;
  b.health = r.u8() / 255;
  const nw = r.u8();
  for (let i = 0; i < nw; i++) {
    const p = b.wps[i] ?? { flags: 0, hp: 0, drawIn: 0, print: 0 };
    p.flags = r.u8();
    p.hp = r.u8() / 10;
    p.drawIn = r.u8() / 255;
    p.print = r.u8() / 255;
    b.wps[i] = p;
  }
  const na = r.u8();
  for (let i = 0; i < na; i++) {
    const a = b.attacks[i] ?? { active: false, stage: 0, t: 0, headX: 0, headZ: 0 };
    const f = r.u8();
    a.active = (f & 1) === 1;
    a.stage = f >> 1;
    a.t = r.u16() / 1000;
    a.headX = r.i16() / 100;
    a.headZ = r.i16() / 100;
    b.attacks[i] = a;
  }
  const f = r.u8();
  b.spread = (f & 1) === 1;
  const s = b.stet;
  s.active = (f & 2) === 2;
  s.held = (f & 4) === 4;
  s.target = (f >> 3) & 1;
  b.gutterX = r.i16() / 100;
  s.t = r.u16() / 1000;
  s.erase = r.u8() / 255;
  s.x = r.i16() / 100;
  s.z = r.i16() / 100;
}

// ───────────────────────────── messages ─────────────────────────────

export interface SnapMsg {
  tick: number;
  time: number;
  epoch: number;
  /** Blot suppression the host applied to the guest's crystal this tick (1 = none). */
  supp: number;
  host: WizState;
  boss: BossBlock | null;
  /** Encoded SnapshotEncoder packet (no type byte). */
  enemies: Uint8Array;
}

export interface PStateMsg {
  ack: number;
  epoch: number;
  states: { seq: number; time: number; s: WizState }[];
}

/** Gameplay events. `t` = sender sim tick (host ticks on the host side). */
export type CoopEvent =
  | { k: 'spawn'; id: number; kind: string; x: number; z: number; el: string | null }
  | { k: 'die'; id: number; x: number; z: number }
  | { k: 'clear' }
  | { k: 'hit'; id: number; x: number; z: number }
  | { k: 'fire'; x: number; z: number; dx: number; dz: number; l: number; s: number }
  | { k: 'hitReq'; seq: number; id: number; d: number; ft: number; x: number; z: number; crane: number }
  | { k: 'wpReq'; seq: number; i: number; d: number }
  | { k: 'hitAck'; seq: number; ok: boolean }
  | { k: 'sketch'; id: string }
  | { k: 'trig'; id: string }
  | { k: 'respawn'; cp: string }
  | { k: 'cut'; w: string; f: [number, number, number]; r: string; at: number }
  | { k: 'turn'; page: string; at: number }
  | { k: 'save'; save: PageSave }
  | { k: 'dmg'; a: number; src: string }
  | { k: 'claim'; n: number }
  | { k: 'drop'; x: number; z: number; n: number }
  | { k: 'down'; pid: number; x: number; z: number }
  | { k: 'up'; pid: number }
  | { k: 'dash'; ax: number; az: number; bx: number; bz: number }
  | { k: 'cast' }
  | { k: 'hero'; p: unknown }
  | { k: 'bossStart' }
  | { k: 'bossPhase'; p: number }
  | {
      k: 'bossAtk';
      i: number;
      kind: string;
      hand: string;
      g: [number, number, number, number, number];
      tm: [number, number, number];
      at: number;
    }
  | { k: 'bossAtkEnd'; i: number }
  | { k: 'bossWp'; i: number; d: boolean }
  | { k: 'bossRewrite'; verb: string; cut: boolean }
  | { k: 'bossDeath'; st: string }
  | { k: 'stet'; st: string; tg: number }
  | { k: 'spread'; on: boolean };

export interface EvtMsg {
  epoch: number;
  tick: number;
  ev: CoopEvent[];
}

/** Everything a fresh / rejoining guest needs to rebuild the page ("page save"). */
export interface PageSave {
  page: string;
  cp: string;
  printed: string[];
  spent: string[];
  cleared: string[];
  boss: { phase: number; mask: number } | null;
}

export interface SyncMsg {
  epoch: number;
  tick: number;
  seed: number;
  heroes: string[];
  save: PageSave;
  /** RLE + base64 reveal history (RevealSystem.exportHistory), '' if none. */
  hist: string;
}

export const MSG_SNAP = 40;
export const MSG_PSTATE = 41;
export const MSG_EVT = 42;
export const MSG_SYNC = 43;

function define<T>(id: number, name: string, enc: MessageDef<T>['encode'], dec: MessageDef<T>['decode']) {
  return (NET_REGISTRY.get(id) as MessageDef<T> | undefined) ?? NET_REGISTRY.define<T>(id, name, enc, dec);
}
function defineJson<T>(id: number, name: string): MessageDef<T> {
  return (NET_REGISTRY.get(id) as MessageDef<T> | undefined) ?? NET_REGISTRY.defineJson<T>(id, name);
}

export const COOP_MSG = {
  snap: define<SnapMsg>(
    MSG_SNAP,
    'coop:snap',
    (w, m) => {
      w.u32(m.tick)
        .f64(m.time)
        .u16(m.epoch)
        .u8(u8(m.supp * 255));
      writeWiz(w, m.host);
      w.u8(m.boss ? 1 : 0);
      if (m.boss) writeBoss(w, m.boss);
      w.varu(m.enemies.length).bytes(m.enemies);
    },
    (r) => {
      const tick = r.u32();
      const time = r.f64();
      const epoch = r.u16();
      const supp = r.u8() / 255;
      const host = readWiz(r, emptyWiz());
      let boss: BossBlock | null = null;
      if (r.u8()) {
        boss = emptyBoss();
        readBoss(r, boss);
      }
      const n = r.varu();
      return { tick, time, epoch, supp, host, boss, enemies: r.bytes(n).slice() };
    },
  ),
  pstate: define<PStateMsg>(
    MSG_PSTATE,
    'coop:pstate',
    (w, m) => {
      w.u32(m.ack >>> 0)
        .u16(m.epoch)
        .u8(m.states.length);
      for (const s of m.states) {
        w.u32(s.seq).f64(s.time);
        writeWiz(w, s.s);
      }
    },
    (r) => {
      const ack = r.u32();
      const epoch = r.u16();
      const n = Math.min(8, r.u8());
      const states: PStateMsg['states'] = [];
      for (let i = 0; i < n; i++) {
        const seq = r.u32();
        const time = r.f64();
        states.push({ seq, time, s: readWiz(r, emptyWiz()) });
      }
      return { ack, epoch, states };
    },
  ),
  evt: defineJson<EvtMsg>(MSG_EVT, 'coop:evt'),
  sync: defineJson<SyncMsg>(MSG_SYNC, 'coop:sync'),
} as const;

/** Decode a bare ByteReader-compatible view (tests). */
export function reader(b: Uint8Array): ByteReader {
  return new ByteReader(b);
}

// ───────────────────────────── reveal history compression ─────────────────────────────

/** Byte RLE: (count u8, value u8) pairs. The history map is mostly long zero runs. */
export function rleEncode(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    const v = src[i]!;
    let n = 1;
    while (n < 255 && i + n < src.length && src[i + n] === v) n++;
    out.push(n, v);
    i += n;
  }
  return Uint8Array.from(out);
}

export function rleDecode(src: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let o = 0;
  for (let i = 0; i + 1 < src.length && o < size; i += 2) {
    const n = src[i]!;
    out.fill(src[i + 1]!, o, Math.min(size, o + n));
    o += n;
  }
  return out;
}

export function toB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
