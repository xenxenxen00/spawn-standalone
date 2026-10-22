// Fakes for the UI host tests (WP UI1). The real UI ctx is the kernel's `createUiCtx()` (core §7.5, WP C5); until C5 lands the
// host is driven through this fake `UiRuntimePort`, which returns a plain ctx with the members the carried render reads.
import type { UiCtx, PlayerView } from '../../../src/compat/core/types.ts';
import type { UiRuntimePort } from '../../../src/runtime/ui/ui-ctx.ts';
import type { GameUiModule } from '../../../src/runtime/ui/game-ui.d.ts';

export interface FakeRuntime extends UiRuntimePort {
  readonly worldState: Record<string, unknown>;
  readonly session: Record<string, unknown>;
  nowMs: number;
  readonly warnings: string[];
  /** the ctx objects handed out, newest last */
  readonly made: UiCtx[];
}

export function fakeRuntime(worldState: Record<string, unknown> = {}, inputs: unknown = null): FakeRuntime {
  const player = { id: 'player/local', userId: 'u-me', isLocal: true, controlling: null, state: {} } as unknown as PlayerView;
  const rt: FakeRuntime = {
    worldState,
    session: {},
    nowMs: 1_000_000,
    warnings: [],
    made: [],
    createUiCtx(): UiCtx {
      const ctx = {
        kind: 'ui',
        self: null,
        world: { state: worldState, inputs, players: [player], places: {}, settling: false, camera: {} },
        session: rt.session,
        view: { camera: null },
        getObject: () => null,
        now: () => rt.nowMs,
        random: () => 0.5,
        log: () => {},
        warn: (m: string) => rt.warnings.push(String(m)),
        error: () => {},
      } as unknown as UiCtx;
      rt.made.push(ctx);
      return ctx;
    },
  };
  return rt;
}

/** a GameUiModule whose render returns `next.html` (or throws `next.error`) and records its calls */
export interface ScriptedUi extends GameUiModule {
  html: string;
  error: Error | null;
  calls: number;
  mounted: HTMLElement | null;
  destroyed: boolean;
}

export function scriptedUi(html = ''): ScriptedUi {
  const noop = (): void => {};
  const ui = {
    html,
    error: null as Error | null,
    calls: 0,
    mounted: null as HTMLElement | null,
    destroyed: false,
    default(): string {
      ui.calls++;
      if (ui.error) throw ui.error;
      return ui.html;
    },
    onMount(container: HTMLElement): void {
      ui.mounted = container;
    },
    onDestroy(): void {
      ui.destroyed = true;
    },
    ssClick: noop,
    ssNav: noop,
    ssWelcome: noop,
    ssWelcomeClose: noop,
    ssWelcomeGo: noop,
    ssBoard: noop,
    ssSelect: noop,
    ssShopFilter: noop,
    ssFav: noop,
    ssRole: noop,
    ssOperator: noop,
    ssSkill: noop,
    ssBotSet: noop,
    ssPrefLive: noop,
    ssPref: noop,
  };
  return ui as ScriptedUi;
}

/** the live render shape (`scripts/ui/main.js:131`): `<style>…</style><div id='game' …>${curtain}${sprite}${body}</div>` */
export function renderString(opts: { css?: string; cls?: string; scale?: number; sprite?: string; body: string }): string {
  const css = opts.css ?? '#game{position:fixed;inset:0}';
  return `<style>${css}</style><div id='game' class="${opts.cls ?? ''}" style="--ss-scale:${opts.scale ?? 1}">${opts.sprite ?? ''}${opts.body}</div>`;
}

/** the live sprite form (`scripts/ui/icons.js:10-16`): gradients and symbols in one `<defs>` of a zero-size svg */
export function spriteSvg(symbolIds: readonly string[], gradients: readonly string[] = ['ss-sheen']): string {
  const grads = gradients.map((g) => `<linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/></linearGradient>`).join('');
  const syms = symbolIds.map((s) => `<symbol id="${s}" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></symbol>`).join('');
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${grads}${syms}</defs></svg>`;
}

export const icon = (name: string): string => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><use href="#pi-${name}"/></svg>`;

export const LEGACY_UI_CONFIG = {rootId:'game',blankSelector:'.ss-blank',styleId:'ss-style',spriteId:'ss-sprites',readyWhen:'modal' as const};
