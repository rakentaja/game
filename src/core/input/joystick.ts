/**
 * Pure dynamic virtual joystick math. The stick is born where the thumb lands; if the thumb
 * runs past the rim the base is dragged along (so reversing direction is instant, no dead travel).
 * Output `x, y` is screen-relative with y UP, magnitude 0..1 after a rescaled dead zone.
 */
export class Joystick {
  active = false;
  /** Base (CSS px). */
  ox = 0;
  oy = 0;
  /** Thumb (CSS px, clamped to the rim). */
  kx = 0;
  ky = 0;
  /** Output. */
  x = 0;
  y = 0;
  magnitude = 0;

  constructor(
    public radius: number,
    public deadZone: number,
    public follow = true,
  ) {}

  start(px: number, py: number): void {
    this.active = true;
    this.ox = px;
    this.oy = py;
    this.kx = px;
    this.ky = py;
    this.x = 0;
    this.y = 0;
    this.magnitude = 0;
  }

  move(px: number, py: number): void {
    if (!this.active) return;
    let dx = px - this.ox;
    let dy = py - this.oy;
    let len = Math.hypot(dx, dy);
    const r = this.radius;
    if (len > r) {
      if (this.follow) {
        const over = len - r;
        this.ox += (dx / len) * over;
        this.oy += (dy / len) * over;
        dx = px - this.ox;
        dy = py - this.oy;
        len = r;
      } else {
        dx = (dx / len) * r;
        dy = (dy / len) * r;
        len = r;
      }
    }
    this.kx = this.ox + dx;
    this.ky = this.oy + dy;
    const m = len / r;
    const dz = this.deadZone;
    if (m <= dz || len === 0) {
      this.x = 0;
      this.y = 0;
      this.magnitude = 0;
      return;
    }
    const out = Math.min(1, (m - dz) / (1 - dz));
    this.magnitude = out;
    this.x = (dx / len) * out;
    this.y = (-dy / len) * out;
  }

  end(): void {
    this.active = false;
    this.x = 0;
    this.y = 0;
    this.magnitude = 0;
  }
}
