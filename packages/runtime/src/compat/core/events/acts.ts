// Engine acts: ids, the visibility filter and the routing table (docs/design/core-runtime.md §8.6, §15.6; docs/architecture.md
// X-12; contract §6.4; io §2.3-2.5).
//
// An act (`playSound`, `fx`, `decal`, … rules.ts ACT_NAMES) never enters the event queue: inside ctx.emit the kernel mints its
// id (`snd-<n>` for playSound, `fx-<n>` for fx), applies the one visibility filter `presentable()` (io's audience table, moved
// here), and hands the envelope synchronously to the one handler its owning domain registered on `kernel.acts` (audio:
// playSound, stopSound; render: fx, decal, shockwave, shake; camera juice: screenShake, cameraPunch, hitstop; UI chrome:
// screenFlash; UI host: damageNumber, uiEvent; physics: impulse). The id goes back to the game EVERY time: also when the act
// was filtered, refused or has no handler (`scripts/audio/sfx.js:69-73` stores any string). `slowMo` is ignored and counted
// (DR-17). `ctx.destroy('fx-12')` and `ctx.destroy('snd-3')` end an act through the end handler of its prefix; an fx emitted
// with `attachTo` ends when that row goes (engine api:1566). "That row" is the record holding the id when the fx is emitted, not
// the id: ids are free at once after destroy while disposal waits for the boundary, so a new row can take the id before the old
// record's disposal ends its fx, and that disposal must not end the new row's.
//
// Option normalisation lives here too: the bus routes custom events with the same audience spellings (core §8.4).
import { ACT_NAMES, isActName, isExtraActName } from '../rules.ts';
import { ACT_ID_PREFIX, actId, actIdPrefixOf, type ActIdPrefix } from '../ids.ts';
import { cloneWire } from '../wire.ts';
import type { ActEnvelope, ActRouter } from '../ports.ts';
import type { ActName, CallerRef, ExtraActName, KernelMetrics, NormalisedAudience, PlaceId, RowId, RowRec, Vec3, VmId } from '../types.ts';

export { ACT_NAMES, isActName };
export type { ActName };

// ── emit options (contract §6.1-6.2: every spelling the live game uses) ─────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isVec3 = (v: unknown): v is Vec3 =>
  isObject(v) && Number.isFinite(v['x']) && Number.isFinite(v['y']) && Number.isFinite(v['z']);
const isName = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** an absent radius (undefined or null) is null; anything else must be a finite number */
function radiusOf(r: unknown): number | null | 'invalid' {
  if (r === undefined || r === null) return null;
  return typeof r === 'number' && Number.isFinite(r) ? r : 'invalid';
}

/**
 * An audience in its `{kind}` form: null when absent, 'invalid' when it matches none of the spellings
 * (`'all'`, `{kind:'all'}`, `{kind:'player', id}`, `{player}`, `{kind:'nearby', position, radius?}`, `{nearby, radius?}`,
 * `{kind:'place', placeId?}`, `{place}`).
 */
export function normalizeAudience(a: unknown): NormalisedAudience | null | 'invalid' {
  if (a === undefined || a === null) return null;
  if (a === 'all') return { kind: 'all' };
  if (!isObject(a)) return 'invalid';
  if ('kind' in a) {
    switch (a['kind']) {
      case 'all':
        return { kind: 'all' };
      case 'player':
        return isName(a['id']) ? { kind: 'player', id: a['id'] } : 'invalid';
      case 'nearby': {
        const radius = radiusOf(a['radius']);
        return isVec3(a['position']) && radius !== 'invalid' ? { kind: 'nearby', position: { x: a['position'].x, y: a['position'].y, z: a['position'].z }, radius } : 'invalid';
      }
      case 'place': {
        const p = a['placeId'];
        if (p === undefined || p === null) return { kind: 'place', placeId: null };
        return isName(p) ? { kind: 'place', placeId: p } : 'invalid';
      }
      default:
        return 'invalid';
    }
  }
  if ('player' in a) return isName(a['player']) ? { kind: 'player', id: a['player'] } : 'invalid';
  if ('nearby' in a) {
    const radius = radiusOf(a['radius']);
    return isVec3(a['nearby']) && radius !== 'invalid' ? { kind: 'nearby', position: { x: a['nearby'].x, y: a['nearby'].y, z: a['nearby'].z }, radius } : 'invalid';
  }
  if ('place' in a) return isName(a['place']) ? { kind: 'place', placeId: a['place'] } : 'invalid';
  return 'invalid';
}

export interface NormalisedEmitOptions {
  readonly to: RowId | null;
  readonly place: PlaceId | null;
  readonly audience: NormalisedAudience | null;
  /** cross-world portals: ignored with a warning (contract §6.2) */
  readonly via: string | null;
  /** the audience matched no spelling: an act is dropped, a custom event reaches nobody */
  readonly invalidAudience: boolean;
}

/** ctx.emit options; anything that is not an object is no options */
export function normalizeEmitOptions(opts: unknown): NormalisedEmitOptions {
  if (!isObject(opts)) return { to: null, place: null, via: null, audience: null, invalidAudience: false };
  const audience = normalizeAudience(opts['audience']);
  return {
    to: isName(opts['to']) ? opts['to'] : null,
    place: isName(opts['place']) ? opts['place'] : null,
    via: isName(opts['via']) ? opts['via'] : null,
    audience: audience === 'invalid' ? null : audience,
    invalidAudience: audience === 'invalid',
  };
}

export interface EmitSource {
  /** the emitting row (meta.sourceId); null for sims, the scene loader and the kernel */
  readonly sourceId: RowId | null;
  /** the row's place; a place sim's place; the root sim stands in the default place (core §7.3, §8.4) */
  readonly sourcePlace: PlaceId | null;
  readonly sourceVm: VmId;
}

/** who emits: the ctx's owner, never "whoever runs now" (a kit's `k.ctx` emits as its enemy, core §8.4) */
export function sourceOf(caller: CallerRef, defaultPlace: PlaceId | null): EmitSource {
  switch (caller.kind) {
    case 'row':
      return { sourceId: caller.row.id, sourcePlace: caller.row.place, sourceVm: caller.row.vm };
    case 'sim':
      return { sourceId: null, sourcePlace: caller.sim.place ?? defaultPlace, sourceVm: 'platform' };
    case 'scene':
      return { sourceId: null, sourcePlace: caller.place, sourceVm: 'platform' };
    default:
      return { sourceId: null, sourcePlace: null, sourceVm: 'platform' };
  }
}

// ── the visibility filter (X-12; core §8.6; io §2.5) ───────────────────────────────────────────────────────────────────

/** the one human, as the filter (and the bus's player audience) needs it */
export interface HumanView {
  /** PlayerRec.userId */
  readonly playerId: string | null;
  /** `player/local` */
  readonly bodyId: RowId | null;
  readonly place: PlaceId | null;
  /** world feet */
  readonly feet: Vec3 | null;
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * Whether an act is presented to the human. The act's place (`opts.place ?? sourcePlace`) must be the human's (a place-less
 * act passes); then by audience: absent or all pass; place: the human is in it (no placeId: the source place); nearby: the
 * human's feet within radius of the position, 3D (no radius: the act's place already matched); player: the id is the human's
 * player id or body id (`authored module` passes ctx.self.id). No human: nothing is presented.
 */
export function presentable(
  act: { readonly sourcePlace: PlaceId | null; readonly place: PlaceId | null; readonly audience: NormalisedAudience | null },
  human: HumanView | null,
): boolean {
  if (!human) return false;
  const place = act.place ?? act.sourcePlace;
  if (place !== null && place !== human.place) return false;
  const a = act.audience;
  if (a === null) return true;
  switch (a.kind) {
    case 'all':
      return true;
    case 'place':
      return human.place === (a.placeId ?? act.sourcePlace);
    case 'nearby':
      if (a.radius === null) return true;
      return human.feet !== null && dist(human.feet, a.position) <= a.radius;
    case 'player':
      return a.id === human.playerId || a.id === human.bodyId;
    default:
      return false;
  }
}

// ── the router ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ActEnv {
  readonly metrics: KernelMetrics;
  /** the human (store: `player/local`), null before it exists */
  human(): HumanView | null;
  /** world.defaultPlace: the root sim's place */
  defaultPlace(): PlaceId | null;
  warn?: ((message: string) => void) | undefined;
  /** opt-in (ext.achievements): called with `milestone` and its payload once the act passed the visibility filter */
  tap?: ((type: string, payload: unknown) => void) | undefined;
  /** opt-in (ext.slowMo): applies a `slowMo` payload to the scheduler once the act passed the visibility filter */
  slowMo?: ((payload: unknown) => void) | undefined;
  /** opt-in (ext.extraActs): the extra acts that route as engine acts */
  extraActs?: ReadonlySet<ExtraActName> | undefined;
  /** where a throwing handler is reported; default console.error */
  report?: ((message: string, error: unknown) => void) | undefined;
}

type Handler = (a: ActEnvelope) => void;
type EndHandler = (actId: string) => void;
interface Reg<T> {
  readonly fn: T;
}

/** fx ids remembered per attachTo record; older ones are forgotten (ending an fx that already ended is a no-op anyway) */
const ATTACHED_MAX = 256;

export class ActRouterImpl implements ActRouter {
  readonly #env: ActEnv;
  readonly #handlers = new Map<ActName, Reg<Handler>>();
  readonly #ends = new Map<ActIdPrefix, Reg<EndHandler>>();
  readonly #counters: Record<ActIdPrefix, number> = { 'snd-': 0, 'fx-': 0 };
  /** attached fx per row RECORD (not id: an id can be reused before the old record is disposed) */
  readonly #attached = new Map<RowRec, Set<string>>();
  /** the record that holds each id now: set when it spawns, dropped at its disposal unless a new record took the id */
  readonly #holders = new Map<RowId, RowRec>();
  readonly #warned = new Set<string>();

  constructor(env: ActEnv) {
    this.#env = env;
  }

  /** one handler per act name; a second registration replaces the first and is counted (docs/architecture.md §11) */
  register(name: ActName, handler: (a: ActEnvelope) => void): () => void {
    if (!this.knows(name)) throw new TypeError(`acts.register: ${String(name)} is not an engine act`);
    if (typeof handler !== 'function') throw new TypeError(`acts.register(${name}): the handler must be a function`);
    if (this.#handlers.has(name)) this.#double(`act ${name}`);
    const reg: Reg<Handler> = { fn: handler };
    this.#handlers.set(name, reg);
    return () => {
      if (this.#handlers.get(name) === reg) this.#handlers.delete(name);
    };
  }

  /** the end of an act by id: ctx.destroy('fx-…') / ctx.destroy('snd-…'), and fx whose attachTo row went */
  registerEnd(prefix: 'snd-' | 'fx-', handler: (actId: string) => void): () => void {
    if (prefix !== 'snd-' && prefix !== 'fx-') throw new TypeError(`acts.registerEnd: ${String(prefix)} is not an act id prefix`);
    if (typeof handler !== 'function') throw new TypeError(`acts.registerEnd(${prefix}): the handler must be a function`);
    if (this.#ends.has(prefix)) this.#double(`end ${prefix}`);
    const reg: Reg<EndHandler> = { fn: handler };
    this.#ends.set(prefix, reg);
    return () => {
      if (this.#ends.get(prefix) === reg) this.#ends.delete(prefix);
    };
  }

  /** whether the name is an engine act here: the base runtime's list, or an extra act enabled by ext.extraActs */
  knows(name: unknown): name is ActName {
    return isActName(name) || (isExtraActName(name) && this.#env.extraActs?.has(name) === true);
  }

  /** whether a handler is registered for the act */
  handles(name: ActName): boolean {
    return this.#handlers.has(name);
  }

  /**
   * An act emitted by `caller` (the bus sends every act name here, synchronously, inside ctx.emit). Returns the act id for
   * playSound / fx, minted whether or not the act is presented or handled; undefined for every other act.
   */
  emit(caller: CallerRef, name: ActName, payload: unknown, opts: unknown): string | undefined {
    if (name === 'slowMo' && !this.#env.slowMo) {
      this.#env.metrics.slowMoIgnored++;
      return undefined;
    }
    // the sim clock is global: ext.slowMo applies it whether or not the visibility filter would present the act to the human
    if (name === 'slowMo') this.#env.slowMo?.(payload);
    const prefix = ACT_ID_PREFIX[name];
    const id = prefix ? actId(prefix, ++this.#counters[prefix]) : null;
    const o = normalizeEmitOptions(opts);
    const src = sourceOf(caller, this.#env.defaultPlace());
    if (o.invalidAudience || !presentable({ sourcePlace: src.sourcePlace, place: o.place, audience: o.audience }, this.#env.human())) {
      this.#env.metrics.actsFiltered++;
      return id ?? undefined;
    }
    if (name === 'milestone') this.#env.tap?.(name, payload);
    const reg = this.#handlers.get(name);
    if (!reg) {
      this.#env.metrics.actsUnhandled++;
      return id ?? undefined;
    }
    const envelope: ActEnvelope = {
      name,
      payload: cloneWire(payload),
      id,
      sourceId: src.sourceId,
      sourcePlace: src.sourcePlace,
      audience: o.audience,
      place: o.place,
    };
    try {
      reg.fn(envelope);
    } catch (err) {
      // a handler is port code: its failure is reported here and never blamed on the game hook that emitted
      (this.#env.report ?? ((m, e) => console.error(m, e)))(`[acts] the ${name} handler threw`, err);
    }
    if (name === 'fx' && id !== null && isObject(payload) && isName(payload['attachTo'])) {
      const row = this.#attachTarget(caller, payload['attachTo']);
      if (row) this.#attach(row, id);
    }
    return id ?? undefined;
  }

  /** ends an act by id through its prefix's end handler; false for anything that is not an act id or has no end handler */
  end(id: string): boolean {
    const prefix = actIdPrefixOf(id);
    if (!prefix) return false;
    const reg = this.#ends.get(prefix);
    if (!reg) return false;
    for (const set of this.#attached.values()) set.delete(id);
    try {
      reg.fn(id);
    } catch (err) {
      (this.#env.report ?? ((m, e) => console.error(m, e)))(`[acts] the ${prefix} end handler threw`, err);
    }
    return true;
  }

  /** a row record exists (spawn): it holds its id until its disposal or until a new record takes the id */
  rowSpawned(row: RowRec): void {
    this.#holders.set(row.id, row);
  }

  /** the row record went (disposal): every fx attached to THIS record ends; a new record that reuses the id keeps its own */
  rowGone(row: RowRec): void {
    if (this.#holders.get(row.id) === row) this.#holders.delete(row.id);
    const set = this.#attached.get(row);
    if (!set) return;
    this.#attached.delete(row);
    for (const id of set) this.end(id);
  }

  /**
   * The record an fx's `attachTo` names: the emitting row itself when it names its own id (also from its onDestroy, after a new
   * row may already have taken the id), else the record holding the id now (alive, or destroyed and awaiting disposal). An id no
   * record holds attaches to nothing: no later row that takes the id may end the fx.
   */
  #attachTarget(caller: CallerRef, rowId: RowId): RowRec | null {
    if (caller.kind === 'row' && caller.row.id === rowId) return caller.row.phase === 'disposed' ? null : caller.row;
    return this.#holders.get(rowId) ?? null;
  }

  #attach(row: RowRec, id: string): void {
    let set = this.#attached.get(row);
    if (!set) {
      set = new Set();
      this.#attached.set(row, set);
    }
    set.add(id);
    if (set.size > ATTACHED_MAX) set.delete(set.values().next().value!);
  }

  #double(what: string): void {
    this.#env.metrics.actsDoubleRegistered++;
    if (this.#warned.has(what)) return;
    this.#warned.add(what);
    (this.#env.warn ?? ((m) => console.warn(m)))(`[acts] a second handler for ${what} replaces the first (one handler per act, X-12)`);
  }
}
