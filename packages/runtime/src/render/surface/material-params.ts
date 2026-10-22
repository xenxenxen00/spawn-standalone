// K10c: `ctx.param(name, default)` for scripted materials (`api-reference` "ctx.params, ctx.param(name, default)"). A declared
// parameter is a shader-node uniform: the script scales it with `.mul()`, and a later write to `params.<name>` changes the
// uniform's value, never the program (one compile however many frames the value moves; Pip's `alt` 0 -> 900).
//
// The store lives beside the material (`userData`), so the row owner can push new `material.params` each frame without the
// script or the renderer knowing: `setScriptedMaterialParams(material, { alt: 412 })`.
import { uniform } from 'three/tsl';
import { Vector2, Vector3, Vector4 } from 'three/webgpu';
import type { Material } from 'three/webgpu';

export type MaterialParamValue = number | boolean | readonly number[];
type ParamNode = ReturnType<typeof uniform>;

export interface MaterialParamStore {
  /** `ctx.param`: one uniform node per name; the same node on every call with that name */
  param(name: string, def?: MaterialParamValue): ParamNode;
  /** writes the uniforms of the names the script declared; unknown names are remembered for a later `param()` call */
  update(params: Readonly<Record<string, unknown>>): void;
  /** the declared names, in first-call order */
  names(): string[];
}

export const MATERIAL_PARAMS_KEY = 'ssMaterialParams';

const asValue = (v: unknown): number | readonly number[] | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) return v as number[];
  return undefined;
};

const sizeOf = (v: number | readonly number[]): number => (typeof v === 'number' ? 1 : v.length);

function makeUniform(v: number | readonly number[]): ParamNode {
  if (typeof v === 'number') return uniform(v);
  if (v.length === 2) return uniform(new Vector2(v[0], v[1]));
  if (v.length === 3) return uniform(new Vector3(v[0], v[1], v[2]));
  return uniform(new Vector4(v[0], v[1], v[2], v[3]));
}

function write(node: ParamNode, v: number | readonly number[]): void {
  if (typeof v === 'number') node.value = v;
  else (node.value as Vector2 | Vector3 | Vector4).fromArray(v as number[]);
}

/** `initial` is the row's `material.params`: a declared name takes its value there, else its script default. */
export function createMaterialParamStore(initial: Readonly<Record<string, unknown>> = {}): MaterialParamStore {
  const current = new Map<string, number | readonly number[]>();
  for (const [k, v] of Object.entries(initial)) {
    const val = asValue(v);
    if (val !== undefined) current.set(k, val);
  }
  const nodes = new Map<string, { node: ParamNode; size: number }>();
  return {
    param(name, def = 0) {
      if (typeof name !== 'string' || name === '') throw new TypeError(`ctx.param: the name must be a non-empty string, got ${JSON.stringify(name)}`);
      const have = nodes.get(name);
      if (have) return have.node;
      const fallback = asValue(def);
      if (fallback === undefined) throw new TypeError(`ctx.param('${name}'): the default must be a finite number, a boolean or an array of 2 to 4 numbers`);
      let v = current.get(name) ?? fallback;
      if (sizeOf(v) !== sizeOf(fallback)) v = fallback; // a stored value of another width cannot drive this uniform
      const node = makeUniform(v);
      nodes.set(name, { node, size: sizeOf(v) });
      return node;
    },
    update(params) {
      for (const [k, raw] of Object.entries(params)) {
        const v = asValue(raw);
        if (v === undefined) continue;
        current.set(k, v);
        const entry = nodes.get(k);
        if (entry && entry.size === sizeOf(v)) write(entry.node, v);
      }
    },
    names: () => [...nodes.keys()],
  };
}

/** The store a material was built with (`buildScriptedMaterial` attaches it), or null for a material that declared none. */
export function materialParamsOf(material: Material): MaterialParamStore | null {
  const s = (material.userData as Record<string, unknown>)[MATERIAL_PARAMS_KEY];
  return s !== undefined && s !== null ? (s as MaterialParamStore) : null;
}

/** Live update: pushes new `material.params` values into the uniforms of a scripted material. Returns whether it had any. */
export function setScriptedMaterialParams(material: Material, params: Readonly<Record<string, unknown>>): boolean {
  const store = materialParamsOf(material);
  if (!store) return false;
  store.update(params);
  return true;
}
