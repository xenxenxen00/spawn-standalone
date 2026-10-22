// World lighting, wired into the render facade (docs/design/rendering.md §4.1, §8.2, §8.4, §8.5, §9, §10; docs/architecture.md
// §4.2 step 4; WP R4). One call builds, on the facade's own seams, everything that lights and grades a place:
//
//   the light grid    R1b's `GridLighting`, installed on the renderer (`SceneRoot.installLighting`, which hands the same
//                     instance to a renderer rebuilt after a device loss), with the tier's caps and the facade's FlashGuard
//   the post chain    R5b's `installPostPipeline`: the scene pass, bloom, tone map and the place's look draw the frame
//   the atmosphere    atmosphere.ts: fog, ambient, hemisphere, sky, wet, wind, look, and the live writes
//   the shadowCaster    lighting/shadow-caster.ts: the permanent `SpotLight`, its shadow by tier
//   the moons         the two permanent `DirectionalLight`s as the sink of a place's directional rows
//
// and connects them:
//   - the loop's `lights` stage runs `atmosphere.update(frame)` and then `lighting.update(camera, now, dt)`: the recorded
//     atmosphere writes, the FlashGuard on the fill and on every lamp, then the light texture upload (render §8.5)
//   - a tier change hands the new caps to the grid and the new shadow size to the shadowCaster
//   - the fog reaches the look's haze (`post.setFog`) whenever a place or a write changes it
//   - a place's look reaches the post chain: its script through `loadLook` (the registry's lazy import), its params and tone
//     mapping as they are; the [CAL] post switches are read at each place build (render §10.1)
//   - every renderer the facade binds (the first, and one rebuilt after a device loss) gets `shadowMap.enabled` and
//     `PCFShadowMap` before its pipeline is built
//   - the scene's one `FogExp2` becomes the default fog of `finishScriptedMaterial` (surface/scripted-material.ts), so an
//     additive material under [CAL `additiveFog`] `'fade'` fades with the scene fog whoever builds it
//
// `lights` is the `LightTable` for the render bridge (R13): the owner's own beam goes to the shadowCaster, every other light
// to the grid's table.
//
// Nothing in src/ called `attachGridLighting` or `installPostPipeline` before this module; `createRenderer` of
// src/render/index.ts does not call this one either (the R0, R1a, R5b and R8 harness specs measure the bare facade). The
// engine loader (X1) or the render bridge's attach step (R13) calls it once after `createRenderer`, and feeds
// `atmosphere.load(def)` / `atmosphere.onWrite` from the place runtimes' atmosphere `LayeredValue`s.
import type { PerspectiveCamera } from 'three/webgpu';
import type { DaylightOverrides } from './daylight.ts';
import { calibration } from '../calibration.ts';
import type { FrameInfo } from '../engine/render-loop.ts';
import type { PipelineFactory } from '../index.ts';
import type { FlashGuardControl } from '../lighting/flash-guard.ts';
import { createShadowCaster, routeLights, type ShadowCasterControl, type ShadowMapHost } from '../lighting/shadow-caster.ts';
import { GridLighting, type LightingCaps } from '../lighting/grid-lights-node.ts';
import type { LightTable } from '../lighting/light-table.ts';
import type { TierConfig, TierId } from '../perf/budget.ts';
import type { LookParams } from '../post/look-recorder.ts';
import type { TslLookModule } from '../post/look-runner.ts';
import { IDENTITY_LOOK, installPostPipeline, type InstallPostPipelineOptions, type PostPipelineHandle, type PostSwitches } from '../post/render-pipeline.ts';
import type { SceneRoot } from '../scene/scene-root.ts';
import { setScriptedMaterialFog } from '../surface/scripted-material.ts';
import { createAtmosphere, createMoonLights, type AtmosphereControl, type AtmosphereState, type MoonLights } from './atmosphere.ts';

/** what `installWorldLighting` needs of the render facade (`RenderFacade` of src/render/index.ts fits) */
export interface WorldLightingHost {
  readonly root: SceneRoot;
  /** the current engine: read again whenever it is needed, a device-loss rebuild replaces it */
  readonly engine: { readonly renderer: ShadowMapHost & { lighting: unknown } };
  readonly loop: { setStage(stage: 'lights', run: ((frame: FrameInfo) => void) | null): void };
  readonly camera: { readonly world: PerspectiveCamera };
  readonly tierConfig: TierConfig;
  /** `lighting/flash-guard.ts`: `setReducedFlash` of the facade switches it */
  readonly flashGuard: FlashGuardControl;
  onTierChange(cb: (tier: TierId, config: TierConfig) => void): () => void;
  setPipeline(factory: PipelineFactory): void;
}

export interface WorldLightingOptions {
  /**
   * A place's look script (`atmosphere.look.script`, e.g. authored content) as its module: the registry's lazy
   * import. Without it, or when it fails, the frame is drawn without a look (tone mapped, ungraded).
   */
  loadLook?: (script: string) => Promise<TslLookModule> | TslLookModule;
  /** `installPostPipeline` options (the grain's frame seed; switches override the calibration's) */
  post?: InstallPostPipelineOptions;
  /** K14: the atmosphere model (`model: 'daylight'` opts into the daylight sky, sun and fill; default night), sun slot and distance */
  atmosphere?: { model?: 'night' | 'daylight'; sunSlot?: 0 | 1; sunDistance?: number; daylight?: DaylightOverrides; nightSky?: import('./sky.ts').NightSkyOptions };
  /** default: a new `GridLighting` over the host's FlashGuard */
  lighting?: GridLighting;
  /** the shadowCaster's shadow went on or off with a tier: lit programs recompile on the next frame (the caller holds it) */
  onShadowToggle?: (on: boolean) => void;
  warn?: (message: string) => void;
}

export interface WorldLighting {
  readonly flashGuard: FlashGuardControl;
  readonly lighting: GridLighting;
  /** for the render bridge: the owner's beam → the shadowCaster, everything else → `lighting.table` */
  readonly lights: LightTable;
  readonly atmosphere: AtmosphereControl;
  readonly shadowCaster: ShadowCasterControl;
  readonly moons: MoonLights;
  readonly post: PostPipelineHandle;
  /** settles when the look of the last `atmosphere.load` (or look write) has reached the post chain */
  lookReady(): Promise<void>;
  /** undoes the stage and the listeners; the lighting system and the pipeline stay installed on the renderer */
  dispose(): void;
}

const postSwitches = (): PostSwitches => ({ tonemapOrder: calibration.tonemapOrder, bloomKernel: calibration.bloomKernel, fxaa: calibration.fxaa });

export function installWorldLighting(host: WorldLightingHost, opts: WorldLightingOptions = {}): WorldLighting {
  const { root } = host;
  const flashGuard = host.flashGuard;

  // the light grid, as `attachGridLighting` installs it (its stage is filled below, together with the atmosphere's)
  const lighting = opts.lighting ?? new GridLighting({ flashGuard });
  lighting.setCaps(host.tierConfig satisfies LightingCaps);
  root.installLighting(host.engine.renderer as never, lighting);

  const shadowCaster = createShadowCaster({ light: root.lights.shadowCaster, shadowSize: host.tierConfig.shadowCasterMapSize });
  shadowCaster.bindRenderer(host.engine.renderer);

  // the post chain; the facade calls the factory for every engine it binds, so a rebuilt renderer gets its shadow state there
  const post = installPostPipeline(
    {
      setPipeline: (factory) =>
        host.setPipeline((ctx) => {
          shadowCaster.bindRenderer(ctx.renderer as unknown as ShadowMapHost);
          return factory(ctx);
        }),
      onTierChange: (cb) => host.onTierChange(cb),
    },
    { ...opts.post, switches: { ...postSwitches(), ...opts.post?.switches } },
  );

  const atmosphere = createAtmosphere({ root, flashGuard, ...(opts.warn === undefined ? {} : { warn: opts.warn }), ...(opts.atmosphere ?? {}) });
  const moons = createMoonLights(root.lights.directionals);
  // every additive material finished from now on that fades in fog ([CAL `additiveFog`] `'fade'`) reads this fog's density
  setScriptedMaterialFog(root.linearFog ?? atmosphere.fog);

  const offFog = atmosphere.onFogChange((fog) => post.setFog(fog.density, fog.color));

  // the look: the module by script (kept once loaded), then params and tone mapping
  const modules = new Map<string, TslLookModule>();
  let lookToken = 0;
  let lookSettled: Promise<void> = Promise.resolve();
  const build = (mod: TslLookModule, look: Readonly<AtmosphereState['look']>): void => {
    // "the switch is read once per place build" (render §10.1)
    post.setSwitches({ ...postSwitches(), ...opts.post?.switches });
    post.build(mod, look.params as LookParams, look.toneMapping);
  };
  const offLook = atmosphere.onLookChange((look) => {
    const token = ++lookToken;
    const known = look.script === '' || opts.loadLook === undefined ? IDENTITY_LOOK : modules.get(look.script);
    if (known !== undefined) {
      build(known, look);
      lookSettled = Promise.resolve();
      return;
    }
    const { script } = look;
    lookSettled = Promise.resolve()
      .then(() => opts.loadLook!(script))
      .then(
        (mod) => {
          modules.set(script, mod);
          // a later place or write has taken over: its own build stands
          if (token === lookToken) build(mod, atmosphere.state.look);
        },
        (e: unknown) => {
          console.error(`world lighting: the look script ${script} did not load; the frame is drawn without a look`, e);
          if (token === lookToken) build(IDENTITY_LOOK, atmosphere.state.look);
        },
      );
  });

  host.loop.setStage('lights', (frame) => {
    atmosphere.update(frame);
    lighting.update(host.camera.world, frame.now, frame.dt);
  });

  const offTier = host.onTierChange((_tier, config) => {
    lighting.setCaps(config);
    if (shadowCaster.setShadowTier(config)) opts.onShadowToggle?.(config.shadowCasterMapSize > 0);
  });

  return {
    flashGuard,
    lighting,
    lights: routeLights(lighting.table, shadowCaster),
    atmosphere,
    shadowCaster,
    moons,
    post,
    lookReady: () => lookSettled,
    dispose(): void {
      offTier();
      offFog();
      offLook();
      lookToken++;
      host.loop.setStage('lights', null);
      setScriptedMaterialFog(null);
      post.dispose();
      atmosphere.dispose();
      shadowCaster.dispose();
    },
  };
}
