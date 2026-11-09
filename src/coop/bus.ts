/**
 * Event plumbing for co-op.
 *
 * - `PartnerBus`: the second local wizard's event bus. Subscriptions go to the game bus (so the
 *   partner hears respawns, checkpoints, rewrites…), and everything it emits is forwarded too,
 *   EXCEPT the player-1-only HUD/flow events (`PRIVATE`), which stay on `local` so the HUD keeps
 *   showing player 1's pages and ink.
 * - `interceptEmit`: wrap a bus' emit so co-op can delay / swallow events (shared panel cuts).
 */
import { EventBus, type GameEvents } from '../core/events';

const PRIVATE = new Set<keyof GameEvents>([
  'player:damaged',
  'player:died',
  'energy:changed',
  'crystal:hold',
  'crystal:snuff',
]);

export class PartnerBus extends EventBus<GameEvents> {
  /** The partner's own copy of the private events (partner HUD listens here). */
  readonly local = new EventBus<GameEvents>();

  constructor(private readonly main: EventBus<GameEvents>) {
    super();
  }

  override on<K extends keyof GameEvents>(type: K, fn: (p: GameEvents[K]) => void): () => void {
    return PRIVATE.has(type) ? this.local.on(type, fn) : this.main.on(type, fn);
  }

  override off<K extends keyof GameEvents>(type: K, fn: (p: GameEvents[K]) => void): void {
    this.main.off(type, fn);
    this.local.off(type, fn);
  }

  override emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    if (PRIVATE.has(type)) this.local.emit(type, payload);
    else this.main.emit(type, payload);
  }

  override clear(): void {
    this.local.clear();
  }
}

/**
 * Install `filter` in front of `bus.emit`. Returning true swallows the event. Returns an undo.
 * `bypass(fn)` runs `fn` with the filter disabled (re-emitting a held event).
 */
export function interceptEmit(
  bus: EventBus<GameEvents>,
  filter: <K extends keyof GameEvents>(type: K, payload: GameEvents[K]) => boolean,
): { undo: () => void; bypass: (fn: () => void) => void } {
  const orig = bus.emit.bind(bus);
  let off = false;
  bus.emit = <K extends keyof GameEvents>(type: K, payload: GameEvents[K]) => {
    if (!off && filter(type, payload)) return;
    orig(type, payload);
  };
  return {
    undo: () => {
      bus.emit = EventBus.prototype.emit;
    },
    bypass: (fn) => {
      const was = off;
      off = true;
      try {
        fn();
      } finally {
        off = was;
      }
    },
  };
}
