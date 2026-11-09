/**
 * Co-op runtime entry (lazy chunk). Game.ts reaches it only through `import('../coop')`:
 *   - `?local2p=1`            → startLocal2p(host)
 *   - lobby 'coop:start'      → startNetCoop(host, { session, slot, seed, heroes })
 *   - invite link mid-issue   → watchResume(bus): a fresh tab whose lobby reconnects to a host
 *                               that is already playing gets a SYNC and joins the running page.
 */
import type { EventBus, GameEvents } from '../core/events';
import { PLAYABLE_HEROES } from '../net/protocol';
import type { NetSession } from '../net/session';
import { startNetCoop } from './net';
import type { CoopHost } from './types';
import { MSG_SYNC, type SyncMsg } from './wire';

export { LocalCoop, startLocal2p } from './local';
export { applySave, NetCoop, startNetCoop, takeOver } from './net';
export type { CoopHost, CoopSession } from './types';

/** Heroes the run can actually use: kits that don't exist yet fall back to the Inker. */
export function resolveHeroes(heroes: readonly string[]): string[] {
  return heroes.map((h) => ((PLAYABLE_HEROES as readonly string[]).includes(h) ? h : 'inker'));
}

let pendingSync: SyncMsg | null = null;

/** The SYNC that started a resumed guest run (consumed once). */
export function takeResumeSync(): SyncMsg | null {
  const s = pendingSync;
  pendingSync = null;
  return s;
}

/**
 * Guest tab opened from an invite link while the host is mid-issue: the lobby connects, the host
 * answers with SYNC instead of START → emit a synthetic 'coop:start' so Game starts the run.
 */
export function watchResume(
  bus: EventBus<GameEvents>,
  isRunning: () => boolean,
  net: { activeSession(): NetSession | null; onSession(fn: (s: NetSession) => void): () => void },
): () => void {
  const offs: (() => void)[] = [];
  const attach = (s: NetSession | null) => {
    if (!s || s.role !== 'guest') return;
    offs.push(
      s.on('message', (def, msg) => {
        if (def.id !== MSG_SYNC || isRunning()) return;
        pendingSync = msg as SyncMsg;
        bus.emit('coop:start', {
          code: s.code,
          role: 'guest',
          slot: 1,
          seed: (msg as SyncMsg).seed,
          at: s.hostNow(),
          heroes: (msg as SyncMsg).heroes,
        });
      }),
    );
  };
  attach(net.activeSession());
  offs.push(net.onSession(attach));
  return () => {
    for (const o of offs) o();
  };
}

/** Lobby agreed ('coop:start'): start the online run, or resume a running issue from a SYNC. */
export async function launchNet(
  host: CoopHost,
  e: GameEvents['coop:start'],
  session: NetSession | null,
): Promise<void> {
  if (!session) return;
  // the lobby's job is done; the session lives on in the run
  if (typeof document !== 'undefined') document.querySelector('.scr-coop')?.remove();
  host.session()?.dispose();
  const coop = await startNetCoop(host, {
    session,
    slot: e.slot,
    seed: e.seed,
    heroes: resolveHeroes(e.heroes),
    sync: takeResumeSync(),
  });
  host.setSession(coop);
  if (coop.resume()) return;
  // both ends start together at the host-clock `at`
  const wait = Math.max(0, Math.min(1500, e.at - session.hostNow()));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  await host.startRun(1);
}
