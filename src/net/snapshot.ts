/**
 * Quantized, delta-compressed entity snapshots (generic building block; wave 2 defines the actual
 * player/enemy schemas).
 *
 * A schema is a list of fields, each quantized to an integer:
 *   q16   int16 fixed point (default scale 100 → centimetres, ±327 m)
 *   yaw8  angle in radians → u8
 *   unit8 0..1 → u8
 *   u8 / u16 / bool  raw integers
 *
 * Wire format (little endian):
 *   [u8 typeId] u32 tick, u32 baselineTick (0xFFFFFFFF = full), u32 hostTimeMs,
 *   varu changedCount, { varu id, mask bytes (ceil(fields/8)), changed fields… }*,
 *   varu removedCount, { varu id }*
 * Only fields whose *quantized* value differs from the baseline are written; entities identical
 * to the baseline are omitted entirely. The receiver acks ticks; the sender always deltas against
 * the newest acked snapshot it still has (else sends full).
 */
import {
  ByteReader,
  ByteWriter,
  dequantCm,
  dequantUnit,
  dequantYaw,
  quantCm,
  quantUnit,
  quantYaw,
} from './codec';

export type FieldKind = 'q16' | 'yaw8' | 'unit8' | 'u8' | 'u16' | 'bool';
export interface FieldDef {
  name: string;
  kind: FieldKind;
  /** q16 only: units per metre (default 100). */
  scale?: number;
}

const NO_BASELINE = 0xffffffff;

export class SnapshotSchema {
  readonly size: number;
  readonly maskBytes: number;
  private index = new Map<string, number>();

  constructor(readonly fields: readonly FieldDef[]) {
    this.size = fields.length;
    this.maskBytes = Math.max(1, Math.ceil(fields.length / 8));
    fields.forEach((f, i) => {
      this.index.set(f.name, i);
    });
  }

  /** Field index by name (throws on typos so schemas fail fast). */
  idx(name: string): number {
    const i = this.index.get(name);
    if (i === undefined) throw new Error(`unknown snapshot field ${name}`);
    return i;
  }

  quantize(i: number, v: number): number {
    const f = this.fields[i]!;
    switch (f.kind) {
      case 'q16':
        return quantCm(v, f.scale ?? 100);
      case 'yaw8':
        return quantYaw(v);
      case 'unit8':
        return quantUnit(v);
      case 'u8':
        return Math.min(255, Math.max(0, Math.round(v)));
      case 'u16':
        return Math.min(65535, Math.max(0, Math.round(v)));
      case 'bool':
        return v ? 1 : 0;
    }
  }

  dequantize(i: number, q: number): number {
    const f = this.fields[i]!;
    switch (f.kind) {
      case 'q16':
        return dequantCm(q, f.scale ?? 100);
      case 'yaw8':
        return dequantYaw(q);
      case 'unit8':
        return dequantUnit(q);
      default:
        return q;
    }
  }

  write(w: ByteWriter, i: number, q: number): void {
    switch (this.fields[i]!.kind) {
      case 'q16':
        w.i16(q);
        break;
      case 'u16':
        w.u16(q);
        break;
      default:
        w.u8(q);
    }
  }

  read(r: ByteReader, i: number): number {
    switch (this.fields[i]!.kind) {
      case 'q16':
        return r.i16();
      case 'u16':
        return r.u16();
      default:
        return r.u8();
    }
  }
}

/** One quantized world state. Entity values are quantized ints in schema order. */
export class Snapshot {
  readonly ents = new Map<number, Int32Array>();
  constructor(
    public tick: number,
    public time: number,
  ) {}

  /** Dequantized field values for `id` into `out` (returns false if absent). */
  read(schema: SnapshotSchema, id: number, out: Float64Array | number[]): boolean {
    const q = this.ents.get(id);
    if (!q) return false;
    for (let i = 0; i < schema.size; i++) out[i] = schema.dequantize(i, q[i]!);
    return true;
  }
}

/** Pool of Int32Array rows so steady-state encoding allocates nothing per entity. */
class RowPool {
  private free: Int32Array[] = [];
  constructor(private size: number) {}
  get(): Int32Array {
    return this.free.pop() ?? new Int32Array(this.size);
  }
  release(snap: Snapshot): void {
    for (const r of snap.ents.values()) this.free.push(r);
    snap.ents.clear();
  }
}

export class SnapshotEncoder {
  private history: (Snapshot | undefined)[];
  private pool: RowPool;
  private cur: Snapshot | null = null;
  private w = new ByteWriter(512);
  private ackedTick = -1;
  private spare: Snapshot[] = [];
  /** Bytes of the last packet (stats). */
  lastBytes = 0;

  constructor(
    readonly schema: SnapshotSchema,
    /** Packet type id written as the first byte (null = none). */
    private typeId: number | null = null,
    private historySize = 64,
  ) {
    this.history = new Array(historySize);
    this.pool = new RowPool(schema.size);
  }

  /** Receiver confirmed it decoded `tick`. */
  ack(tick: number): void {
    if (tick > this.ackedTick) this.ackedTick = tick;
  }

  begin(tick: number, timeMs: number): void {
    const s = this.spare.pop();
    if (s) {
      s.tick = tick;
      s.time = timeMs;
      this.cur = s;
    } else this.cur = new Snapshot(tick, timeMs);
  }

  /** Set an entity's (float) field values for the snapshot being built. */
  set(id: number, values: ArrayLike<number>): void {
    const s = this.cur!;
    let row = s.ents.get(id);
    if (!row) {
      row = this.pool.get();
      s.ents.set(id, row);
    }
    for (let i = 0; i < this.schema.size; i++) row[i] = this.schema.quantize(i, values[i] ?? 0);
  }

  private baseline(tick: number): Snapshot | null {
    if (this.ackedTick < 0 || tick - this.ackedTick >= this.historySize) return null;
    const b = this.history[this.ackedTick % this.historySize];
    return b && b.tick === this.ackedTick ? b : null;
  }

  /** Finish the snapshot: returns the encoded packet (a fresh copy). */
  end(): Uint8Array {
    const s = this.cur!;
    this.cur = null;
    const base = this.baseline(s.tick);
    const sc = this.schema;
    const w = this.w.reset();
    if (this.typeId !== null) w.u8(this.typeId);
    w.u32(s.tick)
      .u32(base ? base.tick : NO_BASELINE)
      .u32(Math.max(0, Math.round(s.time)));

    // changed entities: count first, so reserve by two passes (cheap: small entity counts)
    let changed = 0;
    for (const [id, row] of s.ents) if (!base || differs(row, base.ents.get(id))) changed++;
    w.varu(changed);
    for (const [id, row] of s.ents) {
      const b = base?.ents.get(id);
      if (base && !differs(row, b)) continue;
      w.varu(id);
      const maskAt = w.pos;
      for (let k = 0; k < sc.maskBytes; k++) w.u8(0);
      for (let i = 0; i < sc.size; i++) {
        if (b && b[i] === row[i]) continue;
        w.buf[maskAt + (i >> 3)]! |= 1 << (i & 7);
        sc.write(w, i, row[i]!);
      }
    }
    let removed = 0;
    if (base) for (const id of base.ents.keys()) if (!s.ents.has(id)) removed++;
    w.varu(removed);
    if (base) for (const id of base.ents.keys()) if (!s.ents.has(id)) w.varu(id);

    // store in history (recycling whatever occupied the slot)
    const slot = s.tick % this.historySize;
    const old = this.history[slot];
    if (old && old !== base) {
      this.pool.release(old);
      this.spare.push(old);
    }
    this.history[slot] = s;
    const out = w.finish();
    this.lastBytes = out.length;
    return out;
  }
}

function differs(a: Int32Array, b: Int32Array | undefined): boolean {
  if (!b) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
  return false;
}

export interface DecodedSnapshot {
  snap: Snapshot;
  /** True if this tick is older than the newest already decoded (arrived out of order). */
  stale: boolean;
}

export class SnapshotDecoder {
  private history: (Snapshot | undefined)[];
  newestTick = -1;
  /** Packets dropped because their baseline was unknown. */
  missingBaseline = 0;

  constructor(
    readonly schema: SnapshotSchema,
    private typeId: number | null = null,
    private historySize = 64,
  ) {
    this.history = new Array(historySize);
  }

  /** Decode a packet. Returns null if malformed or its baseline is no longer known. */
  decode(data: Uint8Array): DecodedSnapshot | null {
    const r = new ByteReader(data);
    try {
      if (this.typeId !== null && r.u8() !== this.typeId) return null;
      const tick = r.u32();
      const baseTick = r.u32();
      const time = r.u32();
      let base: Snapshot | null = null;
      if (baseTick !== NO_BASELINE) {
        const b = this.history[baseTick % this.historySize];
        if (!b || b.tick !== baseTick) {
          this.missingBaseline++;
          return null;
        }
        base = b;
      }
      const sc = this.schema;
      const snap = new Snapshot(tick, time);
      if (base) for (const [id, row] of base.ents) snap.ents.set(id, row.slice());
      const changed = r.varu();
      for (let n = 0; n < changed; n++) {
        const id = r.varu();
        const mask = r.bytes(sc.maskBytes);
        let row = snap.ents.get(id);
        if (!row) {
          row = new Int32Array(sc.size);
          snap.ents.set(id, row);
        }
        for (let i = 0; i < sc.size; i++) if (mask[i >> 3]! & (1 << (i & 7))) row[i] = sc.read(r, i);
      }
      const removed = r.varu();
      for (let n = 0; n < removed; n++) snap.ents.delete(r.varu());
      const stale = tick <= this.newestTick;
      const slot = tick % this.historySize;
      const prev = this.history[slot];
      if (!prev || prev.tick <= tick) this.history[slot] = snap;
      if (!stale) this.newestTick = tick;
      return { snap, stale };
    } catch {
      return null;
    }
  }
}
