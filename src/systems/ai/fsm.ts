/**
 * Enemy finite-state machine states (PLAN §3.3): Idle → Stalk → Attack → Recoil → Die.
 * Plain numeric constants (not a const enum) so they survive isolatedModules and pack into
 * shader attributes / typed arrays if needed.
 */
export const AiState = {
  Idle: 0,
  Stalk: 1,
  Attack: 2,
  Recoil: 3,
  Die: 4,
} as const;
export type AiState = (typeof AiState)[keyof typeof AiState];

export const AI_STATE_NAMES = ['idle', 'stalk', 'attack', 'recoil', 'die'] as const;

/** Allowed transitions; anything else is a bug (asserted in tests and dev builds). */
const ALLOWED: Record<AiState, readonly AiState[]> = {
  [AiState.Idle]: [AiState.Stalk, AiState.Recoil, AiState.Die],
  [AiState.Stalk]: [AiState.Attack, AiState.Recoil, AiState.Die, AiState.Stalk],
  [AiState.Attack]: [AiState.Stalk, AiState.Recoil, AiState.Die],
  [AiState.Recoil]: [AiState.Stalk, AiState.Recoil, AiState.Die],
  [AiState.Die]: [],
};

export function canTransition(from: AiState, to: AiState): boolean {
  return ALLOWED[from].includes(to);
}

/** Tiny deterministic PRNG (mulberry32) so AI is reproducible in tests and replays. */
export class Rng {
  private s: number;
  constructor(seed = 0x1badb002) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }
}
