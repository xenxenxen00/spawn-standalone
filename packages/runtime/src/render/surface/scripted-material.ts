// Scripted materials (docs/design/rendering.md §14.1, §13.5; WP R1a): a row whose `material` is
// `{ kind: 'scripted', script }` gets the node material its module builds. The one live use is the scripted row material,
// authored content (authored content), executed unchanged: it imports `builtin/tsl` and
// `builtin/three`, which are three r186, and its `time` is the port's pausable shader time (X-11).
//
// What this module adds to what the script returns:
//   - export-shape validation when the module loads: a dev build throws `ScriptShapeError`; a production build logs once
//     per script and gives the row an unlit material instead
//   - `forceSinglePass = true` on a transparent `DoubleSide` material: three otherwise draws it twice (back faces, then front
//     faces), and with additive blending and no depth write the single pass gives the same pixels at half the draws
//   - the one fog rule of every additive material, [CAL `additiveFog`]: `'three'` (default) leaves the material's own
//     `fog = true`, so three's `FogExp2` mixes its colour toward the fog colour, which is how Spawn's three renderer drew this
//     unedited module; `'fade'` sets `fog = false` and scales the output by `1 − densityFogFactor(density)`
//
// The module is loaded through the registry (a lazy chunk: it and three stay out of the boot closure).
import { densityFogFactor, output, rangeFogFactor, reference, vec3, vec4 } from 'three/tsl';
import { AdditiveBlending, DoubleSide, MeshBasicNodeMaterial } from 'three/webgpu';
import type { NodeMaterial } from 'three/webgpu';
import type { ModuleRegistry } from '../../compat/core/types.ts';
import { calibration, type AdditiveFog } from '../calibration.ts';
import type { ScriptedMaterialSpec } from './material-spec.ts';
import { createMaterialParamStore, MATERIAL_PARAMS_KEY } from './material-params.ts';
import { DEV_BUILD, ScriptShapeError, assertScriptedMaterialModule, logScriptFailureOnce, type MaterialCtx } from './script-types.ts';

export interface ScriptedMaterialOptions {
  /** dev builds throw on a malformed module; production logs once and falls back. Default: `import.meta.env.DEV`. */
  dev?: boolean;
  /** [CAL `additiveFog`]; default: the runtime calibration */
  additiveFog?: AdditiveFog;
  /**
   * the scene's `FogExp2` (never replaced, only mutated): what `'fade'` reads the density from. Default: the fog handed over
   * with `setScriptedMaterialFog`; an explicit `null` is no fog
   */
  fog?: SceneFogLike | null;
  /** production log sink; default `console.error` */
  log?: (message: string) => void;
}

/** the scene's fog as 'fade' reads it: `FogExp2` (`density`, the legacy host) or, K14, a linear `Fog` (`near` / `far`) */
export type SceneFogLike = { density: number } | { near: number; far: number };

let sceneFog: SceneFogLike | null = null;

/**
 * The scene's one `FogExp2`, handed over by the atmosphere wiring (R4, atmosphere/install.ts): the `fog` every material
 * finished after the call gets when its caller passes none. Without it `'fade'` could only switch three's fog off, and a
 * distant additive surface would be drawn unfogged at full strength. `null` takes it back.
 */
export function setScriptedMaterialFog(fog: SceneFogLike | null): void {
  sceneFog = fog;
}

const isNodeMaterial = (v: unknown): v is NodeMaterial => v !== null && typeof v === 'object' && (v as { isNodeMaterial?: unknown }).isNodeMaterial === true;

/** what a row gets when its material module is unusable in a production build: unlit mid grey, fogged */
export function fallbackScriptedMaterial(): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  m.name = 'ss:scripted:fallback';
  m.lights = false;
  m.colorNode = vec3(0.5);
  return m;
}

/** The rules every material returned by a script goes through (see the header). */
export function finishScriptedMaterial(material: NodeMaterial, opts: Pick<ScriptedMaterialOptions, 'additiveFog' | 'fog'> = {}): NodeMaterial {
  if (material.transparent && material.side === DoubleSide) material.forceSinglePass = true;
  if (material.blending === AdditiveBlending) {
    const rule = opts.additiveFog ?? calibration.additiveFog;
    if (rule === 'fade') {
      material.fog = false;
      const fog = opts.fog === undefined ? sceneFog : opts.fog;
      if (fog !== null) {
        // distant additive light fades to nothing instead of turning into fog-coloured light
        const keep = ('near' in fog ? rangeFogFactor(reference('near', 'float', fog), reference('far', 'float', fog)) : densityFogFactor(reference('density', 'float', fog))).oneMinus();
        material.outputNode = vec4(output.rgb.mul(keep), output.a);
      }
    }
  }
  return material;
}

/**
 * Runs a loaded material module for a row. `mod` is the module namespace (`registry.get(path)` / `registry.load(path)`).
 * Dev: a module without `material()`, a throwing `material()` or a return value that is not a node material throws
 * `ScriptShapeError`. Production: the same cases log once and return the fallback.
 */
export function buildScriptedMaterial(mod: unknown, spec: ScriptedMaterialSpec, opts: ScriptedMaterialOptions = {}): NodeMaterial {
  const dev = opts.dev ?? DEV_BUILD;
  try {
    assertScriptedMaterialModule(mod, spec.script);
    const store = createMaterialParamStore(spec.params);
    const ctx: MaterialCtx = { params: Object.freeze({ ...(spec.params ?? {}) }), param: (name, def) => store.param(name, def) };
    let made: unknown;
    try {
      made = mod.material(ctx);
    } catch (cause) {
      throw new ScriptShapeError(spec.script, `material(ctx) threw: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
    if (!isNodeMaterial(made)) throw new ScriptShapeError(spec.script, 'material(ctx) did not return a node material');
    if (store.names().length > 0) (made.userData as Record<string, unknown>)[MATERIAL_PARAMS_KEY] = store; // K10c live params
    return finishScriptedMaterial(made, opts);
  } catch (e) {
    if (dev || !(e instanceof ScriptShapeError)) throw e;
    logScriptFailureOnce(spec.script, e, opts.log);
    return fallbackScriptedMaterial();
  }
}

/** Loads the row's material module through the registry and builds its material. A module the registry cannot load follows the same dev/production rule. */
export async function loadScriptedMaterial(registry: Pick<ModuleRegistry, 'load'>, spec: ScriptedMaterialSpec, opts: ScriptedMaterialOptions = {}): Promise<NodeMaterial> {
  let mod: unknown;
  try {
    mod = await registry.load(spec.script);
  } catch (cause) {
    const error = new ScriptShapeError(spec.script, `the material module did not load: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    if (opts.dev ?? DEV_BUILD) throw error;
    logScriptFailureOnce(spec.script, error, opts.log);
    return fallbackScriptedMaterial();
  }
  return buildScriptedMaterial(mod, spec, opts);
}
