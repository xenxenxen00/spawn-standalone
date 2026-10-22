// Scripted materials on primitive rows (opt-in; docs/design/rendering.md §14.1 draws them on scripted-geometry map rows only).
// A row `{ primitive: { kind: 'plane', … }, material: { kind: 'scripted', script, params } }` is a backdrop, a sky dome, a
// screen-space quad: the bridge hands it to the `scriptedMaterial` row extension (`RowExtensionField`), and this module is that
// extension. It draws the primitive's own unit geometry (the one a bucket would use, `primitiveShape`) as a single mesh under the
// row's node with the material the game's module builds, and a later write of `material.params` moves the module's
// `ctx.param(...)` uniforms (never the program). One material per row: rows do not share live params.
//
// Without the extension the bridge keeps the legacy host's behaviour: it logs that the row is a later package's and the bucket draws the
// primitive with the default material.
import { Mesh } from 'three/webgpu';
import type { BufferGeometry, NodeMaterial, Object3D } from 'three/webgpu';
import type { RowSnapshot } from '../../compat/core/ports.ts';
import type { RowExtension, RowExtensionBinding } from '../bridge/bridge-types.ts';
import { primitiveSpecOf } from '../bridge/row-spec.ts';
import { primitiveShape, type PrimitiveSpec } from '../geometry/primitives.ts';
import { isScriptedMaterialSpec, type ScriptedMaterialSpec } from '../surface/material-spec.ts';
import { setScriptedMaterialParams } from '../surface/material-params.ts';
import { loadScriptedMaterial, type ScriptedMaterialOptions } from '../surface/scripted-material.ts';

export interface ScriptedPrimitiveOptions {
  /** a carried material module by its tree path (the engine content loader) */
  load: (path: string) => Promise<Record<string, unknown>>;
  /** dev builds throw on a malformed module; default: `import.meta.env.DEV` */
  dev?: boolean;
  log?: (message: string) => void;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The `scriptedMaterial` row extension (`DepsExtensions`): `installRenderBridge({ extensions: { scriptedMaterial } })`. */
export function createScriptedPrimitiveExtension(opts: ScriptedPrimitiveOptions): RowExtension {
  const matOpts: ScriptedMaterialOptions = { ...(opts.dev === undefined ? {} : { dev: opts.dev }), ...(opts.log === undefined ? {} : { log: opts.log }) };
  return (row: RowSnapshot, node: Object3D): RowExtensionBinding | null => {
    const read = (r: RowSnapshot): { prim: PrimitiveSpec; mat: ScriptedMaterialSpec } | null => {
      const prim = primitiveSpecOf(r.props);
      const mat = r.props['material'];
      return prim !== null && isScriptedMaterialSpec(mat) ? { prim, mat } : null;
    };
    const first = read(row);
    if (first === null) return null;

    let current = first;
    let mesh: Mesh | null = null;
    let geometry: BufferGeometry | null = null;
    let material: NodeMaterial | null = null;
    let generation = 0;
    let disposed = false;

    const clear = (): void => {
      generation++;
      if (mesh !== null) node.remove(mesh);
      mesh = null;
      geometry?.dispose();
      geometry = null;
      material?.dispose();
      material = null;
    };

    const build = (next: { prim: PrimitiveSpec; mat: ScriptedMaterialSpec }): void => {
      clear();
      current = next;
      const mine = generation;
      let shape;
      try {
        shape = primitiveShape(next.prim);
      } catch (e) {
        opts.log?.(`[scripted-primitive] ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      loadScriptedMaterial({ load: (path) => opts.load(path) }, next.mat, matOpts).then(
        (m) => {
          if (disposed || mine !== generation) {
            m.dispose();
            return;
          }
          material = m;
          // params written while the module loaded
          if (current.mat.params !== undefined) setScriptedMaterialParams(m, current.mat.params);
          geometry = shape.create();
          mesh = new Mesh(geometry, m);
          mesh.name = `ss:scripted-primitive:${row.id}`;
          mesh.scale.set(shape.scale[0], shape.scale[1], shape.scale[2]);
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          mesh.frustumCulled = false;
          node.add(mesh);
        },
        (e: unknown) => opts.log?.(`[scripted-primitive] ${next.mat.script}: ${e instanceof Error ? e.message : String(e)}`),
      );
    };

    build(first);
    return {
      update(r: RowSnapshot): void {
        const next = read(r);
        if (next === null) return;
        if (!same(next.prim, current.prim) || next.mat.script !== current.mat.script) {
          build(next);
          return;
        }
        current = next;
        if (material !== null && next.mat.params !== undefined) setScriptedMaterialParams(material, next.mat.params);
      },
      dispose(): void {
        disposed = true;
        clear();
      },
    };
  };
}
