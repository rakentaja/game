import { events } from './events';

export type GameStateId = 'boot' | 'title' | 'playing' | 'pageTurn' | 'boss' | 'cover' | 'credits';

export interface GameState {
  id: GameStateId;
  enter?(from: GameStateId | null, data?: unknown): void | Promise<void>;
  exit?(to: GameStateId): void;
  step?(dt: number): void;
  render?(alpha: number, frameDt: number): void;
}

const ALLOWED: Record<GameStateId, GameStateId[]> = {
  boot: ['title', 'playing', 'boss'],
  title: ['playing', 'credits', 'boss'],
  playing: ['pageTurn', 'boss', 'title', 'playing'],
  pageTurn: ['playing', 'boss'],
  boss: ['cover', 'title', 'boss'],
  cover: ['credits', 'title'],
  credits: ['title'],
};

export class StateMachine {
  private states = new Map<GameStateId, GameState>();
  current: GameState | null = null;

  register(s: GameState): this {
    this.states.set(s.id, s);
    return this;
  }

  canGo(to: GameStateId): boolean {
    return !this.current || ALLOWED[this.current.id].includes(to);
  }

  async go(to: GameStateId, data?: unknown): Promise<void> {
    const next = this.states.get(to);
    if (!next) throw new Error(`state not registered: ${to}`);
    if (!this.canGo(to)) throw new Error(`illegal transition ${this.current?.id} -> ${to}`);
    const from = this.current;
    from?.exit?.(to);
    this.current = next;
    events.emit('state:change', { from: from?.id ?? 'none', to });
    await next.enter?.(from?.id ?? null, data);
  }

  step(dt: number): void {
    this.current?.step?.(dt);
  }

  render(alpha: number, frameDt: number): void {
    this.current?.render?.(alpha, frameDt);
  }
}
