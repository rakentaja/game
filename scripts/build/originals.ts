/**
 * Original procedural assets (licence: Original, made for INKWAKE): the giant eraser THE EDITOR
 * wields, tree stumps for the forest, and the editor's eyeshade visor + pencil (skinned to the
 * boss head). Deterministic: same code → same bytes.
 */
import type { Document, Material } from '@gltf-transform/core';
import { Matrix4, Vector3 } from 'three';
import { chamferBox, Geo, loft, ring, rng } from '../lib/geo';

export function material(doc: Document, name: string, rgb: [number, number, number]): Material {
  const existing = doc
    .getRoot()
    .listMaterials()
    .find((m) => m.getName() === name);
  if (existing) return existing;
  return doc
    .createMaterial(name)
    .setBaseColorFactor([...rgb, 1])
    .setRoughnessFactor(1)
    .setMetallicFactor(0);
}

/**
 * The eraser: a classic two-tone block, worn to a slanted, rounded nose on the business end, with
 * a paper sleeve around the middle. 1 unit long (scale at attach). Local +X is the erasing end,
 * origin at the grip (sleeve centre).
 */
export function eraserGeo(): { rubber: Geo; sleeve: Geo; band: Geo } {
  const L = 1;
  const H = 0.34;
  const D = 0.5;
  const rubber = chamferBox(L, H, D, 0.05);
  // Worn nose: shave the +X end diagonally and round it; keep the -X end crisp.
  rubber.displace((p) => {
    if (p.x > 0.3) {
      const k = (p.x - 0.3) / 0.2; // 0..1 over the last 20 %
      p.x -= k * 0.06 * (1 + p.y / H) * 1.2;
      p.y -= Math.max(0, p.y) * k * 0.18;
    }
    return p;
  });
  const sleeve = chamferBox(0.46, H + 0.05, D + 0.05, 0.02);
  const band = chamferBox(0.08, H + 0.065, D + 0.065, 0.015).apply(new Matrix4().makeTranslation(0.12, 0, 0));
  // Centre the grip on the sleeve.
  const off = new Matrix4().makeTranslation(-0.1, 0, 0);
  rubber.apply(off.clone().invert());
  return { rubber, sleeve, band };
}

/** Tree stump with a jagged broken top, flared roots and a sawn ring. ~1 m tall before scaling. */
export function stumpGeo(seed: number): { bark: Geo; wood: Geo } {
  const r = rng(seed);
  const n = 9;
  const radius = (y: number) => 0.27 + 0.13 * Math.exp(-y * 12) + 0.015 * Math.sin(y * 9);
  const levels = [0, 0.05, 0.14, 0.32, 0.46];
  const jag = Array.from({ length: n }, () => r());
  const rings = levels.map((y, li) =>
    ring(
      n,
      (i) =>
        radius(y) * (li === 0 ? 1 + 0.25 * (i % 3 === 0 ? 1 : 0) : 1) * (0.92 + 0.12 * jag[(i + li) % n]!),
      li === levels.length - 1 ? (i) => y + 0.14 * jag[i]! ** 2 : y,
      0.3,
    ),
  );
  const bark = loft(rings, true, false);
  // Inner wood: a dished cap slightly below the jagged rim.
  const top = rings[rings.length - 1]!;
  const inner = top.map((v) => new Vector3(v.x * 0.86, Math.min(...top.map((t) => t.y)) - 0.02, v.z * 0.86));
  const wood = new Geo();
  const c = new Vector3(0, inner[0]!.y - 0.03, 0);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    wood.tri(c, inner[i]!, inner[j]!);
    wood.quad(inner[i]!, top[i]!, top[j]!, inner[j]!);
  }
  return { bark, wood };
}

/** Green eyeshade visor: head band + a downward-sloped brim arc in front. Unit head radius. */
export function visorGeo(): { band: Geo; brim: Geo } {
  const n = 14;
  const band = loft([ring(n, 1.02, 0), ring(n, 1.04, 0.22)], false, false);
  // inside faces for the band (double-sided look without doubleSided materials)
  const inner = loft([ring(n, 1.0, 0.22), ring(n, 0.99, 0)], false, false);
  band.add(inner);
  const brim = new Geo();
  const seg = 8;
  const a0 = Math.PI * 0.18;
  const a1 = Math.PI * 0.82;
  for (let i = 0; i < seg; i++) {
    const t0 = a0 + ((a1 - a0) * i) / seg;
    const t1 = a0 + ((a1 - a0) * (i + 1)) / seg;
    const p = (t: number, rr: number, y: number) => new Vector3(Math.cos(t) * rr, y, Math.sin(t) * rr);
    const drop = -0.32;
    brim.quad(p(t0, 1.03, 0.2), p(t1, 1.03, 0.2), p(t1, 1.75, 0.2 + drop), p(t0, 1.75, 0.2 + drop));
    brim.quad(p(t0, 1.75, 0.17 + drop), p(t1, 1.75, 0.17 + drop), p(t1, 1.03, 0.17), p(t0, 1.03, 0.17));
  }
  return { band, brim };
}

/** Hexagonal pencil, 1 unit long along +X, sharpened tip at +X. */
export function pencilGeo(): { wood: Geo; paint: Geo; lead: Geo; ferrule: Geo } {
  const r = 0.045;
  const hex = (x: number, rr: number) => ring(6, rr, 0, Math.PI / 6).map((v) => new Vector3(x, v.x, v.z));
  const paint = loftX([hex(-0.5, r), hex(0.28, r)]);
  const wood = loftX([hex(0.28, r), hex(0.43, r * 0.35)], false);
  const lead = loftX([hex(0.43, r * 0.35), hex(0.5, 0.001)], false);
  const ferrule = loftX([hex(-0.56, r * 1.05), hex(-0.48, r * 1.05)]);
  return { wood, paint, lead, ferrule };
}

function loftX(rings: Vector3[][], caps = true): Geo {
  // rings are along X; swap to Y for loft, then back
  const toY = new Matrix4().makeRotationZ(-Math.PI / 2);
  const toX = new Matrix4().makeRotationZ(Math.PI / 2);
  const ry = rings.map((rr) => rr.map((v) => v.clone().applyMatrix4(toY)));
  return loft(ry, caps, caps).apply(toX);
}
