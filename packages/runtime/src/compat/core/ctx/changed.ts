// `ctx.changed(glob): { path, value, prev }[]` (api-reference.md "The Changed Cursor (Sim.Js)"), as the opt-in
// `ext.changed` installs it.
//
// What it observes: the three state trees a sim reads: `world.state.…`, `place.state.…` and `place.players.<id>.state.…`
// (also `world.players.<id>.state.…`), read through the calling ctx's own handles. Paths are dot-joined; `*` matches one
// segment (a player id, a key); a glob names a leaf (the whole value at that path is reported, not its inner changes).
//
// The cursor is per (ctx, glob), i.e. per module: each call returns what moved since the previous call with the same glob
// from the same ctx, one row per path with the latest value and the value `prev` it replaced (a key written twice between two
// polls is reported once, with the final value). Writes by any realm are seen (a client behavior's `ctx.self.state.req = …`
// reaches the sim's next poll) and so are the sim's own. The first call of a glob only records the baseline and answers [],
// so state restored from a save is never reported as a change. A key that vanishes is reported with `value: undefined`.
// It never throws: a malformed glob or an unreadable tree answers [].
import { cloneWire, deepEqualWire } from '../wire.ts';

export interface ChangedRow {
  path: string;
  value: unknown;
  prev: unknown;
}

type Snapshot = Map<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** the children of a node for one glob segment: `[segment, child]` pairs */
function children(node: unknown, seg: string): Array<[string, unknown]> {
  if (!isObj(node)) return [];
  if (Array.isArray(node)) {
    // `players`: PlayerView[] keyed by id
    const rows = node as unknown as Array<{ id?: unknown }>;
    const keyed = rows.filter((r) => isObj(r) && typeof r.id === 'string');
    if (seg === '*') return keyed.map((r) => [r.id as string, r]);
    const hit = keyed.find((r) => r.id === seg);
    return hit ? [[seg, hit]] : [];
  }
  if (seg === '*') return Object.keys(node).map((k) => [k, node[k]]);
  let v: unknown;
  try {
    v = node[seg];
  } catch {
    return [];
  }
  return v === undefined && !(seg in node) ? [] : [[seg, v]];
}

/** every `[path, value]` the glob matches under the ctx right now */
function matches(ctx: object, glob: string): Array<[string, unknown]> {
  const segs = glob.split('.');
  if (segs.length < 2 || segs.some((s) => s === '')) return [];
  let level: Array<[string, unknown]> = [['', ctx]];
  for (const seg of segs) {
    const next: Array<[string, unknown]> = [];
    for (const [p, node] of level) for (const [k, child] of children(node, seg)) next.push([p === '' ? k : `${p}.${k}`, child]);
    level = next;
    if (level.length === 0) break;
  }
  return level;
}

export function createChangedCursor(ctx: object, report: (m: string) => void): (glob: string) => ChangedRow[] {
  const cursors = new Map<string, Snapshot>();
  return (glob) => {
    try {
      if (typeof glob !== 'string') return [];
      const now: Snapshot = new Map();
      for (const [path, v] of matches(ctx, glob)) now.set(path, v === undefined ? undefined : cloneWire(v));
      const before = cursors.get(glob);
      cursors.set(glob, now);
      if (before === undefined) return [];
      const out: ChangedRow[] = [];
      for (const [path, value] of now) {
        const prev = before.get(path);
        if (!before.has(path) ? value !== undefined : !deepEqualWire(prev, value)) out.push({ path, value, prev });
      }
      for (const [path, prev] of before) if (!now.has(path) && prev !== undefined) out.push({ path, value: undefined, prev });
      return out;
    } catch (err) {
      report(`ctx.changed(${JSON.stringify(glob)}) failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  };
}
