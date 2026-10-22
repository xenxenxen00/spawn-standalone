// ObjectSpec normalisation (docs/design/core-runtime.md §4.2; contract §1.2-1.3, §3.1, §26).
//
// Input: a spec after its template merge (spec/template.ts expandSpec). Output: the engine fields split from the ObjectProperties
// fields, each in its normal form; nothing here touches a store, a port or the clock (the lifecycle resolves places, ids,
// positions against the ground and lifetimes against the tick):
//
//   behavior        string | string[], `./x` or `/x`          → TreePath[] in spec order
//   physics         omitted | false | null | "<body>" | {body} → absent | null | { body } | the object (a wire copy)
//   feetPosition, rotation, yaw, scale, velocity, angularVelocity → `transform` (raw wire copies; store/transform.ts resolves)
//   lifetime        seconds ≥ 0                                → number (else null + an issue)
//   tags            string[]                                   → a frozen copy of the strings
//   state           object                                     → a wire copy
//   audience, scope, visibility, simulatedBy                    → the value when it is one of the spec's, else the default + issue
//   tick            accepted, unused live                      → dropped
//   __portUnowned   port-only flag (contract §3.6.1 D2)        → `unowned`, stripped
//   everything else                                            → props[field] = cloneWire(value)
//
// An invalid engine field is dropped and named in `issues` (the lifecycle warns); it never refuses the spawn. Refusals (bad ids,
// templates, places, parents, behaviours) are the lifecycle's (core §4.5).
import type { ObjectSpec, PlaceId, RowId, TemplateRef, TreePath } from '../types.ts';
import { cloneWire } from '../wire.ts';
import { normalizeTreePath } from '../modules/registry.ts';
import { isPlain } from './template.ts';

type Obj = Record<string, unknown>;

/** the raw transform fields of a spec (resolved by store/transform.ts transformFromSpec at spawn) */
export interface SpecTransformFields {
  feetPosition?: unknown;
  rotation?: unknown;
  yaw?: unknown;
  scale?: unknown;
  velocity?: unknown;
  angularVelocity?: unknown;
}

export interface NormalizedSpec {
  /** the spec's own id field (the lifecycle prefers `ctx.spawn(id, …)`) */
  readonly id: string | null;
  readonly template: TemplateRef | null;
  readonly parent: RowId | null;
  readonly place: PlaceId | null;
  readonly tags: readonly string[];
  readonly state: Obj;
  readonly behavior: TreePath[];
  readonly audience: 'near' | 'all' | 'local';
  /** the spec named an audience (children inherit a parent's 'local' otherwise) */
  readonly audienceGiven: boolean;
  readonly scope: 'session' | 'world';
  readonly visibility: 'owner' | 'platform' | null;
  readonly simulatedBy: 'platform' | null;
  /** seconds */
  readonly lifetime: number | null;
  readonly name: string | null;
  readonly transform: SpecTransformFields;
  readonly props: Obj;
  /** child specs as written (each is expanded and normalised in its turn, spec/children.ts) */
  readonly children: readonly Obj[];
  readonly unowned: boolean;
  /** engine fields whose value was no valid form (dropped) */
  readonly issues: readonly string[];
}

/** fields the engine reads itself; never stored in props */
export const ENGINE_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'tags',
  'state',
  'behavior',
  'template',
  'overrides',
  'parent',
  'children',
  'place',
  'audience',
  'visibility',
  'scope',
  'simulatedBy',
  'lifetime',
  'tick',
  'yaw',
  'feetPosition',
  'rotation',
  'scale',
  'velocity',
  'angularVelocity',
  'name',
  '__portUnowned',
]);

const TRANSFORM_FIELDS = ['feetPosition', 'rotation', 'yaw', 'scale', 'velocity', 'angularVelocity'] as const;
const AUDIENCES = new Set(['near', 'all', 'local']);
const SCOPES = new Set(['session', 'world']);
const VISIBILITIES = new Set(['owner', 'platform']);

/** core §4.2 `behavior`: TreePath[] without a leading `./` or `/`, order kept; null for a value that is no form of it */
export function normalizeBehavior(v: unknown): TreePath[] | null {
  if (v === undefined || v === null) return [];
  const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v : null;
  if (list === null) return null;
  const out: TreePath[] = [];
  for (const p of list) {
    if (typeof p !== 'string' || p === '') return null;
    out.push(normalizeTreePath(p));
  }
  return out;
}

/** core §4.2 `physics`: undefined when omitted, null for false/null, `{ body: s }` for a body string, a copy of an object */
export function normalizePhysics(v: unknown): Obj | null | undefined {
  if (v === undefined) return undefined;
  if (v === false || v === null) return null;
  if (typeof v === 'string') return { body: v };
  if (isPlain(v)) return cloneWire(v) as Obj;
  return undefined;
}

/** a parent field: an id, or a handle-like object with a string id */
function parentOf(v: unknown): RowId | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') return (v as { id: string }).id;
  return undefined;
}

export function normalizeSpec(spec: Readonly<ObjectSpec> | Readonly<Obj>): NormalizedSpec {
  const s = spec as Obj;
  const issues: string[] = [];
  const bad = (field: string): void => {
    issues.push(field);
  };

  const idRaw = s['id'];
  const id = typeof idRaw === 'string' ? idRaw : null;
  if (idRaw !== undefined && idRaw !== null && id === null) bad('id');

  const tplRaw = s['template'];
  const template = typeof tplRaw === 'string' ? tplRaw : null;

  const parent = parentOf(s['parent']);
  if (parent === undefined) bad('parent');

  const placeRaw = s['place'];
  const place = typeof placeRaw === 'string' ? placeRaw : null;
  if (placeRaw !== undefined && placeRaw !== null && place === null) bad('place');

  let tags: string[] = [];
  const tagsRaw = s['tags'];
  if (Array.isArray(tagsRaw)) {
    tags = tagsRaw.filter((t): t is string => typeof t === 'string');
    if (tags.length !== tagsRaw.length) bad('tags');
  } else if (tagsRaw !== undefined && tagsRaw !== null) bad('tags');

  let state: Obj = {};
  const stateRaw = s['state'];
  if (isPlain(stateRaw)) state = cloneWire(stateRaw) as Obj;
  else if (stateRaw !== undefined && stateRaw !== null) bad('state');

  let behavior = normalizeBehavior(s['behavior']);
  if (behavior === null) {
    bad('behavior');
    behavior = [];
  }

  const audRaw = s['audience'];
  const audienceGiven = typeof audRaw === 'string' && AUDIENCES.has(audRaw);
  if (audRaw !== undefined && !audienceGiven) bad('audience');
  const scopeRaw = s['scope'];
  const scopeOk = typeof scopeRaw === 'string' && SCOPES.has(scopeRaw);
  if (scopeRaw !== undefined && !scopeOk) bad('scope');
  const visRaw = s['visibility'];
  const visOk = typeof visRaw === 'string' && VISIBILITIES.has(visRaw);
  if (visRaw !== undefined && visRaw !== null && !visOk) bad('visibility');
  const simRaw = s['simulatedBy'];
  if (simRaw !== undefined && simRaw !== null && simRaw !== 'platform') bad('simulatedBy');

  const lifeRaw = s['lifetime'];
  let lifetime: number | null = null;
  if (typeof lifeRaw === 'number' && Number.isFinite(lifeRaw) && lifeRaw >= 0) lifetime = lifeRaw;
  else if (lifeRaw !== undefined && lifeRaw !== null) bad('lifetime');

  const nameRaw = s['name'];
  const name = typeof nameRaw === 'string' ? nameRaw : null;

  const transform: SpecTransformFields = {};
  for (const f of TRANSFORM_FIELDS) {
    const v = s[f];
    if (v !== undefined) transform[f] = typeof v === 'object' && v !== null ? cloneWire(v) : v;
  }

  let children: Obj[] = [];
  const kids = s['children'];
  if (Array.isArray(kids)) children = kids as Obj[];
  else if (kids !== undefined && kids !== null) bad('children');

  const props: Obj = {};
  for (const k of Object.keys(s)) {
    if (ENGINE_FIELDS.has(k) || s[k] === undefined) continue;
    const v = k === 'physics' ? normalizePhysics(s[k]) : cloneWire(s[k]);
    if (k === 'physics' && v === undefined) {
      bad('physics');
      continue;
    }
    if (v === undefined) continue;
    if (k === '__proto__') Object.defineProperty(props, k, { value: v, writable: true, enumerable: true, configurable: true });
    else props[k] = v;
  }

  return {
    id,
    template,
    parent: parent ?? null,
    place,
    tags: Object.freeze(tags),
    state,
    behavior,
    audience: audienceGiven ? (audRaw as 'near' | 'all' | 'local') : 'near',
    audienceGiven,
    scope: scopeOk ? (scopeRaw as 'session' | 'world') : 'world',
    visibility: visOk ? (visRaw as 'owner' | 'platform') : null,
    simulatedBy: simRaw === 'platform' ? 'platform' : null,
    lifetime,
    name,
    transform,
    props,
    children,
    unowned: s['__portUnowned'] === true,
    issues,
  };
}
