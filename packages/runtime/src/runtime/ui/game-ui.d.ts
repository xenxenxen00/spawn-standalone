// Boundary types of the carried `scripts/ui.js` (io §3.3, §0.3; spawn-engine-contract.md §14): the default export is the render,
// the named exports are the page globals its inline handlers call (system-ui.md §2.5), `onMount` / `onDestroy` take the game
// mount container. Only `src/game-api/ui.ts` casts the carried module to this type.
import type { PlayerView, UiCtx } from '../../compat/core/types.ts';

/** the `player` argument of `render(ctx, player)`: the local human's read-only PlayerView (core §3.5, §7.5) */
export type UiPlayerView = Readonly<PlayerView>;

export interface GameUiModule {
  /** `render(ctx, player) → string`; a throw blanks nothing here: the host keeps the last DOM (io §3.4 step 1) */
  default(ctx: UiCtx, player: UiPlayerView | null): string;
  onMount?(container: HTMLElement, player: UiPlayerView | null): void;
  onDestroy?(container: HTMLElement): void;
  [handler: string]: unknown;
}
