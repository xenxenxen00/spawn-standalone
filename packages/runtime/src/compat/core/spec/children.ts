// Children flattening (docs/design/core-runtime.md §4.4, §4.6; contract §3.3).
//
// A spec's `children` become rows created right after their parent, depth-first (a child's own children before its next
// sibling), each expanded through its own template and normalised. Ids: a child with `id: c` is `<parent>/<c>`, an unnamed one
// `<parent>/<i>` (its array index; no live code looks an unnamed child up by id, gore iterates `children`). The lifecycle gives
// each child its parent's place and VM and validates the whole batch before inserting anything (core §4.5).
import type { ModuleRegistry, ObjectSpec, RowId } from '../types.ts';
import { childId } from '../ids.ts';
import { SpawnRefused } from '../modules/registry.ts';
import { normalizeSpec, type NormalizedSpec } from './normalize.ts';
import { expandSpec, isPlain } from './template.ts';

export interface PlannedChild {
  readonly id: RowId;
  readonly parentId: RowId;
  /** the position in the parent's `children` array */
  readonly index: number;
  /** after its template merge (core §4.3) */
  readonly merged: ObjectSpec;
  readonly spec: NormalizedSpec;
}

/** the rows `children` of `parentId` make, depth-first in creation order; throws SpawnRefused for a child that is no object or
 *  whose template cannot be had */
export function flattenChildren(parentId: RowId, children: readonly unknown[], reg: Pick<ModuleRegistry, 'template'>, depth = 0): PlannedChild[] {
  if (depth > 32) throw new SpawnRefused(`spawn refused: children nested deeper than 32 under ${parentId}`);
  const out: PlannedChild[] = [];
  children.forEach((raw, index) => {
    if (!isPlain(raw)) throw new SpawnRefused(`spawn refused: children[${index}] of ${parentId} is not a spec object`);
    const local = typeof raw['id'] === 'string' ? raw['id'] : index;
    const id = childId(parentId, local);
    const merged = expandSpec(raw, reg);
    const spec = normalizeSpec(merged);
    out.push({ id, parentId, index, merged, spec });
    if (spec.children.length > 0) out.push(...flattenChildren(id, spec.children, reg, depth + 1));
  });
  return out;
}
