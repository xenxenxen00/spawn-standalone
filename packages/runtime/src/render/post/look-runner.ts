// Runs a place's look script as TSL (docs/design/rendering.md §10.4; WP R5b).
//
// `runLook(mod, sceneColor, param)` calls the look's `look(ctx)` once: `ctx.scene` is the colour node the pipeline hands in (the
// display frame or the linear frame, per `tonemapOrder`), `ctx.param(name, def)` returns that param's `uniform()`. The result is
// the node the pipeline draws.
//
// The param store is what stands behind `ctx.param`: one uniform per look param, created on first use and set to
// `placeParams[name] ?? def` on every call (Spawn: "use node operations such as .mul() on ctx.param values",
// engine/api-reference.md:1669-1679). The three bloom uniforms are created with the engine defaults before the look runs; the
// look's own `ctx.param('bloomStrength', 0.55)` then sets their value, so a look that discards the result (kf2-mix.js:9-11)
// still drives the bloom. A place param write is `setPlaceParams`: uniform writes, no new node, no recompile.
//
// The look module itself comes from the module registry's lazy import of `atmosphere.look.script`; nothing here imports one.
import { uniform } from 'three/tsl';
import { Vector2, Vector3, Vector4 } from 'three/webgpu';
import type { Node, UniformNode } from 'three/webgpu';
import type { LookParams } from './look-recorder.ts';

/** a look param's uniform: a float, or a vector for a 2-, 3- or 4-number param */
export type LookParamUniform = UniformNode<string, number | Vector2 | Vector3 | Vector4>;

/** what a look's `look(ctx)` receives (render §10.4); the recorder's `LookCtx` is its M0 counterpart with tokens and numbers */
export interface TslLookCtx {
  /** vec4 */
  readonly scene: Node;
  param(name: string, def?: number | readonly number[]): LookParamUniform;
}

export type LookParamFn = TslLookCtx['param'];

export interface TslLookModule {
  look(ctx: TslLookCtx): unknown;
}

export class LookRunError extends Error {
  override name = 'LookRunError';
}

/** Engine bloom when neither the place nor the script names a bloom param (the values of look-recorder.ts `ENGINE_BLOOM_DEFAULTS`). */
export const ENGINE_BLOOM = Object.freeze({ strength: 0.15, radius: 0.6, threshold: 1 });

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && (v as { isNode?: unknown }).isNode === true;

/** Calls `mod.look(ctx)` once and returns the node it built. */
export function runLook(mod: TslLookModule, sceneColor: Node, param: LookParamFn): Node {
  if (typeof (mod as Partial<TslLookModule> | null | undefined)?.look !== 'function') throw new LookRunError('runLook: the look module has no look(ctx) export');
  if (!isNode(sceneColor)) throw new LookRunError('runLook: the scene colour must be a TSL node');
  const ctx: TslLookCtx = Object.freeze({ scene: sceneColor, param });
  const out = mod.look(ctx);
  if (!isNode(out)) throw new LookRunError('runLook: look(ctx) must return a TSL node (ctx.scene or the result of a builtin/postfx call)');
  return out;
}

export interface BloomUniforms {
  strength: UniformNode<'float', number>;
  radius: UniformNode<'float', number>;
  threshold: UniformNode<'float', number>;
}

export interface LookParamStore {
  /** `ctx.param` */
  readonly param: LookParamFn;
  get(name: string): LookParamUniform | undefined;
  names(): string[];
  /** the current values, vectors as arrays */
  values(): Record<string, number | number[]>;
  /**
   * Before a look runs: `bloomStrength`, `bloomRadius`, `bloomThreshold` with the engine defaults as their defaults (a place
   * value still wins). The same three nodes on every call; the look's own `ctx.param` call then sets its default.
   */
  bloom(): BloomUniforms;
  /** A place param write: every uniform takes `params[name] ?? its remembered default`. No node is created or replaced. */
  setPlaceParams(params: LookParams): void;
  /**
   * Before another look module runs: takes the new place params and drops every uniform but the bloom three (which the bloom
   * node holds), so the new look's params get fresh nodes of their own type.
   */
  forgetLook(params: LookParams): void;
}

type ParamValue = number | readonly number[];

function coerce(name: string, v: unknown): ParamValue {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) return v as number[];
  throw new LookRunError(`look param '${name}' must be a finite number or an array of 2 to 4 numbers to be a uniform, got ${JSON.stringify(v)}`);
}

const size = (v: ParamValue): number => (typeof v === 'number' ? 1 : v.length);

function makeUniform(v: ParamValue): LookParamUniform {
  if (typeof v === 'number') return uniform(v);
  if (v.length === 2) return uniform(new Vector2(v[0], v[1]));
  if (v.length === 3) return uniform(new Vector3(v[0], v[1], v[2]));
  return uniform(new Vector4(v[0], v[1], v[2], v[3]));
}

export function createLookParamStore(placeParams: LookParams): LookParamStore {
  let place: LookParams = placeParams;
  const uniforms = new Map<string, { node: LookParamUniform; size: number; def: ParamValue | undefined }>();

  const valueOf = (name: string, def: ParamValue | undefined): ParamValue => {
    const own = Object.hasOwn(place, name) ? place[name] : undefined;
    const v = own ?? def;
    if (v === undefined) throw new LookRunError(`look param '${name}' has no value: the place sets none and the look gives no default`);
    return coerce(name, v);
  };

  const write = (name: string, entry: { node: LookParamUniform; size: number }, v: ParamValue): void => {
    if (size(v) !== entry.size) {
      throw new LookRunError(`look param '${name}' is a ${entry.size === 1 ? 'float' : `vec${entry.size}`} uniform and cannot take ${JSON.stringify(v)}`);
    }
    if (typeof v === 'number') entry.node.value = v;
    else (entry.node.value as Vector2 | Vector3 | Vector4).fromArray(v as number[]);
  };

  const param: LookParamFn = (name, def) => {
    if (typeof name !== 'string' || name === '') throw new LookRunError(`ctx.param: the name must be a non-empty string, got ${JSON.stringify(name)}`);
    const v = valueOf(name, def);
    let entry = uniforms.get(name);
    if (entry === undefined) {
      entry = { node: makeUniform(v), size: size(v), def };
      uniforms.set(name, entry);
    } else {
      write(name, entry, v);
      entry.def = def;
    }
    return entry.node;
  };

  const BLOOM_NAMES: ReadonlySet<string> = new Set(['bloomStrength', 'bloomRadius', 'bloomThreshold']);

  return {
    param,
    get: (name) => uniforms.get(name)?.node,
    names: () => [...uniforms.keys()],
    values() {
      const out: Record<string, number | number[]> = {};
      for (const [name, { node }] of uniforms) out[name] = typeof node.value === 'number' ? node.value : node.value.toArray();
      return out;
    },
    bloom() {
      return {
        strength: param('bloomStrength', ENGINE_BLOOM.strength) as UniformNode<'float', number>,
        radius: param('bloomRadius', ENGINE_BLOOM.radius) as UniformNode<'float', number>,
        threshold: param('bloomThreshold', ENGINE_BLOOM.threshold) as UniformNode<'float', number>,
      };
    },
    setPlaceParams(params) {
      place = params;
      for (const [name, entry] of uniforms) write(name, entry, valueOf(name, entry.def));
    },
    forgetLook(params) {
      place = params;
      for (const name of [...uniforms.keys()]) if (!BLOOM_NAMES.has(name)) uniforms.delete(name);
    },
  };
}
