// Templates and overrides (docs/design/core-runtime.md §4.3, D-CORE-04; contract §3.2, M19).
//
// `templates/<file>.js#<identifier>` resolves synchronously through the module registry, which refuses a bad ref, an unknown or
// unloaded file and a missing export (SpawnRefused) and caches each export deep-frozen (WP C3). The merge is
// template ← sibling fields (everything except `template`, `overrides`, `id`) ← `overrides`:
//   - plain object + plain object → recursive merge;
//   - arrays, scalars, null and type changes → replace (so `tags` and `children` beside a template replace the template's);
//   - an `overrides` key containing `.` sets that nested path (`state.id`, `state.name`: the scene rows of templates), making
//     plain objects on the way where the template holds none.
// The result is a fresh object that shares nothing with the template or the spec; `template` stays on it (the view reads it).
// tools/places/override-report.ts merges the same way (its 'deep' mode); spec.test checks both agree on every live template row.
import type { ModuleRegistry, ObjectSpec, TemplateRef } from '../types.ts';
import { SpawnRefused, TEMPLATE_REF } from '../modules/registry.ts';

type Obj = Record<string, unknown>;

export function isPlain(v: unknown): v is Obj {
  if (v === null || typeof v !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** an own data property, also for a `__proto__` key */
function put(o: Obj, k: string, v: unknown): void {
  if (k === '__proto__') Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
  else o[k] = v;
}

/** a deep copy of plain objects and arrays (unfrozen); anything else is kept as is */
export function copyPlain<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x: unknown) => copyPlain(x)) as T;
  if (isPlain(v)) {
    const out: Obj = {};
    for (const k of Object.keys(v)) put(out, k, copyPlain(v[k]));
    return out as T;
  }
  return v;
}

function setDotted(root: Obj, dotted: string, value: unknown): void {
  const segs = dotted.split('.');
  let o = root;
  for (const s of segs.slice(0, -1)) {
    const next = Object.hasOwn(o, s) ? o[s] : undefined;
    if (isPlain(next)) o = next;
    else {
      const fresh: Obj = {};
      put(o, s, fresh);
      o = fresh;
    }
  }
  put(o, segs[segs.length - 1]!, copyPlain(value));
}

function mergeInto(target: Obj, src: Obj, dotted: boolean): void {
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (dotted && k.includes('.')) {
      setDotted(target, k, v);
      continue;
    }
    const cur = Object.hasOwn(target, k) ? target[k] : undefined;
    if (isPlain(cur) && isPlain(v)) mergeInto(cur, v, false);
    else put(target, k, copyPlain(v));
  }
}

/** core §4.3: `base` ← `sibling` ← `overrides` (dotted override keys set nested paths); neither input is written */
export function mergeSpec(base: Readonly<Obj>, sibling: Readonly<Obj>, overrides?: Readonly<Obj> | null): Obj {
  const out = copyPlain(base) as Obj;
  mergeInto(out, sibling as Obj, false);
  if (overrides) mergeInto(out, overrides as Obj, true);
  return out;
}

/** the template export of `ref`: sync, frozen and cached by the registry; SpawnRefused when it cannot be had */
export function resolveTemplate(ref: TemplateRef, reg: Pick<ModuleRegistry, 'template'>): Readonly<ObjectSpec> {
  if (typeof ref !== 'string' || !TEMPLATE_REF.test(ref)) {
    throw new SpawnRefused(`spawn refused: bad template ref "${String(ref)}" (templates/<file>.js#<identifier>)`);
  }
  return reg.template(ref);
}

/**
 * A spec with its template (when it names one) and its `overrides` applied: a fresh object without `overrides` and `id` (the
 * caller reads the id from the spec it was given), `template` kept. A spec without a template still applies its `overrides`.
 */
export function expandSpec(spec: Readonly<Obj>, reg: Pick<ModuleRegistry, 'template'>): ObjectSpec {
  const ref = spec['template'];
  const overrides = spec['overrides'];
  if (overrides !== undefined && overrides !== null && !isPlain(overrides)) throw new SpawnRefused('spawn refused: overrides is not an object');
  const sibling: Obj = {};
  for (const k of Object.keys(spec)) if (k !== 'template' && k !== 'overrides' && k !== 'id') put(sibling, k, spec[k]);
  if (ref === undefined || ref === null) {
    return mergeSpec({}, sibling, overrides as Obj | undefined) as ObjectSpec;
  }
  const base = resolveTemplate(ref as TemplateRef, reg);
  const out = mergeSpec(base as Obj, sibling, overrides as Obj | undefined);
  put(out, 'template', ref);
  return out as ObjectSpec;
}
