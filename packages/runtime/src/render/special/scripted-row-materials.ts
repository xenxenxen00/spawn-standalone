// Scripted materials for standalone generated rows. Content modules load asynchronously, while the batcher reads
// their cached materials synchronously. Hosts can preload known modules before drawing; a late module keeps the
// generator paint until it resolves. Warm-up stand-ins cover returned UV and smooth-normal layouts.
import { Mesh } from 'three/webgpu';
import type { Material, NodeMaterial, Object3D, BufferGeometry } from 'three/webgpu';
import { packedAttributes, packedRangeGeometry } from '../geometry/map-batcher.ts';
import { isScriptedMaterialSpec, type ScriptedMaterialSpec } from '../surface/material-spec.ts';
import { loadScriptedMaterial, type ScriptedMaterialOptions } from '../surface/scripted-material.ts';

export interface ScriptedRowMaterialsOptions {
  /** a carried material module by its tree path (the engine content loader) */
  load: (path: string) => Promise<Record<string, unknown>>;
  /** dev builds throw on a malformed module; default: `import.meta.env.DEV` */
  dev?: boolean;
  log?: (message: string) => void;
}

const keyOf = (spec: ScriptedMaterialSpec): string => (spec.params === undefined ? spec.script : `${spec.script}?${JSON.stringify(spec.params)}`);

/** the scripted materials of map rows */
export class ScriptedRowMaterials {
  readonly #opts: ScriptedRowMaterialsOptions;
  readonly #ready = new Map<string, NodeMaterial>();
  readonly #loading = new Map<string, Promise<NodeMaterial | null>>();
  readonly #late = new Set<string>();
  readonly #warmGeometries: BufferGeometry[] = [];
  #disposed = false;

  constructor(opts: ScriptedRowMaterialsOptions) {
    this.#opts = opts;
  }

  #load(spec: ScriptedMaterialSpec): Promise<NodeMaterial | null> {
    const key = keyOf(spec);
    let p = this.#loading.get(key);
    if (p === undefined) {
      const o: ScriptedMaterialOptions = {
        ...(this.#opts.dev === undefined ? {} : { dev: this.#opts.dev }),
        ...(this.#opts.log === undefined ? {} : { log: this.#opts.log }),
      };
      p = loadScriptedMaterial({ load: (path) => this.#opts.load(path) }, spec, o).then(
        (m) => {
          if (this.#disposed) {
            m.dispose();
            return null;
          }
          m.name ||= `ss:scripted:${spec.script}`;
          this.#ready.set(key, m);
          return m;
        },
        (e: unknown) => {
          this.#loading.delete(key);
          this.#opts.log?.(`[trail] ${spec.script}: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        },
      );
      this.#loading.set(key, p);
    }
    return p;
  }

  /** loads and builds the modules the game names (the engine-load warm-up awaits it) */
  async preload(scripts: readonly string[]): Promise<void> {
    await Promise.all(scripts.map((script) => this.#load({ kind: 'scripted', script })));
  }

  /** the material of a map row's `material` value; null while it is not built (the generator's paints draw) */
  get(spec: unknown): Material | null {
    if (this.#disposed || !isScriptedMaterialSpec(spec)) return null;
    const hit = this.#ready.get(keyOf(spec));
    if (hit !== undefined) return hit;
    const key = keyOf(spec);
    if (!this.#late.has(key)) {
      this.#late.add(key);
      this.#opts.log?.(`[trail] ${spec.script} was not loaded with the warm-up: it loads now, and its first draw may link a program`);
    }
    void this.#load(spec);
    return null;
  }

  /** the scripted materials built so far */
  get loaded(): number {
    return this.#ready.size;
  }

  /** every built material on the map's single-row geometry shapes (see the header) */
  warmObjects(): Object3D[] {
    if (this.#disposed) return [];
    const out: Object3D[] = [];
    // one triangle, packed like the batcher packs a level
    const vtx = new Int16Array([0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 100, 0]).buffer;
    const idx = new Uint16Array([0, 1, 2]);
    for (const [key, material] of this.#ready) {
      for (const withNormal of [false, true]) {
        const attrs = packedAttributes(vtx, idx, new Float32Array([0, 0, 1, 0, 0, 1]), withNormal ? new Int8Array([0, 127, 0, 0, 0, 127, 0, 0, 0, 127, 0, 0]) : undefined);
        const g = packedRangeGeometry(attrs, 0, 3);
        this.#warmGeometries.push(g);
        const mesh = new Mesh(g, material);
        mesh.name = `ss:warm-up:scripted:${key}:uv${withNormal ? ':n' : ''}`;
        out.push(mesh);
      }
    }
    return out;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const m of this.#ready.values()) m.dispose();
    this.#ready.clear();
    for (const g of this.#warmGeometries.splice(0)) g.dispose();
  }
}
