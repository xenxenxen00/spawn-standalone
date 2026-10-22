// ScriptLightingModel (docs/design/rendering.md §7.1, Appendix B.1; D2; WP R1a): the live `scripts/lighting.js` is the BRDF of
// every lit surface, run unchanged as a three.js `LightingModel`.
//
// three's node lighting hands a lighting model exactly what the script was written for:
//   - `LightingModel.start()` builds every light node, each of which calls `direct({ lightDirection, lightColor,
//     reflectedLight })`, then calls `indirect()` (three/src/nodes/core/LightingModel.js; LightsNode `setupDirectLight`)
//   - `lightDirection` points towards the light in view space and `lightColor` is colour × intensity × distance attenuation ×
//     spot cone × shadow: the script's `light.direction` and `light.radiance`
//   - `AmbientLight` and `HemisphereLight` add to `context.irradiance`: the script's `lights.ambient`
//
// The adapter:
//   start()     calls `lighting(surface, lights)` once. That only builds the expression graph: `lights.each(cb)` stores `cb` and
//               returns the `directDiffuse` accumulator, which holds the sum of `cb(light)` once every light's code has run.
//               Then three emits the lights.
//   direct()    adds `cb({ direction, radiance })` to the `reflectedLight` it is handed. Inside our own light loops (the grid
//               and dynamic data nodes of render §8.2) that is a loop-local accumulator, so it is never `builder.context`'s.
//   indirect()  runs after every light: assigns the script's return value (direct sum + ambient + environment) to
//               `directDiffuse`. three then adds emissive, and fog after that.
//
// N, V and L are all view-space vectors and the script only takes dot products, so the spaces agree. A new model is created
// per material build (`SurfaceMaterial.setupLightingModel`): it holds the graph of one build.
//
// Hoisting. three writes a shared expression into a temporary at the place it is first needed. The script's `f0` is shared
// by its per-light term and its ambient term, so when the first per-light code is the body of a light `Loop`, the temporary
// would be assigned inside that loop, and a loop of zero iterations (or an iteration that `continue`s early) would leave the
// ambient term, or a second loop, reading a value that was never written [M: the read-back of a scene with ambient light
// and an empty light loop showed metals black]. So `start()` turns every expression the script built outside its
// per-light callback into a real variable declared before the lights, unless it reads one of the accumulators (the direct
// sum, the irradiance, the occlusion), which are complete only after them.
//
// This relies on three internals: `builder.context.{reflectedLight, irradiance, ambientOcclusion}`, the order
// `start → lights → indirect`, and TSL's intent variables (`VarNode#setIntent`, the current stack). The compile and read-back
// specs (tests/e2e/render-r1a.spec.ts) fail if an upgrade changes them.
import { diffuseColor, getCurrentStack, metalness, normalView, positionViewDirection, roughness } from 'three/tsl';
import { LightingModel } from 'three/webgpu';
import type { LightingModelDirectInput, LightingModelReflectedLight, Node, NodeBuilder } from 'three/webgpu';
import type { ModuleRegistry } from '../../compat/core/types.ts';
import { DEV_BUILD, ScriptShapeError, assertLightingScript, logScriptFailureOnce } from './script-types.ts';
import type { LightingScript, ScriptLights, ScriptPerLight, ScriptSurface } from './script-types.ts';

/** the part of three's lighting context (`LightingContextNode.getContext`) the adapter reads */
interface LightingContextView {
  reflectedLight: LightingModelReflectedLight;
  irradiance: Node;
  ambientOcclusion: Node;
}

/** the accumulators are `vec3().toVar()` nodes; @types/three declares them as plain `Node` */
const accumulator = (n: Node): Node<'vec3'> => n as Node<'vec3'>;

const isNode = (v: unknown): v is Node => v !== null && typeof v === 'object' && (v as { isNode?: unknown }).isNode === true;

function lightingContext(builder: NodeBuilder): LightingContextView {
  const ctx = builder.context as Partial<LightingContextView> | null | undefined;
  if (!ctx || !ctx.reflectedLight || !isNode(ctx.reflectedLight.directDiffuse) || !isNode(ctx.irradiance) || !isNode(ctx.ambientOcclusion)) {
    throw new Error('ScriptLightingModel: three no longer provides context.reflectedLight / irradiance / ambientOcclusion to a lighting model (render §20 risk 2)');
  }
  return ctx as LightingContextView;
}

interface IntentVar extends Node {
  isVarNode: true;
  node: Node & { isConstNode?: boolean };
  getIntent(): boolean;
  setIntent(value: boolean): unknown;
}

const isIntentVar = (n: Node): n is IntentVar => (n as Partial<IntentVar>).isVarNode === true && typeof (n as Partial<IntentVar>).getIntent === 'function' && (n as IntentVar).getIntent();

/**
 * Declares the light-independent expressions among `created` (nodes TSL registered in the current stack while the script
 * built its graph) as variables at that place in the stack, i.e. before the lights. An expression that reads one of
 * `accumulators` stays as it is: it is evaluated where the script's result is assigned, after every light.
 */
function hoistLightIndependent(created: readonly Node[], accumulators: ReadonlySet<Node>): number {
  let hoisted = 0;
  for (const node of created) {
    if (!isIntentVar(node) || node.node.isConstNode === true) continue;
    let reads = false;
    node.traverse((n) => {
      if (accumulators.has(n)) reads = true;
    });
    if (reads) continue;
    node.setIntent(false);
    hoisted++;
  }
  return hoisted;
}

export class ScriptLightingModel extends LightingModel {
  readonly #script: LightingScript;
  readonly #env: () => Node;
  #perLight: ScriptPerLight | null = null;
  #result: Node | null = null;

  /**
   * @param script the lighting module (`scripts/lighting.js` through the registry)
   * @param env    builds the node handed to the script as `lights.environment` (`envTerm`, [CAL `envScale`])
   */
  constructor(script: LightingScript, env: () => Node) {
    super();
    this.#script = script;
    this.#env = env;
  }

  override start(builder: NodeBuilder): void {
    // a model holds the graph of one build; a second start() begins a new one
    this.#perLight = null;
    this.#result = null;
    const ctx = lightingContext(builder);
    const surface: ScriptSurface = {
      albedo: diffuseColor.rgb,
      normal: normalView,
      view: positionViewDirection,
      roughness,
      metalness,
      // three's accumulator: 1 unless the material has an `aoNode` (no live material carries an AO map)
      occlusion: ctx.ambientOcclusion,
    };
    const lights: ScriptLights = {
      each: (cb) => {
        if (typeof cb !== 'function') throw new TypeError('lights.each(cb): cb is not a function');
        // one accumulator (three's directDiffuse, and the loop-local ones of the grid nodes): one callback
        if (this.#perLight !== null) throw new Error('the lighting script called lights.each twice; the adapter sums one per-light term');
        this.#perLight = cb;
        return ctx.reflectedLight.directDiffuse; // the sum, once every light is in
      },
      ambient: ctx.irradiance,
      environment: this.#env(),
    };
    // builds the expression graph only; nothing is emitted yet
    const stack = getCurrentStack();
    const mark = stack === null ? 0 : stack.nodes.length;
    const result: unknown = this.#script.lighting(surface, lights);
    if (!isNode(result)) throw new TypeError('the lighting script did not return a node');
    this.#result = result;
    // what the script shares between its per-light and its other terms is computed once, before any light (see the header)
    if (stack !== null) hoistLightIndependent(stack.nodes.slice(mark), new Set([ctx.reflectedLight.directDiffuse, ctx.irradiance, ctx.ambientOcclusion]));
    // emits every light → direct(), then indirect()
    super.start(builder);
  }

  override direct(lightData: LightingModelDirectInput): void {
    const perLight = this.#perLight;
    if (perLight === null) return; // a script that reads no direct light
    const { lightDirection, lightColor, reflectedLight } = lightData;
    // always the accumulator passed in: it may be local to a light loop
    accumulator(reflectedLight.directDiffuse).addAssign(perLight({ direction: lightDirection, radiance: lightColor }) as Node<'vec3'>);
  }

  override indirect(builder: NodeBuilder): void {
    if (this.#result === null) throw new Error('ScriptLightingModel: indirect() before start(); three changed the lighting order (render §20 risk 2)');
    // the summed direct term becomes the script's full return value
    accumulator(lightingContext(builder).reflectedLight.directDiffuse).assign(this.#result as Node<'vec3'>);
  }
}

export interface LoadLightingScriptOptions {
  /** dev builds throw on a malformed module; production logs once and falls back. Default: `import.meta.env.DEV`. */
  dev?: boolean;
  /** production log sink; default `console.error` */
  log?: (message: string) => void;
}

/**
 * Loads the world's lighting module (`world.config.yaml` `lighting:`, live `scripts/lighting.js`) through the registry and
 * checks its export shape. Dev: a module that does not load or does not export `lighting()` throws `ScriptShapeError`.
 * Production: it logs once and resolves null, and `SurfaceMaterials` then builds every surface unlit.
 */
export async function loadLightingScript(registry: Pick<ModuleRegistry, 'load'>, script: string, opts: LoadLightingScriptOptions = {}): Promise<LightingScript | null> {
  try {
    let mod: unknown;
    try {
      mod = await registry.load(script);
    } catch (cause) {
      throw new ScriptShapeError(script, `the lighting module did not load: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
    assertLightingScript(mod, script);
    return mod;
  } catch (e) {
    if ((opts.dev ?? DEV_BUILD) || !(e instanceof ScriptShapeError)) throw e;
    logScriptFailureOnce(script, e, opts.log);
    return null;
  }
}
