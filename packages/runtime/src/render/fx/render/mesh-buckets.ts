// The fx mesh sinks' boxes (render §13.4): one primitive box bucket per space (world; the camera's for `follow=camera`
// effects), made on the first frame an effect lives in that space and then kept. In-process the shared fill
// (world/fill-mesh.ts) writes the bucket's own arrays; a result of the fx Worker is copied into them. Either way the bucket grows
// once, to the frame's total, before anything of the frame is in it (F1, DR-54 1).
import type { Matrix4, Object3D } from 'three/webgpu';
import { calibration } from '../../calibration.ts';
import { PrimitiveBuckets, type PrimitiveBucket } from '../../geometry/primitives.ts';
import type { LightingScript } from '../../surface/script-types.ts';
import type { FxMeshOut, FxSpace } from '../fx-protocol.ts';
import type { FxSimulation } from '../sim/simulator.ts';
import { fillMeshes, type MeshArrays, type MeshFill } from '../world/fill-mesh.ts';
import { correctCameraSpace } from './buckets.ts';

export interface FxMeshBucketsOptions {
  readonly world: Object3D;
  readonly camera?: Object3D | null;
  /** the particle cap at construction: a bucket starts there (cpu-budget CPU1 1.4) */
  readonly capacity: number;
  readonly lighting?: LightingScript | null;
  readonly log?: (message: string) => void;
}

/** the box bucket of one mesh space and what the current frame wrote into it */
interface MeshSpace {
  readonly space: FxSpace;
  readonly manager: PrimitiveBuckets;
  /** made on the first frame with an effect in this space, then kept (a grow replaces its mesh, not the bucket) */
  bucket: PrimitiveBucket | null;
  count: number;
}

export class FxMeshBuckets {
  readonly #options: FxMeshBucketsOptions;
  /** world, then camera when there is a camera */
  readonly #spaces: MeshSpace[];
  readonly #fill: MeshFill = { world: 0, camera: 0, usedWorld: false, usedCamera: false };

  constructor(options: FxMeshBucketsOptions) {
    this.#options = options;
    this.#spaces = [{ space: 'world', manager: this.#makeManager(options.world), bucket: null, count: 0 }];
    if (options.camera) this.#spaces.push({ space: 'camera', manager: this.#makeManager(options.camera), bucket: null, count: 0 });
  }

  /**
   * The mesh-sink buckets of a space. A bucket starts at the tier's particle cap (cpu-budget CPU1 1.4): the cap bounds the mesh
   * particles of a frame, so the bucket does not grow unless a later tier raises the cap, and a grow is a new InstancedMesh (a
   * new render object, built in the frame that needs it). The program does not depend on the capacity
   * (engine/stable-programs.ts).
   */
  #makeManager(parent: Object3D): PrimitiveBuckets {
    return new PrimitiveBuckets({
      script: this.#options.lighting ?? null,
      parent,
      capacity: Math.max(16, this.#options.capacity),
      ...(this.#options.log === undefined ? {} : { log: this.#options.log }),
    });
  }

  /** the instances drawn now, over both spaces */
  get instances(): number {
    let n = 0;
    for (const s of this.#spaces) n += s.count;
    return n;
  }

  #spaceOf(space: FxSpace): MeshSpace | undefined {
    return this.#spaces[space === 'camera' ? 1 : 0];
  }

  /** the space's box bucket, made on its first use (the manager holds no other bucket) */
  #bucket(s: MeshSpace): PrimitiveBucket {
    s.bucket ??= s.manager.bucketFor({ kind: 'box', width: 1, height: 1, depth: 1 }, { roughness: calibration.fxMeshRoughness }).bucket;
    return s.bucket;
  }

  /** the in-process fill; `inverse`: the camera's inverse world matrix (null without a camera) */
  fill(sims: readonly FxSimulation[], inverse: Float64Array | null, roughness: number): void {
    for (const s of this.#spaces) s.count = 0;
    const fill = this.#fill;
    fillMeshes(sims, this.#spaces.length > 1, inverse, roughness, {
      use: (space) => {
        const s = this.#spaceOf(space);
        if (s !== undefined) this.#bucket(s).setCount(0);
      },
      arrays: (space, count): MeshArrays | null => {
        const s = this.#spaceOf(space);
        if (s === undefined) return null;
        const b = this.#bucket(s);
        if (count > b.capacity) b.grow(count);
        return { matrices: b.matrices, albedo: b.albedo, emissive: b.emissive, extra: b.extra };
      },
    }, fill);
    this.#spaces[0]!.count = fill.world;
    if (this.#spaces[1]) this.#spaces[1].count = fill.camera;
    this.#finish(null);
  }

  /**
   * A result of the fx Worker: per space its instances (packed `[matrices | albedo | emissive | extra]`). `outs` lists every
   * space the worker has seen an effect in, in the order it first did: the buckets are made in that order (as in-process),
   * then each space of the frame is emptied, grown once and filled, world before camera.
   */
  apply(outs: readonly FxMeshOut[], correction: Matrix4 | null): void {
    for (const s of this.#spaces) s.count = 0;
    for (const o of outs) {
      const s = this.#spaceOf(o.space);
      if (s !== undefined) this.#bucket(s);
    }
    for (const o of outs) {
      const s = this.#spaceOf(o.space);
      if (s !== undefined && o.touched) s.bucket!.setCount(0);
    }
    for (const space of ['world', 'camera'] as const) {
      const o = outs.find((x) => x.space === space);
      const s = this.#spaceOf(space);
      if (o === undefined || s === undefined || !o.touched) continue;
      const b = s.bucket!;
      const n = o.count;
      if (n > b.capacity) b.grow(n);
      const buf = o.buf;
      if (n > 0 && buf !== null) {
        b.matrices.set(buf.subarray(0, n * 16));
        b.albedo.set(buf.subarray(n * 16, n * 20));
        b.emissive.set(buf.subarray(n * 20, n * 24));
        b.extra.set(buf.subarray(n * 24, n * 28));
      }
      s.count = n;
    }
    this.#finish(correction);
  }

  #finish(correction: Matrix4 | null): void {
    for (const s of this.#spaces) {
      const bucket = s.bucket;
      if (bucket === null) continue;
      bucket.spansMap = true;
      bucket.mesh.frustumCulled = false;
      bucket.setCount(s.count);
      bucket.touch(0, s.count);
      s.manager.flush();
      if (s.space === 'camera') correctCameraSpace(bucket.mesh, correction);
    }
  }

  dispose(): void {
    for (const s of this.#spaces) s.manager.dispose();
  }
}
