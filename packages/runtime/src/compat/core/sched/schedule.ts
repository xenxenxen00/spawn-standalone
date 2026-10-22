// `updateSchedule` parsing, per-entity phases and locality (docs/design/core-runtime.md §9.4, D-CORE-10; contract §7.2;
// engine api:465).
//
//   every: N            → every N ticks, dt = N/30
//   every: {seconds: s} → every max(1, round(s·30)) ticks, dt = that step/30
//   none (or malformed) → every tick, dt = 1/30
//   near                → accepted; locality is "the row's place is simulated" (every live map fits the ~500 m radius)
//
// Phase. A behavior runs at the ticks where (tick + phase) % N === 0, the phase deterministic per (row, behavior) so that a
// cohort spreads over its N ticks (api:465 "a cohort auto-spreads"; babylon §21.9 "10 Hz brains spread across the three 30 Hz
// ticks"). The design names fnv1a32(rowId + ':' + path) mod N. A plain hash spreads a cohort only statistically: 300 rows on
// N = 3 land within ±10 % of the mean about half the time (binomial σ ≈ 8.2), so the cohorts the game actually builds would
// split unevenly. Every such cohort is numbered (enemies `en-<match>-0042`, doors `gf-door-12`, minted `o1z`), so the phase
// takes the hash of the id's stem plus its serial: phase = (fnv1a32(stem + ':' + path) + serial) mod N. Consecutive serials
// fall into consecutive residues, a cohort spreads to within one row per class, and the phase is still a pure function of
// (rowId, path). Ids without a trailing serial (`player/local`, `<enemy>/bp-Head`) keep the plain hash.
import { isMintedId } from '../ids.ts';
import { ENGINE } from '../rules.ts';
import type { CompiledSchedule, PlaceId, RowId, TreePath } from '../types.ts';

/** 32-bit FNV-1a over UTF-16 code units (ids and tree paths are ASCII) */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** no schedule: every tick, dt one tick */
export const EVERY_TICK: CompiledSchedule = Object.freeze({ everyTicks: 1, phase: 0, dtS: 1 / ENGINE.TICK_HZ });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** the tick period an `updateSchedule` export asks for; anything malformed is every tick */
export function everyTicksOf(spec: unknown): number {
  if (!isObject(spec)) return 1;
  const every = spec['every'];
  let n: number;
  if (typeof every === 'number') n = every;
  else if (isObject(every) && typeof every['seconds'] === 'number') n = every['seconds'] * ENGINE.TICK_HZ;
  else return 1;
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.round(n));
}

/** the last up to nine digits of an id (a serial), after a non-digit stem */
const SERIAL = /^(.*?)(\d{1,9})$/;

/** the phase of one behavior instance (see the header) */
export function phaseFor(rowId: RowId, path: TreePath, everyTicks: number): number {
  if (everyTicks <= 1) return 0;
  let stem: string;
  let serial: number;
  if (isMintedId(rowId)) {
    // kernel-minted `o<base36 serial>`: the whole serial, in its own radix
    stem = 'o';
    serial = parseInt(rowId.slice(1), 36) % everyTicks;
  } else {
    const m = SERIAL.exec(rowId);
    if (!m) return fnv1a32(`${rowId}:${path}`) % everyTicks;
    stem = m[1]!;
    serial = Number(m[2]) % everyTicks;
  }
  return (fnv1a32(`${stem}:${path}`) + serial) % everyTicks;
}

/** core §9.4: the compiled `updateSchedule` of a behavior instance */
export function compileSchedule(spec: unknown, rowId: RowId, path: TreePath): CompiledSchedule {
  const everyTicks = everyTicksOf(spec);
  if (everyTicks === 1) return EVERY_TICK;
  return Object.freeze({ everyTicks, phase: phaseFor(rowId, path, everyTicks), dtS: everyTicks / ENGINE.TICK_HZ });
}

/** whether the schedule runs at `tick` */
export function shouldRun(s: CompiledSchedule, tick: number): boolean {
  return s.everyTicks <= 1 || (tick + s.phase) % s.everyTicks === 0;
}

/** core §9.4 locality: rows update while their place is simulated (holds the human); a row without a place always runs */
export function isLocal(place: PlaceId | null, isSimulated: (p: PlaceId) => boolean): boolean {
  return place === null || isSimulated(place);
}
