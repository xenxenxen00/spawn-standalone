import type { Object3D, Texture } from 'three/webgpu';
import { Vector3 } from 'three/webgpu';
import type { FxBinding, FxSystem, BridgeLights } from '../bridge/bridge-types.ts';
import type { FrameInfo } from '../engine/render-loop.ts';
import { calibration, type AdditiveFog } from '../calibration.ts';
import { fxFollowOf, type FxTier, type Vec3 } from './dsl/compile.ts';
import type { LightingScript } from '../surface/script-types.ts';
import { tierConfig, type RenderBudget } from '../perf/budget.ts';
import { FX_MAX_PARTICLES, type FxSimulation, type FxSimulationOptions } from './sim/simulator.ts';
import type { FxSpriteBuckets, FxDistortTarget } from './render/buckets.ts';
import type { FxStretchedBuckets } from './render/stretched-buckets.ts';
import type { FxTarget } from './fx-protocol.ts';
import { FxPresenter } from './fx-presenter.ts';
import { fxLight, fxLightsDropUnlit, fxLightsRemoveAll, type FxLightOwner } from './fx-lights.ts';
import { FxWorld, type FxWorldEffect } from './world/fx-world.ts';

export interface FxProgramSpec {
  readonly script: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly seed?: number;
}

export interface FxSystemOptions {
  readonly world: Object3D;
  readonly camera?: Object3D | null;
  /**
   * the post pipeline's distort scene (render §10.2), or a getter for it (read every frame: the pipeline is built after the
   * runtime): `distort` sprites draw there, as screen offsets, and nowhere else (F3)
   */
  readonly distortScene?: FxDistortTarget;
  readonly atlas: Texture;
  readonly budget: RenderBudget;
  /** supplies FX DSL source for script paths; inline strings beginning with `fx` need no resolver */
  readonly resolveScript?: (scriptPath: string) => string | undefined;
  readonly lighting?: LightingScript | null;
  readonly lights?: BridgeLights | null;
  readonly additiveFog?: AdditiveFog;
  readonly mobile?: boolean;
  readonly strict?: boolean;
  readonly maxEffects?: number;
  readonly gravity?: Vec3;
  readonly wind?: Vec3;
  readonly floorHeight?: FxSimulationOptions['floorHeight'];
  /** Called for a bound owner to decide whether a held light may enter the static grid. */
  readonly staticOwner?: (node: Object3D) => boolean;
  /** the governor's fx lever (render §15.2): a multiplier ≤ 1 on the tier's held factor, read when an effect starts */
  readonly heldScale?: () => number;
  readonly log?: (message: string) => void;
  /**
   * Opt-in (`GameDeps.fxLightsWithoutAtlas`): the runtime runs for its `light()` sinks only (the game ships no atlas): no sprite,
   * stretched or mesh sink is drawn, `warmObjects()` is empty. Default false
   */
  readonly lightsOnly?: boolean;
  /**
   * Opt-in (`GameDeps.fxAlignedCards`): `align=axis` / `align=velocity` sprites draw as cards turned to the camera around their
   * long axis (the axis, or the velocity), long side `size + stretch` metres on `axis` (`sk/fx:27`). Default false (the legacy host: a
   * full billboard that ignores the instance rotation, which smears long axis cards into wide wedges)
   */
  readonly alignedCards?: boolean;
  /**
   * Opt-in (`GameDeps.fxHeldFollow`): particles of an `at=` population (a held position: a torch's glow, its light) move with
   * the effect's anchor, so an effect bound before its row was placed does not keep them at the world origin. Default false
   * (the legacy host: born where the anchor was, then left there)
   */
  readonly heldFollow?: boolean;
  /**
   * Ranges roll inside their bounds by default (current the legacy host). Explicit false preserves the legacy unit roll.
   */
  readonly rangeRolls?: boolean;
}

export type FxEffectId = number & { readonly __fxEffectId: unique symbol };

/** where the fx run: the fx Worker, the main thread by choice (`?fx=inline`), or the main thread after the worker failed */
export type FxMode = 'worker' | 'inline' | 'inline-fallback';

/** what the runtime reports (`state().fx` in test builds; DESIGN §14 item 6) */
export interface FxRuntimeStats {
  readonly mode: FxMode;
  /** effects and particles of the last presented frame */
  readonly effects: number;
  readonly particles: number;
  readonly meshParticles: number;
  /** fx stages run */
  readonly frames: number;
  /** worker results presented */
  readonly presented: number;
  /** fx stages that found no new result while a step was in flight (the buckets kept the previous one) */
  readonly late: number;
  /** frames merged into a pending step (their dt summed) because a step was in flight */
  readonly merged: number;
  /** the worker's step and fills, ms: the last, the median and the p95 of the last 600 */
  readonly stepMs: { readonly last: number; readonly p50: number; readonly p95: number; readonly max: number };
  /** why the worker is not used ('inline-fallback'); null otherwise */
  readonly fallback: string | null;
}

/** the fx runtime as the game install hands it on (`GameWorld.fx`): the in-process runtime and the worker facade */
export interface FxRuntimeApi extends FxSystem {
  /** Start an unbound effect; `origin` is in world space. Returns null for an invalid (or, in-process, a refused) effect. */
  emit(spec: unknown, origin?: Vec3): FxEffectId | null;
  /** Stop and remove an act-emitted effect. */
  end(id: FxEffectId): void;
  /** true while the runtime still tracks the effect */
  has(id: FxEffectId): boolean;
  update(frame: Pick<FrameInfo, 'dt' | 'now'>): void;
  warmObjects(): Object3D[];
  armDistortWarm(): { armed: boolean; done(): void };
  dispose(): void;
  readonly effectCount: number;
  readonly particleCount: number;
  readonly sprites: FxSpriteBuckets;
  readonly stretched: FxStretchedBuckets;
  stats(): FxRuntimeStats;
}

/** the governor's held-factor multiplier, kept in [0, 1]; 1 without one */
export function heldScaleOf(read: (() => number) | undefined): number {
  const v = read?.() ?? 1;
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isProgramSource(script: string): boolean { return /^\s*fx(?:\s|$)/.test(script); }

export function fxTier(options: Pick<FxSystemOptions, 'budget' | 'mobile'>): FxTier {
  const tier = options.budget.tier;
  return { low: tier === 'low' || tier === 'minimum', mobile: options.mobile === true };
}

/** a spec the runtime takes: its script resolved to the program text */
export interface ResolvedSpec {
  readonly script: string;
  readonly source: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly seed: number | undefined;
}

/**
 * The checks `FxRuntime#start` makes before anything is compiled (synchronous on the main thread in both runtimes): a
 * non-empty script string, an object of params, a finite seed, a resolvable script. Null (and a log line) otherwise.
 */
export function resolveSpec(spec: unknown, options: Pick<FxSystemOptions, 'resolveScript'>, log: (message: string) => void): ResolvedSpec | null {
  if (!isObject(spec) || typeof spec.script !== 'string' || spec.script.length === 0) {
    log('an fx spec needs a non-empty script string');
    return null;
  }
  const params = isObject(spec.params) ? spec.params : {};
  if (spec.params !== undefined && !isObject(spec.params)) {
    log('fx params must be an object');
    return null;
  }
  if (spec.seed !== undefined && (typeof spec.seed !== 'number' || !Number.isFinite(spec.seed))) {
    log('fx seed must be a finite number');
    return null;
  }
  const seed = typeof spec.seed === 'number' ? spec.seed : undefined;
  let source: string;
  if (isProgramSource(spec.script)) source = spec.script;
  else {
    source = options.resolveScript?.(spec.script) ?? '';
    if (source === '') {
      log(`fx script '${spec.script}' could not be resolved`);
      return null;
    }
  }
  return { script: spec.script, source, params, seed };
}

/** what an effect's origin follows (DESIGN §3: the program's `follow` header, read from the cached parse) */
export function targetOf(source: string, node: Object3D | null, camera: Object3D | null): FxTarget {
  return fxFollowOf(source) === 'camera' ? (camera !== null ? 2 : 0) : node !== null ? 1 : 0;
}

/** what the in-process runtime keeps per effect besides its simulation */
interface Record_ extends FxLightOwner {
  readonly owner: string | null;
}

const scratchPosition = new Vector3();

/**
 * Render §13: row-bound and act-emitted FX, batched into three instanced render paths and grid-light data, on the main thread.
 * The fx world (world/fx-world.ts) simulates and fills, the presenter (fx-presenter.ts) holds the three buckets; this is the
 * runtime the fx Worker falls back to (`?fx=inline`, or a worker that cannot start) and its byte oracle (DR-53/DR-54).
 */
export class FxRuntime implements FxRuntimeApi {
  readonly #options: FxSystemOptions;
  readonly #presenter: FxPresenter;
  readonly #world: FxWorld;
  readonly #records = new Map<number, Record_>();
  #frames = 0;
  #disposed = false;

  constructor(options: FxSystemOptions) {
    this.#options = options;
    const cap = Math.max(1, options.budget.cap('particles', FX_MAX_PARTICLES));
    const distortEnabled = tierConfig(options.budget.tier).distort;
    this.#presenter = new FxPresenter({
      world: options.world,
      ...(options.camera === undefined ? {} : { camera: options.camera }),
      ...(options.distortScene === undefined ? {} : { distortScene: options.distortScene }),
      distortEnabled,
      atlas: options.atlas,
      capacity: cap,
      additiveFog: options.additiveFog ?? calibration.additiveFog,
      ...(options.alignedCards === undefined ? {} : { alignedCards: options.alignedCards }),
      ...(options.lightsOnly === undefined ? {} : { lightsOnly: options.lightsOnly }),
      ...(options.lighting === undefined ? {} : { lighting: options.lighting }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    this.#world = new FxWorld(
      {
        capacity: cap,
        distortEnabled,
        hasCamera: options.camera !== undefined && options.camera !== null,
        maxEffects: options.maxEffects ?? 128,
        strict: options.strict ?? false,
        ...(options.heldFollow === undefined ? {} : { heldFollow: options.heldFollow }),
        ...(options.rangeRolls === undefined ? {} : { rangeRolls: options.rangeRolls }),
        ...(options.alignedCards === undefined ? {} : { alignedCards: options.alignedCards }),
        ...(options.lightsOnly === undefined ? {} : { lightsOnly: options.lightsOnly }),
        ...(options.gravity === undefined ? {} : { gravity: options.gravity }),
        ...(options.wind === undefined ? {} : { wind: options.wind }),
      },
      {
        ...(options.floorHeight === undefined ? {} : { floorHeight: options.floorHeight }),
        log: (line) => (this.#options.log ?? console.warn)(line),
        onRemove: (effect) => this.#removed(effect),
      },
    );
  }

  get sprites(): FxSpriteBuckets { return this.#presenter.sprites; }
  get stretched(): FxStretchedBuckets { return this.#presenter.stretched; }
  get effectCount(): number { return this.#world.effectCount; }
  get particleCount(): number { return this.#world.particleCount; }
  get simulations(): readonly FxSimulation[] { return [...this.#world.effects()].map((effect) => effect.sim); }

  /** true while the runtime still tracks the effect; finished one-shots are removed by `update` */
  has(id: FxEffectId): boolean { return this.#world.has(id); }

  bind(rowId: string, spec: unknown, node: Object3D): FxBinding | null {
    if (this.#disposed) return null;
    let id = this.#start(spec, node, rowId);
    if (id === null) return null;
    return {
      restart: (next) => {
        if (id !== null) this.#world.remove(id);
        id = this.#start(next, node, rowId);
      },
      end: () => {
        if (id !== null) this.#world.remove(id);
        id = null;
      },
    };
  }

  /** Start an unbound effect; `origin` is in world space. Returns null for an invalid or refused effect. */
  emit(spec: unknown, origin: Vec3 = [0, 0, 0]): FxEffectId | null {
    return this.#start(spec, null, null, origin);
  }

  /** Stop and remove an act-emitted effect immediately. */
  end(id: FxEffectId): void { this.#world.remove(id); }

  /**
   * Stand-ins for every sprite and stretched bucket an effect can fill, for the shader warm-up to compile before the first
   * effect is seen (render §7.2; `FxSpriteBuckets.warmProxies`). Mesh sinks are primitive buckets: their programs are the
   * bucket set's (models/shader-variants.ts `bucketProgramVariants`).
   */
  warmObjects(): Object3D[] {
    if (this.#disposed) return [];
    return this.#presenter.warmObjects();
  }

  /**
   * F3: the distort sprites' programs in the distort pass. That pass draws into its own RG target, so only it links them:
   * this puts zero-offset stand-ins (sprite and stretched quad, per space) in the distort scene for the warm-up's closing
   * render of the pipeline, and `done()` takes them out (as `ShockwaveRenderer.armDistortWarm`). Nothing happens while the
   * tier has no distort pass, there is no distort scene, or the runtime is disposed. True in `armed` when it armed.
   */
  armDistortWarm(): { armed: boolean; done(): void } {
    const none = { armed: false, done: () => undefined };
    if (this.#disposed || !tierConfig(this.#options.budget.tier).distort) return none;
    const target = this.#options.distortScene;
    const scene = typeof target === 'function' ? target() : target ?? null;
    if (scene === null) return none;
    return this.#presenter.armDistortWarm(scene);
  }

  /** Advance once in the render loop's `fx` stage, with presentation time and shared tier budgets. */
  update(frame: Pick<FrameInfo, 'dt' | 'now'>): void {
    if (this.#disposed) return;
    this.#frames++;
    const now = frame.now / 1000;
    this.#world.step(frame.dt, now, Math.max(0, this.#options.budget.cap('particles', FX_MAX_PARTICLES)), this.#originOf);
    this.#presenter.fillInline(this.#world.sims(), calibration.fxMeshRoughness);
    this.#updateLights(now);
  }

  stats(): FxRuntimeStats {
    return {
      mode: 'inline',
      effects: this.#world.effectCount,
      particles: this.#world.particleCount,
      meshParticles: this.#presenter.meshes.instances,
      frames: this.#frames,
      presented: this.#frames,
      late: 0,
      merged: 0,
      stepMs: { last: 0, p50: 0, p95: 0, max: 0 },
      fallback: null,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#world.clear();
    this.#presenter.dispose();
  }

  #start(spec: unknown, node: Object3D | null, owner: string | null, initialOrigin?: Vec3): FxEffectId | null {
    if (this.#disposed) return null;
    const resolved = resolveSpec(spec, this.#options, (m) => this.#log(m));
    if (resolved === null) return null;
    const camera = this.#options.camera ?? null;
    const target = targetOf(resolved.source, node, camera);
    const object = target === 2 ? camera : target === 1 ? node : null;
    if (object) object.getWorldPosition(scratchPosition);
    else scratchPosition.set(...(initialOrigin ?? [0, 0, 0]));
    const manual: Vec3 = initialOrigin === undefined ? [0, 0, 0] : [initialOrigin[0], initialOrigin[1], initialOrigin[2]];
    const effect = this.#world.spawn({
      ticket: 0,
      owner,
      script: resolved.script,
      source: resolved.source,
      params: resolved.params,
      seed: resolved.seed,
      origin: [scratchPosition.x, scratchPosition.y, scratchPosition.z],
      manual,
      target,
      tier: fxTier(this.#options),
      heldFactor: tierConfig(this.#options.budget.tier).fxHeldFactor * heldScaleOf(this.#options.heldScale),
      cap: this.#options.budget.cap('particles', FX_MAX_PARTICLES),
    });
    if (effect === null) return null;
    this.#records.set(effect.id, { node, owner, handles: new Map(), lit: new Set() });
    return effect.id as FxEffectId;
  }

  /** `FxRuntime#origin`: the target's world position now, or the manual origin */
  readonly #originOf = (effect: FxWorldEffect): Vec3 => {
    const target = effect.target === 2 ? this.#options.camera ?? null : effect.target === 1 ? this.#records.get(effect.id)?.node ?? null : null;
    if (target) {
      target.getWorldPosition(scratchPosition);
      return [scratchPosition.x, scratchPosition.y, scratchPosition.z];
    }
    return [effect.manual[0], effect.manual[1], effect.manual[2]];
  };

  #updateLights(now: number): void {
    const lights = this.#options.lights;
    if (!lights) return;
    const budget = this.#options.budget.cap('fxLights', Number.POSITIVE_INFINITY);
    for (const effect of this.#world.effects()) this.#records.get(effect.id)!.lit.clear();
    const staticOwner = this.#options.staticOwner;
    this.#world.lights(now, budget, (effect, pop, index, held, name, color, intensity, radius, x, y, z) => {
      fxLight(lights, this.#records.get(effect.id)!, `${pop}:${index}`, held, () => `fx:${effect.owner ?? effect.id}:${name}`, color, intensity, radius, { x, y, z }, staticOwner);
    });
    // a handle lives while its particle is selected; the selected keys are keys of live particles, so this is the old
    // "not live, or not selected" test
    for (const effect of this.#world.effects()) fxLightsDropUnlit(lights, this.#records.get(effect.id)!);
  }

  /** an effect left the world: its light handles go (`FxRuntime#remove`) */
  #removed(effect: FxWorldEffect): void {
    const record = this.#records.get(effect.id);
    if (record === undefined) return;
    fxLightsRemoveAll(this.#options.lights, record);
    this.#records.delete(effect.id);
  }

  #log(message: string): void { (this.#options.log ?? console.warn)(`[fx] ${message}`); }
}

export function createFxSystem(options: FxSystemOptions): FxRuntime { return new FxRuntime(options); }
