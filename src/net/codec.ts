/**
 * Binary codec building blocks: a growable little-endian ByteWriter (reused across frames, no
 * per-message allocation until `finish()` copies), a ByteReader, quantizers, and a message type
 * registry (first byte of every packet = type id).
 */

export class ByteWriter {
  buf: Uint8Array;
  view: DataView;
  pos = 0;

  constructor(capacity = 1024) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
  }

  reset(): this {
    this.pos = 0;
    return this;
  }

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
    return this;
  }
  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.pos, v & 0xffff, true);
    this.pos += 2;
    return this;
  }
  i16(v: number): this {
    this.ensure(2);
    this.view.setInt16(this.pos, v, true);
    this.pos += 2;
    return this;
  }
  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
    return this;
  }
  f32(v: number): this {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
    return this;
  }
  f64(v: number): this {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
    return this;
  }
  /** Unsigned LEB128 varint (≤ 2^32). */
  varu(v: number): this {
    let x = v >>> 0;
    do {
      let b = x & 0x7f;
      x >>>= 7;
      if (x) b |= 0x80;
      this.u8(b);
    } while (x);
    return this;
  }
  bytes(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
    return this;
  }
  /** Length-prefixed UTF-8 string. */
  str(s: string): this {
    const b = TEXT_ENC.encode(s);
    this.varu(b.length);
    return this.bytes(b);
  }
  /** Copy of the written bytes (safe to hand to async senders). */
  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
  /** View of the written bytes (valid until the next write/reset). */
  peek(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }
}

export class ByteReader {
  pos = 0;
  private view: DataView;
  constructor(readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get remaining(): number {
    return this.buf.length - this.pos;
  }
  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new RangeError('ByteReader: out of data');
  }
  u8(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  varu(): number {
    let x = 0;
    let shift = 0;
    for (;;) {
      const b = this.u8();
      x |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
      if (shift > 28) throw new RangeError('varint too long');
    }
    return x >>> 0;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  str(): string {
    return TEXT_DEC.decode(this.bytes(this.varu()));
  }
}

const TEXT_ENC = new TextEncoder();
const TEXT_DEC = new TextDecoder();

// ── quantizers ──────────────────────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;

/** Metres → int16 centimetres (±327.67 m), clamped. */
export function quantCm(m: number, scale = 100): number {
  const q = Math.round(m * scale);
  return q > 32767 ? 32767 : q < -32768 ? -32768 : q;
}
export function dequantCm(q: number, scale = 100): number {
  return q / scale;
}
/** Radians → u8 (1.41° steps), wraps. */
export function quantYaw(rad: number): number {
  return Math.round((rad / TAU) * 256) & 0xff;
}
/** u8 → radians in (−π, π]. */
export function dequantYaw(q: number): number {
  const a = ((q & 0xff) / 256) * TAU;
  return a > Math.PI ? a - TAU : a;
}
/** 0..1 → u8. */
export function quantUnit(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}
export function dequantUnit(q: number): number {
  return q / 255;
}

// ── message registry ────────────────────────────────────────────────────────────────────────

export interface MessageDef<T> {
  readonly id: number;
  readonly name: string;
  encode(w: ByteWriter, msg: T): void;
  decode(r: ByteReader): T;
}

/**
 * Message type registry. Each packet is `[u8 typeId][payload]`. Gameplay (wave 2) registers its
 * own types in the 32..255 range; 0..31 are reserved for the session/lobby protocol.
 */
export class MessageRegistry {
  private byId: (MessageDef<unknown> | undefined)[] = [];
  private w = new ByteWriter(256);

  define<T>(
    id: number,
    name: string,
    encode: MessageDef<T>['encode'],
    decode: MessageDef<T>['decode'],
  ): MessageDef<T> {
    if (id < 0 || id > 255 || (id | 0) !== id) throw new RangeError(`message id ${id} out of range`);
    if (this.byId[id]) throw new Error(`message id ${id} already registered (${this.byId[id]!.name})`);
    const def: MessageDef<T> = { id, name, encode, decode };
    this.byId[id] = def as MessageDef<unknown>;
    return def;
  }

  /** JSON-payload message (lobby/control traffic where size doesn't matter). */
  defineJson<T>(id: number, name: string): MessageDef<T> {
    return this.define<T>(
      id,
      name,
      (w, m) => w.str(JSON.stringify(m)),
      (r) => JSON.parse(r.str()) as T,
    );
  }

  get(id: number): MessageDef<unknown> | undefined {
    return this.byId[id];
  }

  encode<T>(def: MessageDef<T>, msg: T): Uint8Array {
    const w = this.w.reset();
    w.u8(def.id);
    def.encode(w, msg);
    return w.finish();
  }

  /** Decode a packet; null for unknown types or malformed payloads. */
  decode(data: Uint8Array): { def: MessageDef<unknown>; msg: unknown } | null {
    if (!data.length) return null;
    const def = this.byId[data[0]!];
    if (!def) return null;
    try {
      const r = new ByteReader(data.subarray(1));
      return { def, msg: def.decode(r) };
    } catch {
      return null;
    }
  }
}
