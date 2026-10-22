// The row feed: the render domain's view of row lifecycle and writes (docs/design/core-runtime.md §15.2; docs/architecture.md
// X-14, §3.0 RowFeed / RowSnapshot, §4.2 frame step 4).
//
// Producers: the kernel adds a row when its record exists (KernelEvents.rowSpawned), removes it at disposal
// (KernelEvents.rowDestroyed), and the store reports every effective write's top-level field (`changed`, in write order; C1a's
// writeProp). The renderer drains once per frame: per row, in the order its first event arrived since the last drain,
// `added` (a row the sink has not seen; its snapshot carries the current values, so changes made before the drain fold into
// it), `changed` with the fields written since the last drain (each once, write order), or `removed` (a row the sink saw).
// A row added and removed between two drains never reaches the sink. Until the renderer exists (before game_ready, X-04) the
// feed just accumulates, so its first drain delivers every live row as `added`.
import type { RowFeed, RowSnapshot } from '../ports.ts';
import type { ObjectSpec, PlaceId, Quat, RowId, RowRec, TreePath, Vec3 } from '../types.ts';

/** a read-only view of a RowRec (no copies): every getter reads the record now */
class RowView implements RowSnapshot {
  readonly #row: RowRec;
  #paths: readonly TreePath[] | null = null;
  #pathsOf: RowRec['behaviors'] | null = null;
  #pathsLen = -1;

  constructor(row: RowRec) {
    this.#row = row;
  }
  get id(): RowId {
    return this.#row.id;
  }
  get place(): PlaceId | null {
    return this.#row.place;
  }
  get parentId(): RowId | null {
    return this.#row.parentId;
  }
  get tags(): readonly string[] {
    return this.#row.tags;
  }
  get behavior(): readonly TreePath[] {
    const b = this.#row.behaviors;
    if (this.#paths === null || this.#pathsOf !== b || this.#pathsLen !== b.length) {
      this.#paths = Object.freeze(b.map((i) => i.path));
      this.#pathsOf = b;
      this.#pathsLen = b.length;
    }
    return this.#paths;
  }
  get spec(): Readonly<ObjectSpec> {
    return this.#row.spec;
  }
  get props(): Readonly<Record<string, unknown>> {
    return this.#row.props;
  }
  get prev(): { pos: Vec3; rot: Quat } {
    return { pos: this.#row.tf.prevPos, rot: this.#row.tf.prevRot };
  }
  get cur(): { pos: Vec3; rot: Quat; scale: Vec3 } {
    return { pos: this.#row.tf.pos, rot: this.#row.tf.rot, scale: this.#row.tf.scale };
  }
}

const views = new WeakMap<RowRec, RowView>();

/** the one snapshot view of a record */
export function rowSnapshot(row: RowRec): RowSnapshot {
  let v = views.get(row);
  if (!v) {
    v = new RowView(row);
    views.set(row, v);
  }
  return v;
}

interface Entry {
  kind: 'added' | 'changed' | 'removed';
  /** top-level fields, write order, unique */
  fields: string[];
}

export type FeedSink = Parameters<RowFeed['drain']>[0];

export class RowFeedImpl implements RowFeed {
  /** per record, in the order its first event arrived since the last drain */
  #pending = new Map<RowRec, Entry>();
  /** records the sink has been given as added and not yet as removed */
  readonly #seen = new WeakSet<RowRec>();
  readonly #report: (message: string, error: unknown) => void;

  constructor(opts: { report?: (message: string, error: unknown) => void } = {}) {
    this.#report = opts.report ?? ((m, e) => console.error(m, e));
  }

  /** rows with something to deliver */
  get pending(): number {
    return this.#pending.size;
  }

  /** the record exists (spawn) */
  added(row: RowRec): void {
    if (this.#seen.has(row)) return;
    const e = this.#pending.get(row);
    if (e) e.kind = 'added';
    else this.#pending.set(row, { kind: 'added', fields: [] });
  }

  /** an effective write of `field` (top level: 'state', 'light', 'feetPosition', …) */
  changed(row: RowRec, field: string): void {
    if (row.phase !== 'alive') return;
    const e = this.#pending.get(row);
    if (e) {
      if (e.kind === 'changed' && !e.fields.includes(field)) e.fields.push(field);
      return; // added: the snapshot carries it; removed: nothing to change
    }
    // a row the sink never saw arrives as added
    this.#pending.set(row, this.#seen.has(row) ? { kind: 'changed', fields: [field] } : { kind: 'added', fields: [] });
  }

  /** the row is gone (disposal) */
  removed(row: RowRec): void {
    const e = this.#pending.get(row);
    if (!this.#seen.has(row)) {
      if (e) this.#pending.delete(row); // added and removed between two drains: the sink never hears of it
      return;
    }
    if (e) {
      e.kind = 'removed';
      e.fields = [];
    } else this.#pending.set(row, { kind: 'removed', fields: [] });
  }

  drain(sink: FeedSink): void {
    const batch = this.#pending;
    this.#pending = new Map();
    // ids are free at once after destroy while disposal (removed) waits for the boundary, so a new record can be added under
    // an id before the old record's removal arrives. The sink removes by id: such a removal goes first, or it would drop the
    // new row.
    const addedIds = new Set<RowId>();
    for (const [row, e] of batch) if (e.kind === 'added') addedIds.add(row.id);
    const order: [RowRec, Entry][] = [];
    if (addedIds.size) {
      for (const pair of batch) if (pair[1].kind === 'removed' && addedIds.has(pair[0].id)) order.push(pair);
      for (const pair of batch) if (!(pair[1].kind === 'removed' && addedIds.has(pair[0].id))) order.push(pair);
    }
    for (const [row, e] of addedIds.size ? order : batch) {
      try {
        if (e.kind === 'added') {
          this.#seen.add(row);
          sink.added(rowSnapshot(row));
        } else if (e.kind === 'changed') {
          sink.changed(rowSnapshot(row), e.fields);
        } else {
          this.#seen.delete(row);
          sink.removed(row.id);
        }
      } catch (err) {
        this.#report(`[feed] the sink threw on ${e.kind} ${row.id}`, err);
      }
    }
  }
}
