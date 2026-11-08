/**
 * Allocation-free 2D (XZ) steering helpers. All write into a caller-owned `out` {x, z}.
 * Kept free of three.js so they're trivially unit-testable.
 */
export interface V2 {
  x: number;
  z: number;
}

export interface Agent2 {
  readonly position: { x: number; z: number };
  readonly radius: number;
  readonly alive: boolean;
}

/** Desired velocity toward (tx,tz) at `speed`, slowing inside `arrive` radius. */
export function seek(out: V2, px: number, pz: number, tx: number, tz: number, speed: number, arrive = 0): V2 {
  const dx = tx - px;
  const dz = tz - pz;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < 1e-5) {
    out.x = 0;
    out.z = 0;
    return out;
  }
  const s = arrive > 0 && d < arrive ? speed * (d / arrive) : speed;
  out.x = (dx / d) * s;
  out.z = (dz / d) * s;
  return out;
}

/**
 * Desired velocity that orbits (cx,cz) at `ringR` with tangential `speed` (dir = ±1), plus a
 * radial correction pulling the agent back onto the ring. Used for "stalk the reveal edge".
 */
export function orbit(
  out: V2,
  px: number,
  pz: number,
  cx: number,
  cz: number,
  ringR: number,
  speed: number,
  dir: number,
  radialGain = 2.2,
): V2 {
  let dx = px - cx;
  let dz = pz - cz;
  let d = Math.sqrt(dx * dx + dz * dz);
  if (d < 1e-4) {
    dx = 1;
    dz = 0;
    d = 1;
  }
  const nx = dx / d;
  const nz = dz / d;
  // Tangent (counter-clockwise for dir=1 when viewed from +Y).
  const tx = -nz * dir;
  const tz = nx * dir;
  const radial = (ringR - d) * radialGain;
  out.x = tx * speed + nx * radial;
  out.z = tz * speed + nz * radial;
  return out;
}

/**
 * Separation push from neighbours within `range` (edge-to-edge aware). Adds into `out` and
 * returns it. `self` is skipped by identity.
 */
export function separation(
  out: V2,
  self: Agent2,
  agents: readonly Agent2[],
  count: number,
  range: number,
  force: number,
): V2 {
  const px = self.position.x;
  const pz = self.position.z;
  for (let i = 0; i < count; i++) {
    const o = agents[i]!;
    if (o === self || !o.alive) continue;
    let dx = px - o.position.x;
    let dz = pz - o.position.z;
    let d = Math.sqrt(dx * dx + dz * dz);
    const reach = range + (self.radius + o.radius) * 0.5;
    if (d >= reach) continue;
    if (d < 1e-4) {
      // Perfectly stacked: deterministic nudge so two spawns at one point still split.
      dx = i % 2 === 0 ? 1 : -1;
      dz = 0.37;
      d = 1;
    }
    const w = (1 - d / reach) * force;
    out.x += (dx / d) * w;
    out.z += (dz / d) * w;
  }
  return out;
}

/** Move `vel` toward `desired` with max acceleration `accel` over `dt`. Mutates vel. */
export function steerToward(vel: V2, desired: V2, accel: number, dt: number): V2 {
  const dx = desired.x - vel.x;
  const dz = desired.z - vel.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const maxDv = accel * dt;
  if (d <= maxDv || d < 1e-6) {
    vel.x = desired.x;
    vel.z = desired.z;
  } else {
    vel.x += (dx / d) * maxDv;
    vel.z += (dz / d) * maxDv;
  }
  return vel;
}

/** Clamp a vector's length. */
export function clampLen(v: V2, max: number): V2 {
  const l2 = v.x * v.x + v.z * v.z;
  if (l2 > max * max) {
    const k = max / Math.sqrt(l2);
    v.x *= k;
    v.z *= k;
  }
  return v;
}

/** Shortest signed angle a→b in radians. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
