// R10: the fx runtime's setup — atlas resolve/load, the live-tier budget, and disposal of the separately loaded atlas.
//
// Runtime-pure of three: the texture loader, the tier readers and the factory are injected, so this module is
// unit-testable without the renderer. `installGame` (render/world/install.ts) supplies the real seams.
import type { Object3D, Texture } from 'three/webgpu';
import type { RenderBudget, TierConfig, TierId } from '../perf/budget.ts';
import type { FxRuntimeApi, FxSystemOptions } from './fx-system.ts';

/** the asset key the atlas tool registers (`public/fx-atlas.png`); the index exposes it under `assets/fx/` */
export const FX_ATLAS_KEY = 'assets/fx/fx-atlas.png';

/** where the fx run (DR-53): the fx Worker, or the in-process runtime */
export type FxModeChoice = 'worker' | 'inline';

/**
 * The fx mode of a page: the app's choice when it made one, else `?fx=inline` of the query (the in-process runtime, for
 * diagnosis and the inline e2e run), else the worker, where the page has workers at all.
 */
export function fxModeOf(choice: FxModeChoice | undefined, search: string, hasWorker: boolean): FxModeChoice {
  if (choice !== undefined) return choice === 'worker' && !hasWorker ? 'inline' : choice;
  if (new URLSearchParams(search).get('fx') === 'inline') return 'inline';
  return hasWorker ? 'worker' : 'inline';
}

/** what `setupFxRuntime` needs; everything the renderer touches comes through these seams */
export interface FxSetupHost {
  /** the atlas URL, or null when the asset index holds no entry for it (`AssetResolver.resolve()` may return null) */
  resolveAtlas(): string | null;
  /** loads the atlas texture (the caller sets its color space); the setup owns and disposes the result */
  loadAtlas(url: string): Promise<Texture>;
  readonly world: Object3D;
  /** DSL `follow=camera` weather follows the viewer in world projection (viewmodel FX stays a separate gap) */
  readonly camera: Object3D;
  /** the post pipeline's distort scene, read every frame (F3: `distort` sprites draw only there); undefined: none */
  readonly distortScene?: (() => Object3D | null) | undefined;
  /** read live on every use: the fx budget follows quality-tier changes after install */
  tier(): TierId;
  tierConfig(): TierConfig;
  readonly lighting: FxSystemOptions['lighting'];
  readonly lights: FxSystemOptions['lights'];
  /** the app's device/mobile flag; undefined: the fx default (the app owns this value) */
  readonly mobile?: boolean | undefined;
  /** the governor's fx held-factor multiplier (render §15.2), read when an effect starts */
  readonly heldScale?: (() => number) | undefined;
  /**
   * Opt-in fallback: a generated atlas (`atlas-default.ts`) used when the game ships none (`resolveAtlas()` is null) or its file
   * does not load. The setup owns and disposes it like a loaded one. Absent: the legacy host, fx stays off
   */
  builtinAtlas?(): Texture;
  /**
   * Opt-in, after `builtinAtlas`: with no atlas the runtime still starts for its `light()` sinks (`FxSystemOptions.lightsOnly`),
   * on this placeholder texture (never sampled). Absent: the legacy host, fx stays off
   */
  lightsOnlyAtlas?(): Texture;
  /** opt-in: `FxSystemOptions.alignedCards` */
  readonly alignedCards?: boolean;
  /** opt-in: `FxSystemOptions.heldFollow` */
  readonly heldFollow?: boolean;
  /** Current the legacy host ranges by default; false opts into the legacy unit roll. */
  readonly rangeRolls?: boolean;
  create(options: FxSystemOptions): FxRuntimeApi;
  log(message: string): void;
}

export interface FxSetup {
  /** null when the atlas could not be resolved or loaded: the bridge tolerates null fx */
  readonly fx: FxRuntimeApi | null;
  /** disposes the runtime (when built) and the separately loaded atlas texture; idempotent */
  dispose(): void;
}

const nothing: FxSetup = {
  fx: null,
  dispose() {},
};

/**
 * Builds the fx runtime, or returns null fx (with a warning) when its atlas cannot be resolved or loaded. The atlas
 * texture is loaded separately from the row textures, so this setup owns its disposal: `dispose()` runs the
 * runtime's dispose first, then the texture's. A runtime that throws during creation leaves no half-built state: the
 * loaded atlas is disposed and fx stays null.
 */
export async function setupFxRuntime(host: FxSetupHost): Promise<FxSetup> {
  const url = host.resolveAtlas();
  let atlas: Texture | null = null;
  let lightsOnly = false;
  if (url === null || url === '') {
    if (host.builtinAtlas === undefined && host.lightsOnlyAtlas !== undefined) {
      host.log(`[fx] no atlas texture (${FX_ATLAS_KEY} did not resolve): fx run for their lights only`);
      atlas = host.lightsOnlyAtlas();
      lightsOnly = true;
    } else if (host.builtinAtlas === undefined) {
      host.log(`[fx] no atlas texture (${FX_ATLAS_KEY} did not resolve), fx stays off`);
      return nothing;
    } else {
      host.log(`[fx] no atlas texture (${FX_ATLAS_KEY} did not resolve): using the built-in atlas`);
      atlas = host.builtinAtlas();
    }
  } else {
    try {
      atlas = await host.loadAtlas(url);
    } catch (e) {
      if (host.builtinAtlas === undefined && host.lightsOnlyAtlas !== undefined) {
        host.log(`[fx] the atlas did not load (${e instanceof Error ? e.message : String(e)}): fx run for their lights only`);
        atlas = host.lightsOnlyAtlas();
        lightsOnly = true;
      } else if (host.builtinAtlas === undefined) {
        host.log(`[fx] no atlas texture, fx stays off: ${e instanceof Error ? e.message : String(e)}`);
        return nothing;
      } else {
        host.log(`[fx] the atlas did not load (${e instanceof Error ? e.message : String(e)}): using the built-in atlas`);
        atlas = host.builtinAtlas();
      }
    }
  }
  const budget: RenderBudget = {
    get tier() {
      return host.tier();
    },
    cap: (name, fallback) => {
      const v = (host.tierConfig() as unknown as Record<string, unknown>)[name];
      return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    },
  };
  let fx: FxRuntimeApi;
  try {
    fx = host.create({
      world: host.world,
      camera: host.camera,
      ...(host.distortScene === undefined ? {} : { distortScene: host.distortScene }),
      atlas,
      budget,
      ...(host.lighting === undefined ? {} : { lighting: host.lighting }),
      ...(host.lights === undefined ? {} : { lights: host.lights }),
      ...(host.mobile === undefined ? {} : { mobile: host.mobile }),
      ...(host.heldScale === undefined ? {} : { heldScale: host.heldScale }),
      log: host.log,
      ...(lightsOnly ? { lightsOnly: true } : {}),
      ...(host.alignedCards === true ? { alignedCards: true } : {}),
      ...(host.heldFollow === true ? { heldFollow: true } : {}),
      ...(host.rangeRolls === undefined ? {} : { rangeRolls: host.rangeRolls }),
    });
  } catch (e) {
    host.log(`[fx] the fx runtime failed to start, fx stays off: ${e instanceof Error ? e.message : String(e)}`);
    try {
      atlas.dispose();
    } catch {
      // already failing to start: nothing more to do
    }
    atlas = null;
    return nothing;
  }
  let disposed = false;
  return {
    fx,
    dispose() {
      if (disposed) return;
      disposed = true;
      fx.dispose();
      atlas?.dispose();
      atlas = null;
    },
  };
}
