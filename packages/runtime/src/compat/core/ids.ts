// Id grammar and minting (docs/design/core-runtime.md §4.4, §8.6, §11.8; contract §1.4, §3.7).
import type { ActName, RowId } from './types.ts';
import { ENGINE } from './rules.ts';

/** one `/`-separated id segment (contract §1.4; a `~` made every spawn fail silently, engine reference) */
export const ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** a whole row id: one or more segments joined by `/` */
export const ROW_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/;

/** default local player body id */
export const HUMAN_BODY_ID: RowId = 'player/local';
/** the camera rig row (core §7.4) */
export const CAMERA_RIG_ID: RowId = 'camera/local';

/** every `/`-separated segment matches ID_SEGMENT; anything that is not a string is not an id */
export function validateId(id: unknown): id is RowId {
  return typeof id === 'string' && ROW_ID.test(id);
}

/** `<parent>/<local>`: a child named in `children` (local id) or unnamed (its array index) */
export function childId(parentId: RowId, local: string | number): RowId {
  return `${parentId}/${local}`;
}

/** `ctx.spawn(id, { parent: P })`: an id already scoped to P (`P/…`) is kept, else it becomes `P/id` (`bp-Head` → `<enemy>/bp-Head`) */
export function parentScopedId(parentId: RowId, id: string): RowId {
  return id.startsWith(`${parentId}/`) ? id : childId(parentId, id);
}

/** the last segment of an id: a child row's name when its spec names none (core §3.2) */
export function localSegment(id: RowId): string {
  const i = id.lastIndexOf('/');
  return i < 0 ? id : id.slice(i + 1);
}

/** `o` + a canonical base-36 serial (no leading zeros) */
const MINTED_ID = /^o(?:0|[1-9a-z][0-9a-z]*)$/;

function assertCounter(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what}: expected a non-negative safe integer, got ${n}`);
}

/** an unnamed top-level spawn: `o<base36 serial>` */
export function mintId(serial: number): RowId {
  assertCounter(serial, 'mintId');
  return `o${serial.toString(36)}`;
}

/** the shape mintId produces (a game row may still carry such an id; the minting caller skips ids already taken) */
export function isMintedId(id: string): boolean {
  return MINTED_ID.test(id);
}

// ── act ids (core §8.6: minted for every playSound / fx, also when filtered; never row ids) ─────────────────────────

export type ActIdPrefix = 'snd-' | 'fx-';

/** the acts that return an id from ctx.emit */
export const ACT_ID_PREFIX: Readonly<Partial<Record<ActName, ActIdPrefix>>> = Object.freeze({ playSound: 'snd-', fx: 'fx-' });

const ACT_ID = /^(snd-|fx-)(?:0|[1-9][0-9]*)$/;

export function actId(prefix: ActIdPrefix, n: number): string {
  assertCounter(n, 'actId');
  return `${prefix}${n}`;
}

export function isActId(id: string): boolean {
  return ACT_ID.test(id);
}

/** the act kind of an act id (`ctx.destroy('fx-12')` ends an effect, `stopSound` a voice), null for anything else */
export function actIdPrefixOf(id: string): ActIdPrefix | null {
  const m = ACT_ID.exec(id);
  return m ? (m[1] as ActIdPrefix) : null;
}

// ── scene cells (contract §3.7, core §11.8) ──────────────────────────────────────────────────────────────────────────

/** canonical cell keys only: no leading zeros, no `-0` */
const CELL_KEY = /^x(0|-?[1-9][0-9]*)z(0|-?[1-9][0-9]*)$/;

/** `x<cx>z<cz>` with cx = Math.round(x/128) (round half up): x0z0 holds −64 ≤ x < 64 */
export function cellKeyOf(p: { x: number; z: number }): string {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) throw new RangeError(`cellKeyOf: non-finite position (${p.x}, ${p.z})`);
  // `+ 0` turns the -0 of Math.round(-0.5) into 0, so no key ever reads "x-0"
  const cx = Math.round(p.x / ENGINE.CELL_SIZE_M) + 0;
  const cz = Math.round(p.z / ENGINE.CELL_SIZE_M) + 0;
  return `x${cx}z${cz}`;
}

/** the cell of a canonical key; null for `objects`, `dress` and anything else that is not one */
export function parseCellKey(key: string): { cx: number; cz: number } | null {
  const m = CELL_KEY.exec(key);
  return m ? { cx: Number(m[1]), cz: Number(m[2]) } : null;
}

// ── object ids (core §3.3) ───────────────────────────────────────────────────────────────────────────────────────────

export interface KernelIds { humanBody: RowId; cameraRig: RowId }
export const DEFAULT_IDS: Readonly<KernelIds> = Object.freeze({ humanBody: HUMAN_BODY_ID, cameraRig: CAMERA_RIG_ID });
const objectIdPrefix = (worldId: string | null): string => `world:${encodeURIComponent(worldId ?? '')}#`;

/** `ObjectView.objectId`: `world:<worldId>#<id>` (the query option `objectId` matches it) */
export function objectIdOf(id: RowId, worldId: string | null = null): string {
  return `${objectIdPrefix(worldId)}${id}`;
}

/** the row id inside an objectId of this world, else null */
export function rowIdOfObjectId(objectId: string, worldId: string | null = null): RowId | null {
  const prefix = objectIdPrefix(worldId);
  if (!objectId.startsWith(prefix)) return null;
  const id = objectId.slice(prefix.length);
  return validateId(id) ? id : null;
}
