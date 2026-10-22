// The ctx the UI render receives (io §3.5; core §7.5; X-25). The kernel builds it (`kernel.createUiCtx()`: read-only world and
// handles, the copy-on-write session overlay, the pausable `now()`, `view.camera`; WP C5); this module only attaches the port's
// own state as `ctx.port` (read by edit E-UI-05, `v.port = safe(() => ctx.port, null)`) and picks the `player` argument of
// `render(ctx, player)`: the local human's PlayerView (single player: the one human, `world.players`).
import type { Kernel, UiCtx } from '../../compat/core/types.ts';
import type { UiPlayerView } from './game-ui.d.ts';

/** what the UI host needs from the runtime: the kernel itself once C5 lands, a fake until then */
export type UiRuntimePort = Pick<Kernel, 'createUiCtx'>;

/** io §3.3 `PortUiState` (X-22 tiers; X-21 gore clamp note); new, read only by E-UI-05 / E-UI-03 */
export type PortUiState = Record<string, unknown>;

/** the state before the settings bridge, platform and renderer report anything (desktop, AUTO → high, X-22) */
export function defaultPortUiState(): PortUiState {
  return {};
}

export interface UiRenderArgs {
  ctx: UiCtx & { port: PortUiState };
  player: UiPlayerView | null;
}

/** the local human: the client-VM PlayerView (`isLocal`), else the only one (core §3.5: "the human only") */
export function localPlayer(ctx: UiCtx): UiPlayerView | null {
  let players: readonly UiPlayerView[] | undefined;
  try {
    players = ctx.world.players;
  } catch {
    return null;
  }
  if (!Array.isArray(players) || players.length === 0) return null;
  return players.find((p) => p.isLocal) ?? players[0] ?? null;
}

/** one ctx per render call (core §7.5: cheap), with `port` attached, and the render's `player` argument */
export function makeUiCtx(runtime: UiRuntimePort, port: PortUiState): UiRenderArgs {
  const ctx = runtime.createUiCtx() as UiCtx & { port: PortUiState };
  ctx.port = port;
  return { ctx, player: localPlayer(ctx) };
}
