// Achievements and leaderboards as kernel extensions (`ext.achievements`, `ext.leaderboards`; compat/core/ext.ts). Opt-in:
// with neither given nothing here runs and the `milestone` act is as the base runtime has it (routed to whoever registered a handler).
//
// - `milestone` (an engine act) and `stat` (a custom event name in this kernel, an act in the platform docs) are forwarded to
//   `achievements.handleAct(type, payload)`. The event or act itself is delivered as before; the forward is an extra tap.
//   A milestone that the act filter drops (another player's audience, another place) is not forwarded.
// - After each forwarded act, and once after the human body spawns, `achievements.unlockedIds()` is written to the body's
//   `player.state.achievements` (an equal list writes nothing). The key is not one of the durable keys (core §13.2), so the
//   save document is untouched: the port keeps its own store.
// - Leaderboards: the platform keeps a player's number in a `player.state` row and names the board in the world config
//   (`leaderboards: { <id>: { name, state, direction } }`). The standalone has no host that reads that row, so the game side
//   calls `submitScore(kernel, boardId, score)` from its own code (the shell's results screen, a game-side module) and the
//   local human\x27s id and display name go with it. Resolves false when there is no port, no human or the board refuses.
import type { CoreKernel } from './kernel.ts';
import { extOf } from './ext.ts';
import { deepEqualWire } from './wire.ts';

type Report = (message: string, error: unknown) => void;
const defaultReport: Report = (m, e) => console.error(m, e);

/** writes the unlocked ids into the human body\x27s `state.achievements` when they differ */
function mirror(k: Pick<CoreKernel, 'store' | 'ext'>): void {
  const ach = extOf(k).achievements;
  const body = [...k.store.inVm('client')].find(row => row.player !== null);
  if (!ach || !body || body.phase !== 'alive') return;
  const ids = ach.unlockedIds().slice();
  if (deepEqualWire(body.state['achievements'], ids)) return;
  (k.store.handle(body, body.vm) as { state: Record<string, unknown> }).state['achievements'] = ids;
}

/** the tap for `milestone` / `stat`, or undefined when `ext.achievements` is absent */
export function achievementsTap(k: Pick<CoreKernel, 'store' | 'ext'>, report: Report = defaultReport): ((type: string, payload: unknown) => void) | undefined {
  const ach = extOf(k).achievements;
  if (!ach) return undefined;
  return (type, payload) => {
    let p: Promise<unknown>;
    try {
      p = Promise.resolve(ach.handleAct(type, payload));
    } catch (err) {
      report(`[achievements] handleAct(${type}) threw`, err);
      return;
    }
    p.then(() => mirror(k)).catch((err: unknown) => report(`[achievements] handleAct(${type}) failed`, err));
  };
}

/** the initial mirror: the human body has spawned, so its state can hold the ids once the port has loaded its store */
export function mirrorAfterInit(k: Pick<CoreKernel, 'store' | 'ext'>, report: Report = defaultReport): void {
  const ach = extOf(k).achievements;
  if (!ach) return;
  Promise.resolve(ach.init?.())
    .then(() => mirror(k))
    .catch((err: unknown) => report('[achievements] init failed', err));
}

/**
 * Submits `score` for the local human to `boardId` of `ext.leaderboards`. The board keeps the player\x27s best in its own
 * direction. Never rejects.
 */
export async function submitScore(k: Pick<CoreKernel, 'store' | 'ext'>, boardId: string, score: number, name?: string): Promise<boolean> {
  const lb = extOf(k).leaderboards;
  const player = [...k.store.inVm('client')].find(row => row.player !== null)?.player;
  if (!lb || !player) return false;
  try {
    return await lb.submit(boardId, player.userId, score, name ?? player.displayName);
  } catch (err) {
    defaultReport('[leaderboards] submit failed', err);
    return false;
  }
}
