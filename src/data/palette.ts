/**
 * The only colours allowed on screen. Values are used verbatim (ColorManagement disabled).
 * Source: reference/poc/index.html. Do not add colours without updating PLAN.md §2.1.
 */
export const PAL = {
  ink: '#16100e',
  red: ['#16100e', '#6e2f2c', '#b8655c', '#d99682'],
  teal: ['#111816', '#1d3a38', '#3c6f6a', '#69a197'],
  staff: ['#16100e', '#2a2224', '#4b3f44', '#6c5d63'],
  ghost: ['#16100e', '#bfae93', '#e3d3b8', '#f7eedd'],
  glowCore: '#f6c35a',
  glowEdge: '#e2794e',
  smoke: '#d27b6c',
  paper: '#efe1c9',
  /** POC clear colour (page edge / deep ink). */
  void: '#120d0c',
} as const;

export type Ramp = readonly [string, string, string, string];
export type RampName = 'red' | 'teal' | 'staff' | 'ghost';

/** Every distinct palette colour, for the debug "palette violation" overlay. */
export const ALL_COLORS: readonly string[] = Array.from(
  new Set([
    PAL.ink,
    ...PAL.red,
    ...PAL.teal,
    ...PAL.staff,
    ...PAL.ghost,
    PAL.glowCore,
    PAL.glowEdge,
    PAL.smoke,
    PAL.paper,
    PAL.void,
  ]),
);
