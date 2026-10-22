// The `anim` and `mixer` handle properties (docs/architecture.md X-13, §4.1 steps D and H; docs/design/core-runtime.md §5.6;
// motion §3.5.5, §3.11, §13 #1): two property channels registered with core's row store, one Mixer per row behind them.
//
//   write   `everyWrite` + `sync`: every assignment reaches the row's mixer at once, inside the writer's stack, equal to the
//           stored value or not (a repeated `once` write restarts the viewmodel clip; the store's equal-write dedupe would
//           freeze it). The mixer decides restart / hold / keep (mixer.ts). The handlers only record mixer state: they never
//           call game code.
//             anim.<ch> = {…} | null        one channel (path [ch])
//             anim = {…} | null             a whole bag (path []): the keys it has are written, channels it leaves out are
//                                           cleared [INF: unused live; `mixer` is only ever set by a spawn spec]
//           What arrives is the store's wire copy of the assignment (JSON semantics, core §5.3): `clip` is a string. A clip
//           object or a clip function plays through `builtin/anim.play`, which registers it and writes its identity string;
//           a function assigned straight to a channel is dropped by the wire copy, so that write names no clip and is ignored
//           (`anim.sit = { clip: sit }` of the seat branch, scripts/humanoid-locomotion.js:169: unreachable live, no seats).
//   read    `anim.<ch>` and `mixer.<ch>` are fresh snapshots of the one channel table ("mixer and anim read one table",
//           scripts/humanoid-locomotion.js:160): mutating one writes nothing (AGENTS.md:139).
//   spawn   a row spawned with `mixer: {ch: {clip, …, startTick}}` (corpses, X-20) or `anim: {…}` gets its channels at spawn.
//   tick    `port.advanceTick(dt)` (MotionPort, step H) advances every mixer of a simulated place.
//
// A mixer is made at a row's first channel write, spawn-time spec or `ensure(row)` (render, when the model loads: `setRig`),
// and released when the row is disposed. It is keyed by row id and tied to the row record, so a row that reuses the id of a
// destroyed one never inherits its mixer, whichever of `rowSpawned` and the old row's `rowDestroyed` comes first.
//
// Wiring (app compose): `createAnimChannels({ registry })`, pass `.port` as the kernel's motion port, then `.install(kernel)`.
import type { MotionPort } from '../core/ports.ts';
import type { Kernel, PathSegment, PropChannel, PropChannelRegistry, RowRec } from '../core/types.ts';
import { bakeClipFunction } from './clip-function.ts';
import type { ClipRegistry } from './clip-registry.ts';
import { type ChannelWrite, type ClipBinder, Mixer, type MixerOptions } from './mixer.ts';
import type { PoseRig } from './pose.ts';

/** the mixers by row, for the presentation pass, the bone attachments and the corpse baker */
export interface MixerHost {
  get(rowId: string): Mixer | undefined;
  forEach(fn: (mixer: Mixer, row: RowRec) => void): void;
  readonly size: number;
}

export interface AnimChannelsOptions {
  /** where clip references resolve; its clip-function baker is set to `bakeClipFunction` */
  registry: ClipRegistry;
  /** the sim clock (write ticks, `elapsed`); `install(kernel)` sets the kernel's. Without one the host counts its own ticks. */
  clock?: { readonly tick: number };
  /** clip → rig binder for every mixer (`retarget.ts` supplies the retargeting one); default: by bone name */
  bind?: ClipBinder;
  /** whether the rows of a place tick at step H (motion §3.11: the simulated place); default: every place */
  isSimulated?: (place: string | null) => boolean;
  /** makes each row's mixer (standalone addition: procedural rigs pass `render/rig` createRigMixer); default `new Mixer` */
  createMixer?: (rowId: string, opts: MixerOptions) => Mixer;
}

type Field = 'anim' | 'mixer';
/** spawn-time order: the `mixer` spec first, an `anim` bag over it */
const FIELDS: readonly Field[] = ['mixer', 'anim'];

interface Entry {
  readonly row: RowRec;
  readonly mixer: Mixer;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasChannels = (row: RowRec): boolean => isObj(row.props['mixer']) || isObj(row.props['anim']);

export class AnimChannels implements MixerHost {
  readonly registry: ClipRegistry;
  /** the `anim` property channel */
  readonly anim: PropChannel;
  /** the `mixer` property channel */
  readonly mixer: PropChannel;
  /** tick step H */
  readonly port: MotionPort;
  readonly #rows = new Map<string, Entry>();
  readonly #bind: ClipBinder | undefined;
  readonly #isSimulated: ((place: string | null) => boolean) | undefined;
  readonly #createMixer: ((rowId: string, opts: MixerOptions) => Mixer) | undefined;
  #clock: { readonly tick: number } | null;
  /** ticks advanced, when there is no clock */
  #ticks = 0;
  /** what every mixer reads `elapsed` from */
  readonly #mixerClock: { readonly tick: number };

  constructor(opts: AnimChannelsOptions) {
    this.registry = opts.registry;
    this.registry.setFunctionBaker(bakeClipFunction);
    this.#bind = opts.bind;
    this.#isSimulated = opts.isSimulated;
    this.#createMixer = opts.createMixer;
    this.#clock = opts.clock ?? null;
    const now = (): number => this.#tick();
    this.#mixerClock = {
      get tick(): number {
        return now();
      },
    };
    const channel = (field: Field): PropChannel => ({
      field,
      everyWrite: true,
      sync: true,
      onWrite: (row, value, _prev, path) => this.#onWrite(field, row, value, path),
      read: (row) => this.#read(row),
    });
    this.anim = channel('anim');
    this.mixer = channel('mixer');
    this.port = { advanceTick: (dtS) => this.advanceTick(dtS) };
  }

  /** registers both channels on a row store's channel registry; returns an idempotent unregister */
  register(channels: PropChannelRegistry): () => void {
    const offAnim = channels.register(this.anim);
    const offMixer = channels.register(this.mixer);
    return () => {
      offAnim();
      offMixer();
    };
  }

  /**
   * The whole wiring on a kernel: the two channels on its store, its clock, and its row notices (spawn-time specs, disposal).
   * The kernel must have been created with `port` as its motion port. Returns an uninstall.
   */
  install(kernel: Pick<Kernel, 'store' | 'clock' | 'on'>): () => void {
    this.#clock = kernel.clock;
    const offChannels = this.register(kernel.store.channels);
    const offSpawn = kernel.on('rowSpawned', (row) => this.rowSpawned(row));
    const offDestroy = kernel.on('rowDestroyed', (row) => this.rowDestroyed(row));
    return () => {
      offChannels();
      offSpawn();
      offDestroy();
    };
  }

  // ── MixerHost ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  get(rowId: string): Mixer | undefined {
    return this.#rows.get(rowId)?.mixer;
  }

  forEach(fn: (mixer: Mixer, row: RowRec) => void): void {
    for (const e of this.#rows.values()) fn(e.mixer, e.row);
  }

  get size(): number {
    return this.#rows.size;
  }

  /** the row's mixer, made now if it has none (with the channels the row already stores) */
  ensure(row: RowRec): Mixer {
    return this.#entry(row).mixer;
  }

  /** the row's model is known: bind its channels to the rig (render / `three-skin.ts`, also on a model swap) */
  setRig(row: RowRec, rig: PoseRig): void {
    this.ensure(row).setRig(rig);
  }

  /** the registry got a new clip source (library catalogue, model clips, an anim file): waiting channels resolve again */
  rebindAll(): void {
    for (const e of this.#rows.values()) e.mixer.rebind();
  }

  // ── row notices (KernelEvents) ─────────────────────────────────────────────────────────────────────────────────────────

  /** a row exists: one spawned with a `mixer` or `anim` spec gets its channels now (motion §3.5.2 last row) */
  rowSpawned(row: RowRec): void {
    if (row.phase === 'alive' && hasChannels(row)) this.#entry(row);
  }

  /** a row was disposed: its mixer is released and forgotten (a FrozenPose kept for a baked corpse goes with it) */
  rowDestroyed(row: RowRec): void {
    const e = this.#rows.get(row.id);
    if (!e || e.row !== row) return;
    e.mixer.release();
    this.#rows.delete(row.id);
  }

  /** tick step H (MotionPort): clocks and ramps of every mixer of a simulated place */
  advanceTick(dtS: number): void {
    const sim = this.#isSimulated;
    for (const e of this.#rows.values()) {
      if (sim === undefined || sim(e.row.place)) e.mixer.advanceTick(dtS);
    }
    this.#ticks++;
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  #tick(): number {
    return this.#clock ? this.#clock.tick : this.#ticks;
  }

  /**
   * The row's entry. A new mixer adopts the channels the row stores (a spawn spec, or writes made before the channels were
   * registered), except what the write being delivered covers: the store holds that value already and the handler applies it
   * itself (`skipField` with `skipKey` = one channel of that field, with `skipKey` null = the whole field).
   */
  #entry(row: RowRec, skipField?: Field, skipKey?: string | null): Entry {
    const known = this.#rows.get(row.id);
    if (known !== undefined) {
      if (known.row === row) return known;
      known.mixer.release(); // the id belongs to a newer row
    }
    const mopts: MixerOptions = { registry: this.registry, clock: this.#mixerClock, ...(this.#bind ? { bind: this.#bind } : {}) };
    const mixer = this.#createMixer ? this.#createMixer(row.id, mopts) : new Mixer(row.id, null, mopts);
    const e: Entry = { row, mixer };
    this.#rows.set(row.id, e);
    const tick = this.#tick();
    for (const field of FIELDS) {
      const bag = row.props[field];
      if (!isObj(bag)) continue;
      if (field === skipField && skipKey === null) continue;
      for (const ch of Object.keys(bag)) {
        if (field === skipField && ch === skipKey) continue;
        mixer.write(ch, bag[ch] as ChannelWrite | null, tick);
      }
    }
    return e;
  }

  #onWrite(field: Field, row: RowRec, value: unknown, path: readonly PathSegment[]): void {
    if (row.phase !== 'alive') return;
    const tick = this.#tick();
    if (path.length === 0) {
      const mixer = this.#entry(row, field, null).mixer;
      const bag = isObj(value) ? value : null;
      for (const ch of mixer.channelNames()) if (bag === null || !Object.hasOwn(bag, ch)) mixer.write(ch, null, tick);
      if (bag !== null) for (const ch of Object.keys(bag)) mixer.write(ch, bag[ch] as ChannelWrite | null, tick);
      return;
    }
    const ch = String(path[0]);
    const mixer = this.#entry(row, field, ch).mixer;
    // a write below a channel (`anim.walk.speed = …` through a kept reference) delivers the channel as the row stores it now
    const stored = path.length === 1 ? value : isObj(row.props[field]) ? (row.props[field] as Record<string, unknown>)[ch] : undefined;
    mixer.write(ch, stored as ChannelWrite | null | undefined, tick);
  }

  #read(row: RowRec): Record<string, unknown> {
    const e = this.#rows.get(row.id);
    if (e !== undefined && e.row === row) return e.mixer.table();
    // a living row that stores channels nobody announced: adopt them; anything else has no table
    if (row.phase === 'alive' && hasChannels(row) && e === undefined) return this.#entry(row).mixer.table();
    return {};
  }
}

export function createAnimChannels(opts: AnimChannelsOptions): AnimChannels {
  return new AnimChannels(opts);
}
