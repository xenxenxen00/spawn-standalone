import { createSimCtx } from '../ctx/sim.ts';
import type { CtxLogOptions } from '../ctx/common.ts';
import type { KernelIds } from '../ids.ts';
import { createKernel, type CoreKernel, type KernelOptions } from '../kernel.ts';
import { spawnRow } from '../lifecycle.ts';
import { asSimModule } from '../modules/registry.ts';
import { extOf, prepareExtensions, simEveryTicks, type KernelExtensions } from '../ext.ts';
import { createNullAssetFactsPort } from '../null-ports.ts';
import type { KernelPorts, HostPlatform } from '../ports.ts';
import type { GeneratorModule } from '../../../render/geometry/generator-types.ts';
import { ENGINE, type EngineRules } from '../rules.ts';
import { DurableState, installFlushHooks } from '../save/durable.ts';
import { expandSpec, isPlain } from '../spec/template.ts';
import { LayeredValueImpl } from '../store/layers.ts';
import type { CompiledPlaceIndex, Kernel, ModuleRegistry, PlaceId, RowRec, SimInstance, TreePath, Vec3, WorldConfig } from '../types.ts';
import { cloneWire } from '../wire.ts';
import { resolveProfile, type LocalProfile, type ProfileOptions } from './profile.ts';

/** Root simulation module convention. */
export const ROOT_SIM_PATH: TreePath = 'sim.js';
/** boot reports loading progress up to this; 100 is the app shell's, at the first menu frame (core §14 step 14) */
export const BOOT_PROGRESS_MAX = 95;

export type BootStep = 'sets' | 'kernel' | 'preroll' | 'place' | 'spawn' | 'warmup';

export interface BootLog {
  log(message: string): void;
  warn(message: string): void;
  error(message: string, detail?: unknown): void;
}

/** what the kernel is made of besides its ports */
export interface BootWorld {
  registry: ModuleRegistry;
  /** The compiled world config; checked by asWorldConfig */
  worldConfig: unknown;
  places: CompiledPlaceIndex;
  /** The carried file list */
  files?: readonly TreePath[] | undefined;
}

export interface BootEnv {
  worldId?: string | null | undefined;
  ids?: Partial<KernelIds> | undefined;
  preloadSets?: readonly string[] | undefined;
  homePlace?: ((kernel: CoreKernel, sim: SimInstance | null) => PlaceId | null) | undefined;
  readHome?: ((kernel: CoreKernel) => PlaceId | null) | undefined;
  fallbackPlace?: PlaceId | undefined;
  residentPlaces?: KernelOptions['residentPlaces'];
  preroll?: { ticks: number; maxRounds: number; waitsMs?: readonly number[]; until?: (kernel: CoreKernel) => boolean } | undefined;
  platform: HostPlatform;
  /** not used by the kernel boot (see the header) */
  canvas: HTMLCanvasElement | null;
  /** no page: no document hooks */
  headless?: boolean | undefined;
  seed?: number | undefined;
  /** the caller's ports (X1's compose); missing ones are null ports */
  ports?: Partial<KernelPorts> | undefined;
  /** The host supplies compiled content and registry inputs. */
  world: BootWorld;
  /** default: a new DurableState over `platform.save` */
  durable?: DurableState | undefined;
  /** Host identity policy; the defaults are an unprefixed account id and Player. */
  profile?: Pick<ProfileOptions, 'idPrefix' | 'defaultName'> | undefined;
  seedInitialBodyState?: ((state: Record<string, unknown>) => Record<string, unknown>) | undefined;
  /** step 3: the kernel exists, paused, nothing has ticked */
  onKernel?: ((kernel: CoreKernel) => void | Promise<void>) | undefined;
  /** step 12: body and rig exist, `boot` is still set */
  beforeWarmup?: ((kernel: CoreKernel) => void | Promise<void>) | undefined;
  /** 0..1 over the whole boot */
  onProgress?: ((fraction: number, step: BootStep) => void) | undefined;
  log?: BootLog | undefined;
  /** `ctx.log / warn / error` (KernelOptions.log) */
  kernelLog?: CtxLogOptions | undefined;
  rules?: Partial<EngineRules> | undefined;
  /** @deprecated defaultPlace skips explicit home/preroll hooks; use hooks for custom startup. */
  start?: 'director' | 'defaultPlace' | undefined;
  /** @deprecated Include the actors set in preloadSets instead. 'auto' checks the animation index. */
  actors?: boolean | 'auto' | undefined;
  /**
   * Step 2, opt-in: a runtime collider producer behind `ports.assets.placeBake` (compat/physics/place-bake.ts). A place whose
   * supplied bake has no colliders gets them built from its scene rows (static or kinematic `collider: 'mesh'` scripted
   * primitives). `true` loads generators through the registry; `generator` overrides the loader; `mutableTags` marks tagged
   * rows mutable. Omitted = the supplied bake.
   */
  placeBake?: true | { generator?: ((script: string) => Promise<GeneratorModule>) | undefined; mutableTags?: readonly string[] | undefined; modules?: Readonly<Record<string, () => Promise<unknown>>> | undefined } | undefined;
  /** opt-in kernel extensions (core/ext.ts); omitted = the engine defaults */
  ext?: KernelExtensions | undefined;
  dev?: boolean | undefined;
  /** the device id minted on a first run (default crypto.randomUUID) */
  uuid?: (() => string) | undefined;
}

export interface BootResult {
  kernel: CoreKernel;
  durable: DurableState;
  profile: LocalProfile;
  /** the place the body stands in */
  home: PlaceId;
  /** The host readiness predicate was met or readHome returned a place. */
  rolled: boolean;
  /** Number of requested preroll rounds run. */
  prerollRounds: number;
  /** removes the save's flush hooks */
  dispose(): void;
}

const consoleLog: BootLog = {
  log: (m) => console.log(`[boot] ${m}`),
  warn: (m) => console.warn(`[boot] ${m}`),
  error: (m, d) => (d === undefined ? console.error(`[boot] ${m}`) : console.error(`[boot] ${m}`, d)),
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The compiled world config as the kernel's WorldConfig; throws, naming the field, when it cannot be one */
export function asWorldConfig(raw: unknown): WorldConfig {
  if (!isPlain(raw)) throw new TypeError('boot: the world config is not an object');
  const str = (k: string): string => {
    const v = raw[k];
    if (typeof v !== 'string' || v === '') throw new TypeError(`boot: world config "${k}" is ${v === undefined ? 'missing' : 'not a path'}`);
    return v;
  };
  str('defaultPlace');
  str('player');
  const camera = raw['camera'];
  if (!(typeof camera === 'string' && camera !== '') && !isPlain(camera)) throw new TypeError('boot: world config "camera" is neither a template ref nor a camera def');
  if (raw['inputs'] !== undefined && !isPlain(raw['inputs'])) throw new TypeError('boot: world config "inputs" is not an object');
  return (raw['inputs'] === undefined ? { ...raw, inputs: {} } : raw) as unknown as WorldConfig;
}

/** core §14 step 6 */
function mountRootSim(kernel: CoreKernel): SimInstance {
  const ns = kernel.registry.get(ROOT_SIM_PATH);
  if (ns === undefined) throw new Error(`boot: ${ROOT_SIM_PATH} is not loaded`);
  const any = extOf(kernel).simCadence === 'any';
  const sim: SimInstance = { id: 'sim', place: null, path: ROOT_SIM_PATH, module: asSimModule(ns, ROOT_SIM_PATH, { anyCadence: any }), ctx: null, health: new Map() };
  if (any) sim.everyTicks = simEveryTicks(sim.module);
  sim.ctx = createSimCtx(kernel, sim);
  kernel.time.setRootSim(sim);
  return sim;
}

function homeOf(kernel: CoreKernel, sim: SimInstance | null, env: BootEnv, log: BootLog): PlaceId {
  const candidates: unknown[] = [];
  if (env.homePlace) {
    try { candidates.push(env.homePlace(kernel, sim)); }
    catch (err) { log.error('the home-place hook threw', err); }
  }
  candidates.push(env.readHome?.(kernel), env.fallbackPlace, kernel.worldConfig.defaultPlace);
  for (const p of candidates) if (typeof p === 'string' && Object.hasOwn(kernel.placeIndex.placeIndex, p)) return p;
  throw new Error('boot: no start place exists in the roster');
}

/** core §14 step 11: `camera/local`, the rig row */
function spawnRig(kernel: CoreKernel, home: PlaceId, bodyId: string): RowRec {
  const cam = kernel.worldConfig.camera;
  const spec: Record<string, unknown> = typeof cam === 'string' ? { template: cam } : { ...cam };
  spec['place'] = home;
  // the rig's layer reads the camera def below the rig's own writes (core §7.4)
  const def = Object.freeze(cloneWire(expandSpec(spec, kernel.registry)) as Record<string, unknown>);
  const id = spawnRow(kernel, { kind: 'kernel' }, kernel.ids.cameraRig, spec, { vm: 'client', rig: { targetId: bodyId, layer: new LayeredValueImpl(() => def) } });
  const row = kernel.store.get(id);
  if (row === undefined || row.rig === null) throw new Error(`boot: ${kernel.ids.cameraRig} was not spawned as the rig (a row with that id already exists)`);
  return row;
}

/** env.actors: load the `actors` set at step 1 */
function wantsActors(registry: ModuleRegistry, opt: BootEnv['actors']): boolean {
  if (opt === undefined || opt === false) return false;
  const r = registry as ModuleRegistry & { setIds?(): string[]; animPaths?(): string[] };
  if (r.setIds && !r.setIds().includes('actors')) return false;
  return opt === true || (r.animPaths?.().length ?? 0) > 0;
}

export async function bootKernel(env: BootEnv): Promise<BootResult> {
  const log = env.log ?? consoleLog;
  const platform = env.platform;
  let reported = 0;
  const progress = (fraction: number, step: BootStep): void => {
    const f = Math.min(1, Math.max(reported, Number.isFinite(fraction) ? fraction : 0));
    reported = f;
    try {
      if (env.onProgress) env.onProgress(f, step);
      else platform.setLoadingProgress(Math.round(f * BOOT_PROGRESS_MAX));
    } catch (err) {
      log.error('a progress listener threw', err);
    }
  };

  const world = env.world;
  if (!world) throw new TypeError('boot: world inputs are required');
  const registry = world.registry;
  const worldConfig = asWorldConfig(world.worldConfig);
  const durable = env.durable ?? new DurableState(platform.save);

  const setNames = [...new Set([...(env.preloadSets ?? []), ...(wantsActors(registry, env.actors) ? ['actors'] : [])])];
  const part = new Map(setNames.map(name => [name, 0]));
  await Promise.all([
    Promise.resolve().then(() => platform.init()).catch((err: unknown) => log.error('platform.init() rejected; continuing', err)),
    ...setNames.map(name => registry.ensure(name, f => {
      part.set(name, f);
      progress(0.5 * [...part.values()].reduce((a, b) => a + b, 0) / setNames.length, 'sets');
    })),
  ]);
  if (setNames.length === 0) progress(0.5, 'sets');

  // 2-3: the kernel, paused with `boot`
  const ports: Partial<KernelPorts> = { ...(env.ports ?? {}), platform: env.ports?.platform ?? platform };
  if (env.placeBake !== undefined) {
    const { generatorColliders, generatorWithModuleIndex, rowsOfPlaceModule, withRuntimePlaceBake } = await import('../../physics/place-bake.ts'); // only a game that asks pays for the recorder
    const o = env.placeBake === true ? {} : env.placeBake;
    const fromRegistry = o.generator ?? (async (script: string) => (await registry.load(script)) as unknown as GeneratorModule);
    const load = o.modules === undefined ? fromRegistry : generatorWithModuleIndex(fromRegistry, o.modules);
    ports.assets = withRuntimePlaceBake(ports.assets ?? createNullAssetFactsPort(), {
      rows: async (p) => rowsOfPlaceModule(await world.places.places[p]?.()),
      colliderOf: generatorColliders(load),
      mutableTags: o.mutableTags,
    });
  }
  const kernel = createKernel({
    worldId: env.worldId,
    ids: env.ids,
    residentPlaces: env.residentPlaces,
    seed: env.seed ?? Date.now() >>> 0,
    ports,
    worldConfig,
    places: world.places,
    registry,
    files: world.files,
    log: env.kernelLog,
    rules: env.rules,
    ext: env.ext,
    dev: env.dev,
  });
  kernel.booting = true;
  await prepareExtensions(kernel, registry, (m, e) => log.error(m, e)); // ext.sql migrate, ext.jobs init: before the first tick
  if (env.onKernel) await env.onKernel(kernel);
  progress(0.52, 'kernel');

  // 4: the save (and who the player is, which reads its sidecar)
  await durable.load();
  const profile = await resolveProfile(platform, durable.settings, { ...(env.uuid ? { uuid: env.uuid } : {}), ...(env.profile?.idPrefix !== undefined ? { idPrefix: env.profile.idPrefix } : {}), ...(env.profile?.defaultName !== undefined ? { defaultName: env.profile.defaultName } : {}), log });

  // A root sim is optional; the host decides which modules must be loaded before boot.
  const sim = kernel.registry.get(ROOT_SIM_PATH) === undefined ? null : mountRootSim(kernel);
  const preroll = env.start === 'defaultPlace' ? undefined : env.preroll;
  if (preroll && (!Number.isInteger(preroll.ticks) || preroll.ticks < 0 || !Number.isInteger(preroll.maxRounds) || preroll.maxRounds < 0 || preroll.waitsMs?.some(ms => !Number.isFinite(ms) || ms < 0))) throw new TypeError('boot: invalid preroll options');
  let rounds = 0;
  while (preroll && rounds < preroll.maxRounds && !preroll.until?.(kernel)) {
    kernel.runTicks(preroll.ticks, { force: true });
    rounds++;
    if (preroll.until?.(kernel) || rounds >= preroll.maxRounds) break;
    const waits = preroll.waitsMs ?? [];
    await wait(waits[rounds - 1] ?? waits.at(-1) ?? 0);
  }
  const rolledHome = env.readHome?.(kernel);
  const rolled = preroll?.until?.(kernel) ?? (rolledHome !== null && rolledHome !== undefined);
  progress(0.56, 'preroll');
  const home = env.start === 'defaultPlace' ? kernel.worldConfig.defaultPlace : homeOf(kernel, sim, env, log);
  await kernel.places.load(home, (f) => progress(0.56 + 0.36 * f, 'place'));
  kernel.places.activate(home);

  // 10-11: the human and the rig
  const at: Vec3 = kernel.places.spawnPoint(home);
  // Seed before binding so equal template defaults do not create save writes.
  const seed = env.seedInitialBodyState;
  const bodyState = seed !== undefined ? seed(durable.initialBodyState()) : durable.initialBodyState();
  const bodyId = kernel.spawnHuman({ place: home, at, userId: profile.userId, displayName: profile.displayName, durableState: bodyState });
  const body = kernel.store.get(bodyId);
  if (body === undefined || body.player === null) throw new Error(`boot: ${bodyId} was not spawned as the human body`);
  durable.bindBody(body, kernel.store);
  spawnRig(kernel, home, bodyId);
  progress(0.94, 'spawn');

  // 12-13: the shell's hosts, then the hidden warm-up
  if (env.beforeWarmup) await env.beforeWarmup(kernel);
  kernel.clock.resume('boot');
  kernel.runTicks(ENGINE.BOOT_WARMUP_TICKS);

  // 14
  kernel.booting = false;
  const unhook = installFlushHooks(durable, env.headless === true ? { kernel, document: null, window: null } : { kernel });
  progress(1, 'warmup');
  return { kernel, durable, profile, home, rolled, prerollRounds: rounds, dispose: unhook };
}

/** core §14 */
export async function boot(env: BootEnv): Promise<Kernel> {
  return (await bootKernel(env)).kernel;
}
