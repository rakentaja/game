import { describe, expect, it } from 'vitest';
import {
  ByteReader,
  ByteWriter,
  dequantCm,
  dequantYaw,
  MessageRegistry,
  quantCm,
  quantYaw,
} from '../../src/net/codec';
import { mulberry32 } from '../../src/net/rng';
import { SnapshotDecoder, SnapshotEncoder, SnapshotSchema } from '../../src/net/snapshot';

describe('net codec', () => {
  it('ByteWriter/ByteReader round-trip every primitive', () => {
    const w = new ByteWriter(4); // tiny → forces growth
    w.u8(250)
      .u16(65000)
      .i16(-12345)
      .u32(4_000_000_000)
      .f32(1.5)
      .f64(Math.PI)
      .varu(0)
      .varu(127)
      .varu(300)
      .varu(2 ** 31);
    w.str('mürekkep ✦');
    const r = new ByteReader(w.finish());
    expect(r.u8()).toBe(250);
    expect(r.u16()).toBe(65000);
    expect(r.i16()).toBe(-12345);
    expect(r.u32()).toBe(4_000_000_000);
    expect(r.f32()).toBe(1.5);
    expect(r.f64()).toBe(Math.PI);
    expect([r.varu(), r.varu(), r.varu(), r.varu()]).toEqual([0, 127, 300, 2 ** 31]);
    expect(r.str()).toBe('mürekkep ✦');
    expect(r.remaining).toBe(0);
    expect(() => r.u8()).toThrow(RangeError);
  });

  it('quantizes positions to cm and yaw to u8', () => {
    expect(quantCm(1.234)).toBe(123);
    expect(dequantCm(quantCm(-7.89))).toBeCloseTo(-7.89, 2);
    expect(quantCm(1000)).toBe(32767);
    expect(quantCm(-1000)).toBe(-32768);
    for (const a of [0, 0.5, -1, 3, -3.1, Math.PI]) {
      const d = dequantYaw(quantYaw(a));
      const diff = Math.atan2(Math.sin(d - a), Math.cos(d - a));
      expect(Math.abs(diff)).toBeLessThanOrEqual(Math.PI / 256 + 1e-9);
    }
    expect(quantYaw(Math.PI * 2)).toBe(0);
  });

  it('message registry encodes, decodes and rejects junk', () => {
    const reg = new MessageRegistry();
    const json = reg.defineJson<{ a: number; b: string }>(3, 'j');
    const bin = reg.define<{ x: number }>(
      40,
      'b',
      (w, m) => w.i16(m.x),
      (r) => ({ x: r.i16() }),
    );
    const a = reg.decode(reg.encode(json, { a: 1, b: 'two' }))!;
    expect(a.def).toBe(json);
    expect(a.msg).toEqual({ a: 1, b: 'two' });
    const b = reg.decode(reg.encode(bin, { x: -5 }))!;
    expect(b.msg).toEqual({ x: -5 });
    expect(reg.decode(new Uint8Array([99, 1, 2]))).toBeNull();
    expect(reg.decode(new Uint8Array([40]))).toBeNull(); // truncated
    expect(reg.decode(new Uint8Array(0))).toBeNull();
    expect(() => reg.defineJson(3, 'dup')).toThrow();
    expect(() => reg.defineJson(256, 'big')).toThrow();
  });
});

const schema = new SnapshotSchema([
  { name: 'x', kind: 'q16' },
  { name: 'y', kind: 'q16' },
  { name: 'z', kind: 'q16' },
  { name: 'yaw', kind: 'yaw8' },
  { name: 'hp', kind: 'u8' },
  { name: 'flags', kind: 'u16' },
  { name: 'ink', kind: 'unit8' },
  { name: 'alive', kind: 'bool' },
  { name: 'vx', kind: 'q16', scale: 50 },
]);

function world(n: number, t: number, rand = mulberry32(3)): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (let id = 0; id < n; id++) {
    const moving = id < 2; // only the players move
    m.set(id, [
      id * 3 + (moving ? Math.sin(t * 0.1 + id) * 4 : 0),
      0.5,
      -id * 2 + (moving ? t * 0.05 : 0),
      moving ? t * 0.02 : 1,
      100 - (id % 7),
      id,
      0.5,
      1,
      moving ? rand() * 3 : 0,
    ]);
  }
  return m;
}

describe('snapshot codec', () => {
  it('round-trips a full snapshot within quantization error', () => {
    const enc = new SnapshotEncoder(schema, 77);
    const dec = new SnapshotDecoder(schema, 77);
    const w = world(5, 10);
    enc.begin(1, 1234);
    for (const [id, v] of w) enc.set(id, v);
    const out = dec.decode(enc.end())!;
    expect(out.snap.tick).toBe(1);
    expect(out.snap.time).toBe(1234);
    expect(out.stale).toBe(false);
    const got = new Float64Array(schema.size);
    for (const [id, v] of w) {
      expect(out.snap.read(schema, id, got)).toBe(true);
      expect(got[0]).toBeCloseTo(v[0]!, 1);
      expect(got[2]).toBeCloseTo(v[2]!, 1);
      expect(Math.abs(got[0]! - v[0]!)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(got[4]).toBe(v[4]);
      expect(got[5]).toBe(v[5]);
      expect(got[7]).toBe(1);
      expect(Math.abs(got[8]! - v[8]!)).toBeLessThanOrEqual(0.01 + 1e-9);
    }
  });

  it('delta vs the acked baseline is much smaller and reconstructs exactly', () => {
    const enc = new SnapshotEncoder(schema, 77);
    const dec = new SnapshotDecoder(schema, 77);
    const full: number[] = [];
    const delta: number[] = [];
    let last = null as ReturnType<SnapshotDecoder['decode']>;
    for (let tick = 1; tick <= 30; tick++) {
      const w = world(40, tick);
      enc.begin(tick, tick * 50);
      for (const [id, v] of w) enc.set(id, v);
      const pkt = enc.end();
      (tick === 1 ? full : delta).push(pkt.length);
      last = dec.decode(pkt);
      expect(last).not.toBeNull();
      enc.ack(tick); // receiver acks every tick (instant link)
      // reconstructed state equals a fresh full encode of the same world
      const ref = new SnapshotDecoder(schema, 77);
      const fe = new SnapshotEncoder(schema, 77);
      fe.begin(tick, tick * 50);
      for (const [id, v] of w) fe.set(id, v);
      const refSnap = ref.decode(fe.end())!.snap;
      expect([...last!.snap.ents.keys()].sort()).toEqual([...refSnap.ents.keys()].sort());
      for (const [id, row] of refSnap.ents) expect([...last!.snap.ents.get(id)!]).toEqual([...row]);
    }
    const avgDelta = delta.reduce((a, b) => a + b, 0) / delta.length;
    expect(avgDelta).toBeLessThan(full[0]! / 5);
  });

  it('handles removed entities, unacked baselines and missing baselines', () => {
    const enc = new SnapshotEncoder(schema, null);
    const dec = new SnapshotDecoder(schema, null);
    enc.begin(1, 0);
    enc.set(1, [1, 0, 0, 0, 1, 0, 0, 1, 0]);
    enc.set(2, [2, 0, 0, 0, 1, 0, 0, 1, 0]);
    expect(dec.decode(enc.end())).not.toBeNull();
    enc.ack(1);
    enc.begin(2, 50);
    enc.set(1, [1.5, 0, 0, 0, 1, 0, 0, 1, 0]);
    const p2 = enc.end();
    // tick 3 deltas against tick 1 as well (2 not acked yet)
    enc.begin(3, 100);
    enc.set(1, [1.75, 0, 0, 0, 1, 0, 0, 1, 0]);
    const p3 = enc.end();
    const d3 = dec.decode(p3)!; // arrives before p2
    expect([...d3.snap.ents.keys()]).toEqual([1]);
    const d2 = dec.decode(p2)!;
    expect(d2.stale).toBe(true);
    expect(d2.snap.ents.has(2)).toBe(false);

    // a decoder that never saw tick 1 cannot apply the delta
    const fresh = new SnapshotDecoder(schema, null);
    expect(fresh.decode(p3)).toBeNull();
    expect(fresh.missingBaseline).toBe(1);
    // garbage never throws
    expect(dec.decode(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
