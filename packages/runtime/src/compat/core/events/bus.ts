// The event bus: queued custom events and their routing (docs/design/core-runtime.md §8.1-8.5, D-CORE-08; contract §6.2-6.3;
// mp §11.2).
//
// `ctx.emit(name, payload, opts)`: an engine act (rules.ts ACT_NAMES) goes to the ActRouter at once and returns its id; any
// other name is queued with a wire copy of the payload and delivered FIFO at the next phase boundary (the scheduler drains
// after every tick step B-G, core §9.3). Events emitted by handlers during a drain join the same queue and are delivered in
// the same drain; past DRAIN_CAP the rest waits for the next boundary with a warning, so an emit loop cannot hang a frame.
// Every receiver gets its own copy (a receiver's mutation never leaks; Spawn deserialises per machine). Routing, core §8.4:
//
//   { to: id } (audience ignored)       the listeners of row `id`, wherever it stands; dropped (counted) when it is gone
//   audience all / 'all'                every row listener of every resident place (and of place-less rows), both VMs, and
//                                       every sim
//   no to, no audience (opts.place?)    row listeners in opts.place ?? the source place; sims per
//                                       ENGINE_RULES.defaultEmitReachesSims: 'samePlace' = that place's sim, plus the root
//                                       sim when that place is world.defaultPlace; 'all' = every sim; 'none' = no sim
//   audience place {kind:'place',       row listeners in that place (default: opts.place ?? the source place) + that
//     placeId?} / {place}               place's sim
//   audience nearby {kind:'nearby',     row listeners in opts.place ?? the source place whose row's world feet are within
//     position, radius?} / {nearby}     radius (3D; no radius: the whole place); no sims
//   audience player {kind:'player',     when id is the human's player or body id: the listeners of the client VM (the VM
//     id} / {player}                    that simulates the human's body); else nobody (bots are not players)
//   a malformed audience                nobody, with a warning; `via` is ignored with a warning (no cross-world portals)
//   ctx.on(…, { place })                additionally requires the event's place (as resolved above) to equal it
//
// meta = { name, sourceId, placeId: sourcePlace, to? }: sourceId is the emitting ctx's row (a body behavior → player/local; a
// kit's k.ctx → its enemy), null for sims, which the Director's validation treats as trusted. Handlers run through the hook
// invoker with their owner's ctx; a handler on a row whose onSpawn has not run yet still runs.
import { ENGINE, isActName, type EngineRules } from '../rules.ts';
import { cloneWire } from '../wire.ts';
import type { CallerRef, EventBus, EventMeta, KernelMetrics, NormalisedAudience, PlaceId, RowId, RowRec, Vec3, VmId } from '../types.ts';
import { ctxOf, type HookInvoker } from '../behaviors/invoke.ts';
import { normalizeEmitOptions, sourceOf, type ActRouterImpl, type HumanView } from './acts.ts';
import type { Listener, ListenerRegistry } from './listeners.ts';

export interface QueuedEvent {
  /** global FIFO order */
  readonly seq: number;
  readonly name: string;
  /** cloneWire(payload) at emit time */
  readonly payload: unknown;
  readonly to: RowId | null;
  readonly audience: NormalisedAudience | null;
  readonly invalidAudience: boolean;
  /** the place the event is routed in (and that ctx.on {place} filters compare with) */
  readonly place: PlaceId | null;
  readonly sourceId: RowId | null;
  readonly sourcePlace: PlaceId | null;
  readonly sourceVm: VmId;
  readonly tick: number;
}

export interface BusEnv {
  readonly metrics: KernelMetrics;
  readonly listeners: ListenerRegistry;
  readonly acts: ActRouterImpl;
  readonly invoker: HookInvoker;
  rules(): Readonly<Pick<EngineRules, 'defaultEmitReachesSims'>>;
  /** world.defaultPlace: where the root sim stands */
  defaultPlace(): PlaceId | null;
  tick(): number;
  /** the human, for the player audience */
  human(): HumanView | null;
  /** a row's world feet, for the nearby audience */
  feetOf(row: RowRec): Vec3 | null;
  /** whether a place stands (active, dormant or loading); rows of other places never hear */
  isResident(place: PlaceId): boolean;
  /** whether a row id is alive: true / false, or null when unknown (no store) */
  rowExists(id: RowId): boolean | null;
  warn(message: string): void;
  /** opt-in (ext.achievements): called with `stat` and its payload at emit */
  tap?: ((type: string, payload: unknown) => void) | undefined;
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export class EventBusImpl implements EventBus {
  readonly #env: BusEnv;
  /** the queue: events[head..] are pending */
  #queue: QueuedEvent[] = [];
  #head = 0;
  #seq = 0;
  readonly #warned = new Set<string>();
  #capWarnAt = Number.NEGATIVE_INFINITY;

  constructor(env: BusEnv) {
    this.#env = env;
  }

  get pending(): number {
    return this.#queue.length - this.#head;
  }

  /** ctx.emit: an act is routed now and returns its id; a custom event is queued (undefined) */
  emit(caller: CallerRef, name: string, payload: unknown, opts?: unknown): string | undefined {
    if (typeof name !== 'string' || name.length === 0) throw new TypeError(`emit: the event name must be a non-empty string, got ${String(name)}`);
    if (isActName(name) || this.#env.acts.knows(name)) return this.#env.acts.emit(caller, name, payload, opts);
    if (name === 'stat') this.#env.tap?.(name, payload);
    const o = normalizeEmitOptions(opts);
    if (o.via !== null) this.#warnOnce(`via:${name}`, `emit(${JSON.stringify(name)}): \`via\` (cross-world portals) is not ported; ignored`);
    if (o.invalidAudience) this.#warnOnce(`audience:${name}`, `emit(${JSON.stringify(name)}): the audience matches no spelling of contract §6.2; nobody hears it`);
    const src = sourceOf(caller, this.#env.defaultPlace());
    const placed = o.place ?? src.sourcePlace;
    const place = o.to === null && o.audience?.kind === 'place' ? (o.audience.placeId ?? placed) : placed;
    this.#queue.push({
      seq: ++this.#seq,
      name,
      payload: cloneWire(payload),
      to: o.to,
      audience: o.audience,
      invalidAudience: o.invalidAudience,
      place,
      sourceId: src.sourceId,
      sourcePlace: src.sourcePlace,
      sourceVm: src.sourceVm,
      tick: this.#env.tick(),
    });
    return undefined;
  }

  /** delivers queued events FIFO until the queue is empty or `max` events were delivered; returns how many */
  drain(max: number = ENGINE.DRAIN_CAP): number {
    let n = 0;
    while (this.#head < this.#queue.length && n < max) {
      const ev = this.#queue[this.#head]!;
      this.#queue[this.#head] = undefined as unknown as QueuedEvent;
      this.#head++;
      n++;
      this.#env.metrics.eventsDelivered++;
      this.#deliver(ev);
    }
    if (this.#head >= this.#queue.length) {
      this.#queue = [];
      this.#head = 0;
    } else if (this.#head > 1024 && this.#head * 2 > this.#queue.length) {
      this.#queue = this.#queue.slice(this.#head);
      this.#head = 0;
    }
    if (n >= max && this.pending > 0) {
      this.#env.metrics.drainCapHits++;
      const now = Date.now();
      if (now - this.#capWarnAt >= ENGINE.LOG_REPEAT_MS) {
        this.#capWarnAt = now;
        this.#env.warn(`[bus] ${n} events in one drain: ${this.pending} wait for the next phase boundary (an emit loop?)`);
      }
    }
    return n;
  }

  #deliver(ev: QueuedEvent): void {
    if (ev.to !== null && this.#env.rowExists(ev.to) === false) {
      this.#env.metrics.eventsUndelivered++;
      return;
    }
    const receivers = this.#receivers(ev);
    const last = receivers.length - 1;
    for (let i = 0; i <= last; i++) {
      const l = receivers[i]!;
      if (!l.active) continue; // unsubscribed by an earlier handler of this event
      if (l.owner.kind === 'row' && l.owner.row.phase !== 'alive') continue;
      if (l.once) this.#env.listeners.remove(l);
      const meta: EventMeta = { name: ev.name, sourceId: ev.sourceId, placeId: ev.sourcePlace };
      if (ev.to !== null) meta.to = ev.to;
      // the queued copy goes to the last receiver; every other one gets a fresh copy of it
      const payload = i === last ? ev.payload : cloneWire(ev.payload);
      this.#env.invoker.call(l.owner, `${l.declared ? 'ears' : 'on'}.${ev.name}`, l.handler, [ctxOf(l.owner), payload, meta]);
    }
  }

  /** core §8.4: who hears `ev`, in registration order */
  #receivers(ev: QueuedEvent): Listener[] {
    if (ev.invalidAudience) return [];
    const env = this.#env;
    const placeOk = (l: Listener): boolean => l.placeFilter === null || l.placeFilter === ev.place;
    if (ev.to !== null) {
      // a targeted event (ss:hit, ss:hurt, press: the hot path) looks at the target row's own listeners only
      const to = ev.to;
      return env.listeners.ofRow(to).filter((l) => l.name === ev.name && l.owner.kind === 'row' && l.owner.row.id === to && placeOk(l));
    }
    const all = env.listeners.forName(ev.name);
    if (all.length === 0) return [];
    const residentRow = (l: Listener): boolean => l.owner.kind === 'row' && (l.owner.row.place === null || env.isResident(l.owner.row.place));
    const rowIn = (l: Listener, place: PlaceId | null): boolean => l.owner.kind === 'row' && l.owner.row.place === place && residentRow(l);
    const simOf = (l: Listener, place: PlaceId | null): boolean => l.owner.kind === 'sim' && l.owner.sim.place === place && place !== null;
    const defaultPlace = env.defaultPlace();
    const rootSimIn = (l: Listener, place: PlaceId | null): boolean =>
      l.owner.kind === 'sim' && l.owner.sim.place === null && place !== null && place === defaultPlace;
    const a = ev.audience;
    let keep: (l: Listener) => boolean;
    if (a === null) {
      const reach = env.rules().defaultEmitReachesSims;
      keep = (l) => {
        if (l.owner.kind === 'row') return rowIn(l, ev.place);
        if (reach === 'all') return true;
        if (reach === 'none') return false;
        return simOf(l, ev.place) || rootSimIn(l, ev.place);
      };
    } else if (a.kind === 'all') {
      keep = (l) => l.owner.kind === 'sim' || residentRow(l);
    } else if (a.kind === 'place') {
      keep = (l) => rowIn(l, ev.place) || simOf(l, ev.place);
    } else if (a.kind === 'nearby') {
      const { position, radius } = a;
      keep = (l) => {
        if (!rowIn(l, ev.place)) return false;
        if (radius === null || l.owner.kind !== 'row') return true;
        const feet = env.feetOf(l.owner.row);
        return feet !== null && dist(feet, position) <= radius;
      };
    } else {
      const human = env.human();
      const isHuman = human !== null && (a.id === human.playerId || a.id === human.bodyId);
      keep = (l) => isHuman && l.owner.kind === 'row' && l.vm === 'client' && residentRow(l);
    }
    const out: Listener[] = [];
    for (const l of all) if (keep(l) && placeOk(l)) out.push(l);
    return out;
  }

  #warnOnce(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#env.warn(message);
  }
}
