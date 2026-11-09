/**
 * Run-wide modifiers set by the meta runtime (Daily Issue rules) and read by page systems at
 * install / event time. Reset to neutral for normal runs.
 */
export const RUN_MODS = {
  /** Multiplies blank-paper reclaim (0 = the ink never fades back). */
  reclaimMul: 1,
  /** Multiplies the permanent kill stamp radius. */
  killStampMul: 1,
  /** Extra ink droplets spawned at each kill (Daily "every kill prints ink puddles"). */
  killInk: 0,
};

export function resetRunMods(): void {
  RUN_MODS.reclaimMul = 1;
  RUN_MODS.killStampMul = 1;
  RUN_MODS.killInk = 0;
}
