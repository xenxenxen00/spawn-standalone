// The listener registry: declared `ears` and `ctx.on` handlers (docs/design/core-runtime.md §8.1-8.2, §8.5).
//
// A row's listeners are its behaviors' declared ears (bound for the row's life, registered by behaviors/bind.ts) plus every
// `ctx.on` made from its behaviors' hooks; they are removed when the row is disposed (removeRow). They follow the row across
// places: routing reads the owner row's place at delivery. A sim's listeners live as long as the kernel. The kernel never
// deduplicates (gore's `ctx.on('ss:hurt')` and vitals' declared `ss:hurt` ear both hear one event, mp §11.2); `ctx.on`
// returns an unsubscribe that really removes the handler and is idempotent (the Director re-arms every 10 s,
// `authored module`). Delivery order is registration order.
import type { EarHandler, PlaceId, RowId, RowRec, VmId } from '../types.ts';
import type { HookOwner } from '../behaviors/invoke.ts';

export type ListenerOwner = HookOwner;

export interface Listener {
  readonly id: number;
  readonly name: string;
  readonly owner: ListenerOwner;
  readonly handler: EarHandler;
  /** from `ears`: bound for the row's life */
  readonly declared: boolean;
  /** removed before its one run */
  readonly once: boolean;
  /** ctx.on(…, { place }): also requires the event's resolved place to equal this */
  readonly placeFilter: PlaceId | null;
  /** the owner's VM; sims are on the platform VM */
  readonly vm: VmId;
  /** false once removed */
  readonly active: boolean;
}

interface Slot extends Listener {
  active: boolean;
}

export interface ListenOptions {
  declared?: boolean | undefined;
  once?: boolean | undefined;
  place?: PlaceId | undefined;
}

export class ListenerRegistry {
  #ids = 0;
  /** per event name, registration order */
  readonly #byName = new Map<string, Set<Slot>>();
  /** per owner row id */
  readonly #byRow = new Map<RowId, Set<Slot>>();
  #size = 0;

  get size(): number {
    return this.#size;
  }

  /** registers a listener; throws a TypeError for a nameless event or a handler that is not a function */
  add(owner: ListenerOwner, name: string, handler: EarHandler, opts: ListenOptions = {}): Listener {
    if (typeof name !== 'string' || name.length === 0) throw new TypeError(`on: the event name must be a non-empty string, got ${String(name)}`);
    if (typeof handler !== 'function') throw new TypeError(`on(${JSON.stringify(name)}): the handler must be a function`);
    const place = typeof opts.place === 'string' && opts.place.length > 0 ? opts.place : null;
    const slot: Slot = {
      id: ++this.#ids,
      name,
      owner,
      handler,
      declared: opts.declared === true,
      once: opts.once === true,
      placeFilter: place,
      vm: owner.kind === 'row' ? owner.row.vm : 'platform',
      active: true,
    };
    let set = this.#byName.get(name);
    if (!set) {
      set = new Set();
      this.#byName.set(name, set);
    }
    set.add(slot);
    if (owner.kind === 'row') {
      let rs = this.#byRow.get(owner.row.id);
      if (!rs) {
        rs = new Set();
        this.#byRow.set(owner.row.id, rs);
      }
      rs.add(slot);
    }
    this.#size++;
    return slot;
  }

  /** ctx.on: registers a hand-armed listener and returns its unsubscribe (idempotent) */
  on(owner: ListenerOwner, name: string, handler: EarHandler, opts: { place?: PlaceId | undefined; once?: boolean | undefined } = {}): () => void {
    const l = this.add(owner, name, handler, { once: opts?.once, place: opts?.place });
    return () => {
      this.remove(l);
    };
  }

  /** removes one listener; false when it was already gone */
  remove(l: Listener): boolean {
    const slot = l as Slot;
    if (!slot.active) return false;
    slot.active = false;
    const set = this.#byName.get(slot.name);
    if (set) {
      set.delete(slot);
      if (set.size === 0) this.#byName.delete(slot.name);
    }
    if (slot.owner.kind === 'row') {
      const rs = this.#byRow.get(slot.owner.row.id);
      // the id may since name another row: only this record's listeners are removed
      if (rs) {
        rs.delete(slot);
        if (rs.size === 0) this.#byRow.delete(slot.owner.row.id);
      }
    }
    this.#size--;
    return true;
  }

  /** the listeners of an event name, registration order (a snapshot) */
  forName(name: string): readonly Listener[] {
    const set = this.#byName.get(name);
    return set ? [...set] : [];
  }

  /** the listeners a row owns (declared first by bind order, then ctx.on), a snapshot */
  ofRow(rowId: RowId): readonly Listener[] {
    const rs = this.#byRow.get(rowId);
    return rs ? [...rs] : [];
  }

  /** drops every listener of this row record (its disposal); returns how many */
  removeRow(row: RowRec): number {
    let n = 0;
    for (const l of this.ofRow(row.id)) if (l.owner.kind === 'row' && l.owner.row === row && this.remove(l)) n++;
    return n;
  }
}
