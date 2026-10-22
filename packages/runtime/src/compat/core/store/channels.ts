// Property channels (docs/design/core-runtime.md §5.3, §5.6; docs/architecture.md X-13; motion §3.5.2, §13 #1).
//
// Every ObjectProperties field is stored generically in the row; a domain registers a channel on a field to react to writes and,
// optionally, to serve the field's reads. One registry per row store (RowStoreImpl.channels); the app registers the domains'
// channels at compose time (the motion mixer's `anim`, `mixer`, `ik`; physics; audio; the look stack). The store calls
// `willWrite` before it changes a field and `wrote` after every write, effective or equal, and delivers:
//
//   sync                 onWrite runs at once, inside the writer's stack (the channel must not call game code). Only for
//                        X-13's `anim` / `mixer` / `ik`; with `everyWrite` it hears equal writes too: a repeated `once` write
//                        restarts the viewmodel clip (authored module), the mixer decides restart vs keep.
//   everyWrite, deferred every write is queued (value copied at write time) until the owner flushes the field.
//   deferred (default)   one notification per row and field until the owner's flush, in first-write order: `value` is the
//                        field's value at the flush, `prev` its value before the first write, `path` the written path when
//                        there was one write and [] otherwise. An equal write is free.
//
// The owner flushes its fields in the phase where it consumes them (physics in step E, audio per frame; core §5.6): `flush(
// ['physics', 'forces', 'scale'])`. A row destroyed before the flush is dropped. Values handed to a channel are copies (the
// store keeps editing its own objects in place); channels of one write share them, so treat them as read-only. A channel that
// throws is counted and reported; the write stands.
import type { PathSegment, PropChannel, RowRec } from '../types.ts';
import { cloneWire } from '../wire.ts';

interface Entry {
  readonly row: RowRec;
  readonly field: string;
  readonly prev: unknown;
  path: PathSegment[];
  writes: number;
}
interface EveryItem {
  readonly ch: PropChannel;
  readonly row: RowRec;
  readonly value: unknown;
  readonly prev: unknown;
  readonly path: readonly PathSegment[];
}

const NONE: readonly PropChannel[] = Object.freeze([]);
const isDeduped = (ch: PropChannel): boolean => ch.sync !== true && ch.everyWrite !== true && ch.onWrite !== undefined;
const snapshot = (v: unknown): unknown => (v !== null && typeof v === 'object' ? cloneWire(v) : v);

export class ChannelRegistry {
  readonly #byField = new Map<string, readonly PropChannel[]>();
  /** the field's current value at a flush (RowStoreImpl.readField) */
  readonly #readField: (row: RowRec, field: string) => unknown;
  #entries: Entry[] = [];
  readonly #entryOf = new Map<RowRec, Map<string, Entry>>();
  #every: EveryItem[] = [];
  /** onWrite calls that threw */
  errors = 0;

  constructor(readField: (row: RowRec, field: string) => unknown) {
    this.#readField = readField;
  }

  /** registers a channel; returns an idempotent unregister. At most one channel per field may serve reads. */
  register(ch: PropChannel): () => void {
    if (typeof ch.field !== 'string' || ch.field === '') throw new TypeError('registerChannel: a channel names its field');
    const list = this.#byField.get(ch.field) ?? NONE;
    if (ch.read && list.some((c) => c.read !== undefined)) {
      throw new Error(`registerChannel: one channel may serve reads of ${ch.field}`);
    }
    this.#byField.set(ch.field, [...list, ch]);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const next = (this.#byField.get(ch.field) ?? NONE).filter((c) => c !== ch);
      if (next.length > 0) this.#byField.set(ch.field, next);
      else this.#byField.delete(ch.field);
      this.#every = this.#every.filter((it) => it.ch !== ch);
      if (!next.some(isDeduped)) this.#drop((e) => e.field === ch.field);
    };
  }

  channels(field: string): readonly PropChannel[] {
    return this.#byField.get(field) ?? NONE;
  }

  /** the channel serving derived reads of a field, if one is registered */
  reader(field: string): PropChannel | undefined {
    const list = this.#byField.get(field);
    return list === undefined ? undefined : list.find((c) => c.read !== undefined);
  }

  /** a registered channel asks for every write of the field: the store must not drop equal writes */
  hasEveryWrite(field: string): boolean {
    const list = this.#byField.get(field);
    return list !== undefined && list.some((c) => c.everyWrite === true);
  }

  /** queued notifications: deduplicated (row, field) entries plus queued every-writes */
  get pending(): number {
    return this.#entries.length + this.#every.length;
  }

  /** before the store changes `field` of `row`: opens the row's deferred entry and keeps the value before its first write */
  willWrite(row: RowRec, field: string): void {
    const list = this.#byField.get(field);
    if (list === undefined || !list.some(isDeduped)) return;
    let per = this.#entryOf.get(row);
    if (per?.has(field)) return;
    if (!per) {
      per = new Map();
      this.#entryOf.set(row, per);
    }
    const e: Entry = { row, field, prev: snapshot(this.#readField(row, field)), path: [], writes: 0 };
    per.set(field, e);
    this.#entries.push(e);
  }

  /** after a write: `effective` false is an equal write, heard by everyWrite channels only */
  wrote(row: RowRec, field: string, path: readonly PathSegment[], value: unknown, prev: unknown, effective: boolean): void {
    const list = this.#byField.get(field);
    if (list === undefined) return;
    // channels get copies: the store keeps editing its own objects in place (a later `ik.rightArm = null` lands in the `ik` map)
    let copies: { value: unknown; prev: unknown } | null = null;
    for (const ch of list) {
      if (!effective && ch.everyWrite !== true) continue;
      if (ch.sync !== true && ch.everyWrite !== true) continue;
      copies ??= { value: snapshot(value), prev: snapshot(prev) };
      if (ch.sync === true) this.#call(ch, row, copies.value, copies.prev, path);
      else this.#every.push({ ch, row, value: copies.value, prev: copies.prev, path: path.slice() });
    }
    if (!effective) return;
    const e = this.#entryOf.get(row)?.get(field);
    if (e) {
      e.writes++;
      e.path = e.writes === 1 ? path.slice() : [];
    }
  }

  /** delivers the queued notifications of `fields` (all fields when omitted); returns how many were delivered */
  flush(fields?: Iterable<string>): number {
    const only = fields === undefined ? null : new Set(fields);
    let delivered = 0;
    if (this.#every.length > 0) {
      const batch = this.#every;
      this.#every = [];
      const keep: EveryItem[] = [];
      for (const it of batch) {
        if (only !== null && !only.has(it.ch.field)) keep.push(it);
        else if (it.row.phase === 'alive') {
          this.#call(it.ch, it.row, it.value, it.prev, it.path);
          delivered++;
        }
      }
      this.#every = keep.concat(this.#every);
    }
    if (this.#entries.length > 0) {
      const batch = this.#entries;
      this.#entries = [];
      const keep: Entry[] = [];
      for (const e of batch) {
        if (only !== null && !only.has(e.field)) {
          keep.push(e);
          continue;
        }
        this.#forget(e);
        if (e.row.phase !== 'alive') continue;
        const value = snapshot(this.#readField(e.row, e.field));
        for (const ch of this.#byField.get(e.field) ?? NONE) if (isDeduped(ch)) this.#call(ch, e.row, value, e.prev, e.path);
        delivered++;
      }
      this.#entries = keep.concat(this.#entries);
    }
    return delivered;
  }

  /** drops everything queued for a row (the store detached it) */
  discard(row: RowRec): void {
    if (this.#every.some((it) => it.row === row)) this.#every = this.#every.filter((it) => it.row !== row);
    if (this.#entryOf.has(row)) this.#drop((e) => e.row === row);
  }

  #drop(match: (e: Entry) => boolean): void {
    const keep: Entry[] = [];
    for (const e of this.#entries) {
      if (match(e)) this.#forget(e);
      else keep.push(e);
    }
    this.#entries = keep;
  }

  #forget(e: Entry): void {
    const per = this.#entryOf.get(e.row);
    if (!per) return;
    if (per.get(e.field) === e) per.delete(e.field);
    if (per.size === 0) this.#entryOf.delete(e.row);
  }

  #call(ch: PropChannel, row: RowRec, value: unknown, prev: unknown, path: readonly PathSegment[]): void {
    try {
      ch.onWrite?.(row, value, prev, path);
    } catch (err) {
      this.errors++;
      console.error(`[channels] the ${ch.field} channel threw on ${row.id}`, err);
    }
  }
}

/** registers `ch` on a store's channel registry (core §5.6 `registerChannel`) */
export function registerChannel(store: { readonly channels: ChannelRegistry }, ch: PropChannel): () => void {
  return store.channels.register(ch);
}
