import { billboarding, instancedDynamicBufferAttribute, texture, uv, vec2, vec4 } from 'three/tsl';
import { AdditiveBlending, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, MeshBasicNodeMaterial, NormalBlending, PlaneGeometry } from 'three/webgpu';
import type { Matrix4, Node, Object3D, Texture } from 'three/webgpu';
import type { AdditiveFog } from '../../calibration.ts';
import { finishScriptedMaterial } from '../../surface/scripted-material.ts';
import type { FxSimulation } from '../sim/simulator.ts';
import type { FxSpriteOut } from '../fx-protocol.ts';
import { invertInto } from '../world/fx-math.ts';
import { fillStretched, type StretchedSlot, type StretchedSlots } from '../world/fill-stretched.ts';
export { composeAxisCard } from '../world/fill-stretched.ts';
import { correctCameraSpace, placeDistort, type FxDistortTarget, type FxSpace, type FxSpriteBlend } from './buckets.ts';

const ORDER: Readonly<Record<FxSpriteBlend, number>> = { alpha: 40, add: 50, distort: 60 };

export interface FxStretchedBucketsOptions {
  readonly world: Object3D;
  readonly camera?: Object3D | null;
  /** as `FxSpriteBucketOptions.distort` (F3) */
  readonly distort?: FxDistortTarget;
  readonly distortEnabled?: boolean;
  readonly atlas: Texture;
  readonly capacity: number;
  readonly additiveFog: AdditiveFog;
  /** opt-in (`FxSystemOptions.alignedCards`): cards turned to the camera around their long axis, no full billboard. Default false */
  readonly alignedCards?: boolean;
}

/** a bucket is the fill's slot (three's instance matrices, rgba and cells) plus its mesh */
interface Bucket extends StretchedSlot {
  readonly mesh: InstancedMesh;
  readonly material: MeshBasicNodeMaterial;
  readonly attributes: readonly [InstancedBufferAttribute, InstancedBufferAttribute];
}

function mark(attribute: InstancedBufferAttribute, count: number): void {
  attribute.clearUpdateRanges();
  if (count > 0) attribute.addUpdateRange(0, count * attribute.itemSize);
  attribute.needsUpdate = true;
}

function makeBucket(options: FxStretchedBucketsOptions, blend: FxSpriteBlend, space: FxSpace): Bucket {
  const rgba = new InstancedBufferAttribute(new Float32Array(options.capacity * 4), 4).setUsage(DynamicDrawUsage);
  const cells = new InstancedBufferAttribute(new Float32Array(options.capacity), 1).setUsage(DynamicDrawUsage);
  const rgbaNode = instancedDynamicBufferAttribute(rgba, 'vec4') as Node<'vec4'>;
  const cellNode = instancedDynamicBufferAttribute(cells, 'float') as Node<'float'>;
  const cell = vec2(cellNode.mod(4), cellNode.div(4).floor());
  const sample = texture(options.atlas, uv().mul(0.25).add(cell.mul(0.25))) as Node<'vec4'>;
  const material = new MeshBasicNodeMaterial();
  material.name = `ss:fx:stretched:${space}:${blend}`;
  // the legacy host: a full billboard. It reads the mesh's world matrix, not the instance's, so the instance rotation and scale leak into
  // the "centre" and long axis cards smear into wide wedges; `alignedCards` composes the turned card on the CPU instead
  if (options.alignedCards !== true) material.vertexNode = billboarding({ horizontal: true, vertical: true });
  material.colorNode = (blend === 'distort'
    ? vec4(rgbaNode.x.mul(sample.a), rgbaNode.y.mul(sample.a), 0, sample.a)
    : sample.mul(rgbaNode)) as Node<'vec4'>;
  material.transparent = true;
  material.depthWrite = false;
  material.blending = blend === 'alpha' ? NormalBlending : AdditiveBlending;
  finishScriptedMaterial(material, blend === 'add' || blend === 'distort' ? { additiveFog: options.additiveFog } : {});

  const geometry = new PlaneGeometry(1, 1);
  const mesh = new InstancedMesh(geometry, material, options.capacity);
  mesh.name = `ss:fx:stretched:${space}:${blend}`;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = ORDER[blend];
  // a distort bucket with a distort target is placed by `placeDistort` at each update
  if (blend !== 'distort' || options.distort === undefined) (space === 'camera' && options.camera ? options.camera : options.world).add(mesh);
  return { blend, space, mesh, material, attributes: [rgba, cells], rgba: rgba.array as Float32Array, cells: cells.array as Float32Array, matrices: mesh.instanceMatrix.array as Float32Array, count: 0 };
}

const cameraInverse = new Float64Array(16);

/** Instanced quad buckets for velocity- and axis-stretched sprite sinks. */
export class FxStretchedBuckets {
  readonly #options: FxStretchedBucketsOptions;
  readonly #buckets = new Map<string, Bucket>();
  /** the distort-pass warm-up stand-ins (`armDistortWarm`), kept until dispose */
  readonly #distortWarm: Bucket[] = [];
  readonly #slots: StretchedSlots = {
    get: (key) => this.#buckets.get(key),
    make: (key, blend, space) => {
      const bucket = makeBucket(this.#options, blend, space);
      this.#buckets.set(key, bucket);
      return bucket;
    },
    values: () => this.#buckets.values(),
  };

  constructor(options: FxStretchedBucketsOptions) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) throw new RangeError('FX stretched capacity must be a positive integer');
    this.#options = options;
  }

  get(blend: FxSpriteBlend, space: FxSpace = 'world'): InstancedMesh | undefined { return this.#buckets.get(`${space}:${blend}`)?.mesh; }

  /** One stand-in mesh per (space, blend) `update` can draw into, for the shader warm-up (see `FxSpriteBuckets.warmProxies`). */
  warmProxies(): InstancedMesh[] {
    const spaces: FxSpace[] = this.#options.camera ? ['world', 'camera'] : ['world'];
    const blends: FxSpriteBlend[] = this.#options.distortEnabled === false ? ['alpha', 'add'] : ['alpha', 'add', 'distort'];
    const out: InstancedMesh[] = [];
    for (const space of spaces) {
      for (const blend of blends) {
        const mesh = makeBucket({ ...this.#options, capacity: 1 }, blend, space).mesh;
        mesh.removeFromParent();
        mesh.name = `ss:warm-up:${mesh.name}`;
        out.push(mesh);
      }
    }
    return out;
  }

  /** the aligned sprite sinks of `simulations` into the buckets, against the camera's matrix as it is now */
  update(simulations: Iterable<FxSimulation>): void {
    const camera = this.#options.camera;
    let inverse: Float64Array | null = null;
    if (camera) {
      camera.updateWorldMatrix(true, false);
      inverse = invertInto(camera.matrixWorld.elements, cameraInverse);
    }
    this.fill(Array.isArray(simulations) ? simulations : [...simulations], inverse);
  }

  /** the in-process fill (world/fill-stretched.ts) on three's arrays, then counts, ranges and visibility */
  fill(sims: readonly FxSimulation[], inverse: Float64Array | null): void {
    const camera = this.#options.camera ?? null;
    fillStretched(sims, { hasCamera: camera !== null, inverse, capacity: this.#options.capacity, distortEnabled: this.#options.distortEnabled !== false, alignedCards: this.#options.alignedCards === true, camera: camera?.matrixWorld.elements ?? null }, this.#slots);
    for (const bucket of this.#buckets.values()) this.#finish(bucket, bucket.space === 'camera' ? camera?.matrixWorld ?? null : null, null);
  }

  /** a result of the fx Worker (packed `[matrices | rgba | cells]`), copied into three's arrays; see `FxSpriteBuckets.apply` */
  apply(outs: readonly FxSpriteOut[], simCamera: Matrix4 | null, correction: Matrix4 | null): void {
    for (const o of outs) {
      const bucket = this.#buckets.get(o.key) ?? (this.#slots.make(o.key, o.blend, o.space) as Bucket);
      const n = Math.min(o.count, this.#options.capacity);
      bucket.count = n;
      const buf = o.buf;
      if (n > 0 && buf !== null) {
        bucket.matrices.set(buf.subarray(0, n * 16));
        bucket.rgba.set(buf.subarray(n * 16, n * 20));
        bucket.cells.set(buf.subarray(n * 20, n * 21));
      }
      this.#finish(bucket, bucket.space === 'camera' ? simCamera : null, correction);
    }
  }

  /** count, update ranges, visibility, the distort placement */
  #finish(bucket: Bucket, cameraMatrix: Matrix4 | null, correction: Matrix4 | null): void {
    bucket.mesh.count = bucket.count;
    bucket.mesh.visible = bucket.count > 0;
    bucket.mesh.frustumCulled = false;
    bucket.mesh.instanceMatrix.clearUpdateRanges();
    if (bucket.count > 0) bucket.mesh.instanceMatrix.addUpdateRange(0, bucket.count * 16);
    bucket.mesh.instanceMatrix.needsUpdate = true;
    for (const attr of bucket.attributes) mark(attr, bucket.count);
    if (bucket.blend === 'distort' && this.#options.distort !== undefined) {
      placeDistort(bucket.mesh, this.#options.distort, bucket.count, cameraMatrix);
    } else if (bucket.space === 'camera') correctCameraSpace(bucket.mesh, correction);
  }

  /** F3: the distort-pass warm-up stand-ins of the stretched quads (see `FxSpriteBuckets.armDistortWarm`) */
  armDistortWarm(scene: Object3D): { armed: boolean; done(): void } {
    if (this.#options.distortEnabled === false) return { armed: false, done: () => undefined };
    if (this.#distortWarm.length === 0) {
      const spaces: FxSpace[] = this.#options.camera ? ['world', 'camera'] : ['world'];
      for (const space of spaces) {
        const b = makeBucket({ ...this.#options, capacity: 1 }, 'distort', space);
        b.mesh.removeFromParent();
        b.mesh.name = `ss:warm-up:distort:${b.mesh.name}`;
        // one zero-size instance of zero offset: it writes nothing
        b.matrices.fill(0);
        b.mesh.count = 1;
        b.mesh.instanceMatrix.needsUpdate = true;
        for (const attr of b.attributes) mark(attr, 1);
        this.#distortWarm.push(b);
      }
    }
    for (const b of this.#distortWarm) {
      b.mesh.visible = true;
      scene.add(b.mesh);
    }
    return {
      armed: true,
      done: () => {
        for (const b of this.#distortWarm) {
          b.mesh.visible = false;
          b.mesh.removeFromParent();
        }
      },
    };
  }

  clear(): void {
    for (const bucket of this.#buckets.values()) {
      bucket.count = 0;
      bucket.mesh.count = 0;
      bucket.mesh.visible = false;
      bucket.mesh.instanceMatrix.clearUpdateRanges();
      for (const attr of bucket.attributes) mark(attr, 0);
      if (bucket.blend === 'distort' && this.#options.distort !== undefined) placeDistort(bucket.mesh, this.#options.distort, 0, null);
    }
  }

  dispose(): void {
    for (const bucket of [...this.#buckets.values(), ...this.#distortWarm]) {
      bucket.mesh.removeFromParent();
      bucket.mesh.geometry.dispose();
      bucket.material.dispose();
    }
    this.#buckets.clear();
    this.#distortWarm.length = 0;
  }
}
