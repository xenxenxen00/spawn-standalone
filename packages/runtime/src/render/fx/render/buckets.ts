import { instancedDynamicBufferAttribute, texture, uv, vec2, vec4 } from 'three/tsl';
import { AdditiveBlending, DynamicDrawUsage, InstancedBufferAttribute, NormalBlending, Sprite, SpriteNodeMaterial } from 'three/webgpu';
import type { Matrix4, Node, Object3D, Texture } from 'three/webgpu';
import type { AdditiveFog } from '../../calibration.ts';
import { finishScriptedMaterial } from '../../surface/scripted-material.ts';
import type { FxSimulation } from '../sim/simulator.ts';
import type { FxSpace, FxSpriteBlend, FxSpriteOut } from '../fx-protocol.ts';
import { invertInto } from '../world/fx-math.ts';
import { SORT_LIMIT, fillSprites, type SpriteSlot, type SpriteSlots } from '../world/fill-sprites.ts';

export type { FxSpace, FxSpriteBlend } from '../fx-protocol.ts';
// the alpha bucket's key sort lives with the fill (world/fill-sprites.ts), which the fx Worker runs too
export { backToFront } from '../world/fill-sprites.ts';

const RENDER_ORDER: Readonly<Record<FxSpriteBlend, number>> = { alpha: 40, add: 50, distort: 60 };

export interface FxSpriteBucketOptions {
  readonly world: Object3D;
  readonly camera?: Object3D | null;
  /**
   * the post pipeline's offset-only scene, for distortion effects; a getter is read on every flush (the pipeline is built
   * after the fx runtime and its scene may be absent). With one, a distort bucket sits in that scene only while it holds
   * particles (an empty distort scene lets the pass skip its draw) and draws nothing while there is none. Undefined: the
   * distort buckets stay with the others.
   */
  readonly distort?: FxDistortTarget;
  readonly distortEnabled?: boolean;
  readonly atlas: Texture;
  readonly capacity: number;
  readonly additiveFog: AdditiveFog;
}

export type FxDistortTarget = Object3D | null | (() => Object3D | null);

const distortOf = (target: FxDistortTarget | undefined): Object3D | null => (typeof target === 'function' ? target() : target ?? null);

/**
 * F3: puts a distort bucket's object in the distort scene while it draws something and takes it out when it does not. A
 * camera-space bucket holds camera-local positions: in the distort scene (no camera parent) its matrix is the camera's world
 * matrix (`camera`: the camera of the frame the positions were made with), so it lands where it would under the camera.
 */
export function placeDistort(object: Object3D, target: FxDistortTarget | undefined, count: number, camera: Matrix4 | null): void {
  const scene = count > 0 ? distortOf(target) : null;
  if (scene === null) {
    if (object.parent !== null) object.removeFromParent();
    return;
  }
  if (object.parent !== scene) scene.add(object);
  if (camera !== null) {
    object.matrixAutoUpdate = false;
    object.matrix.copy(camera);
    object.matrixWorldNeedsUpdate = true;
  }
}

/**
 * The fx Worker's camera-space buckets (DESIGN §11): their positions are local to the camera of the frame the worker
 * simulated, drawn under the camera of a later frame. `correction` = inverse(camera now) · camera then puts them where they
 * belong: the drawn world matrix is camera now · correction = camera then. Null (the in-process runtime): left alone.
 */
export function correctCameraSpace(object: Object3D, correction: Matrix4 | null): void {
  if (correction === null) return;
  object.matrixAutoUpdate = false;
  object.matrix.copy(correction);
  object.matrixWorldNeedsUpdate = true;
}

/** a bucket is the fill's slot (three's attribute arrays) plus its sprite */
interface Bucket extends SpriteSlot {
  readonly sprite: Sprite;
  readonly material: SpriteNodeMaterial;
  readonly attributes: readonly [InstancedBufferAttribute, InstancedBufferAttribute, InstancedBufferAttribute, InstancedBufferAttribute, InstancedBufferAttribute];
}

const dynamicAttribute = (capacity: number, itemSize: number): InstancedBufferAttribute => {
  const attr = new InstancedBufferAttribute(new Float32Array(capacity * itemSize), itemSize);
  attr.setUsage(DynamicDrawUsage);
  return attr;
};

const mark = (attr: InstancedBufferAttribute, count: number): void => {
  attr.clearUpdateRanges();
  if (count > 0) attr.addUpdateRange(0, count * attr.itemSize);
  attr.needsUpdate = true;
};

function makeBucket(options: FxSpriteBucketOptions, blend: FxSpriteBlend, space: FxSpace): Bucket {
  const { capacity } = options;
  const p = dynamicAttribute(capacity, 3);
  const s = dynamicAttribute(capacity, 2);
  const r = dynamicAttribute(capacity, 1);
  const c = dynamicAttribute(capacity, 4);
  const t = dynamicAttribute(capacity, 1);
  const posNode = instancedDynamicBufferAttribute(p, 'vec3') as Node<'vec3'>;
  const scaleNode = instancedDynamicBufferAttribute(s, 'vec2') as Node<'vec2'>;
  const rotationNode = instancedDynamicBufferAttribute(r, 'float') as Node<'float'>;
  const rgbaNode = instancedDynamicBufferAttribute(c, 'vec4') as Node<'vec4'>;
  const cellNode = instancedDynamicBufferAttribute(t, 'float') as Node<'float'>;
  const cell = vec2(cellNode.mod(4), cellNode.div(4).floor());
  const sample = texture(options.atlas, uv().mul(0.25).add(cell.mul(0.25))) as Node<'vec4'>;
  const material = new SpriteNodeMaterial();
  material.name = `ss:fx:${space}:${blend}`;
  material.positionNode = posNode;
  material.scaleNode = scaleNode;
  material.rotationNode = rotationNode;
  material.colorNode = (blend === 'distort'
    ? vec4(rgbaNode.x.mul(sample.a), rgbaNode.y.mul(sample.a), 0, sample.a)
    : sample.mul(rgbaNode)) as Node<'vec4'>;
  material.transparent = true;
  material.depthWrite = false;
  material.blending = blend === 'alpha' ? NormalBlending : AdditiveBlending;
  finishScriptedMaterial(material, blend === 'add' || blend === 'distort' ? { additiveFog: options.additiveFog } : {});
  const sprite = new Sprite(material);
  sprite.name = `ss:fx:${space}:${blend}`;
  sprite.count = 0;
  sprite.visible = false;
  sprite.frustumCulled = false;
  sprite.renderOrder = RENDER_ORDER[blend];
  // a distort bucket with a distort target is placed by `placeDistort` at each flush
  if (blend !== 'distort' || options.distort === undefined) (space === 'camera' && options.camera ? options.camera : options.world).add(sprite);
  const n = capacity;
  const depths = new Float32Array(n);
  return {
    blend, space, sprite, material,
    positions: p.array as Float32Array,
    scales: s.array as Float32Array,
    rotations: r.array as Float32Array,
    rgba: c.array as Float32Array,
    cells: t.array as Float32Array,
    depths,
    depthBits: new Uint32Array(depths.buffer),
    keys: new Float64Array(blend === 'alpha' ? Math.min(n, SORT_LIMIT) : 0),
    order: Array.from({ length: n }, (_, i) => i),
    scratch: [new Float32Array(n * 3), new Float32Array(n * 2), new Float32Array(n), new Float32Array(n * 4), new Float32Array(n)],
    attributes: [p, s, r, c, t],
    count: 0,
  };
}

const cameraInverse = new Float64Array(16);

/** One instanced Sprite per (space, blend, atlas) tuple; only live prefixes are uploaded. */
export class FxSpriteBuckets {
  readonly #options: FxSpriteBucketOptions;
  readonly #buckets = new Map<string, Bucket>();
  /** the distort-pass warm-up stand-ins (`armDistortWarm`), kept until dispose */
  readonly #distortWarm: Bucket[] = [];
  /** the buckets as the fill's slots (world/fill-sprites.ts): three's arrays, capacity-sized */
  readonly #slots: SpriteSlots = {
    get: (key) => this.#buckets.get(key),
    make: (key, blend, space) => {
      const bucket = makeBucket(this.#options, blend, space);
      this.#buckets.set(key, bucket);
      return bucket;
    },
    values: () => this.#buckets.values(),
  };

  constructor(options: FxSpriteBucketOptions) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) throw new RangeError('FX sprite capacity must be a positive integer');
    this.#options = options;
  }

  get(blend: FxSpriteBlend, space: FxSpace = 'world'): Sprite | undefined {
    return this.#buckets.get(`${space}:${blend}`)?.sprite;
  }

  /**
   * One stand-in sprite per (space, blend) `update` can draw into, built as its bucket is but for one particle and in no
   * parent, for the shader warm-up to compile before the first effect needs the program (render §7.2: an effect is first
   * seen at PREP or in the wave). The program text depends on neither the capacity nor the material instance
   * (engine/stable-programs.ts), so the real bucket made later draws with it. Never dispose their materials: a program is
   * freed with its last user.
   */
  warmProxies(): Sprite[] {
    const spaces: FxSpace[] = this.#options.camera ? ['world', 'camera'] : ['world'];
    const blends: FxSpriteBlend[] = this.#options.distortEnabled === false ? ['alpha', 'add'] : ['alpha', 'add', 'distort'];
    const out: Sprite[] = [];
    for (const space of spaces) {
      for (const blend of blends) {
        const sprite = makeBucket({ ...this.#options, capacity: 1 }, blend, space).sprite;
        sprite.removeFromParent();
        sprite.name = `ss:warm-up:${sprite.name}`;
        out.push(sprite);
      }
    }
    return out;
  }

  /** the particles of `simulations` into the buckets, against the camera's matrix as it is now */
  update(simulations: Iterable<FxSimulation>): void {
    const camera = this.#options.camera;
    let inverse: Float64Array | null = null;
    if (camera) {
      camera.updateWorldMatrix(true, false);
      inverse = invertInto(camera.matrixWorld.elements, cameraInverse);
    }
    this.fill(Array.isArray(simulations) ? simulations : [...simulations], inverse);
  }

  /**
   * The in-process fill: the shared fill (world/fill-sprites.ts) on three's own arrays, then each bucket's count, update
   * ranges and visibility. `inverse`: the inverse of the camera's world matrix (null without a camera).
   */
  fill(sims: readonly FxSimulation[], inverse: Float64Array | null): void {
    const camera = this.#options.camera ?? null;
    fillSprites(sims, { hasCamera: camera !== null, inverse, capacity: this.#options.capacity, distortEnabled: this.#options.distortEnabled !== false }, this.#slots);
    for (const bucket of this.#buckets.values()) this.#finish(bucket, bucket.space === 'camera' ? camera?.matrixWorld ?? null : null, null);
  }

  /**
   * A result of the fx Worker: each bucket's live prefixes (packed `[positions | scales | rotations | rgba | cells]`) copied
   * into three's arrays, then counts, ranges and visibility. `simCamera`: the world matrix of the camera the worker simulated
   * with (where a camera-space distort bucket goes); `correction`: see `correctCameraSpace`.
   */
  apply(outs: readonly FxSpriteOut[], simCamera: Matrix4 | null, correction: Matrix4 | null): void {
    for (const o of outs) {
      const bucket = this.#buckets.get(o.key) ?? this.#slots.make(o.key, o.blend, o.space) as Bucket;
      const n = Math.min(o.count, this.#options.capacity);
      bucket.count = n;
      const buf = o.buf;
      if (n > 0 && buf !== null) {
        bucket.positions.set(buf.subarray(0, n * 3));
        bucket.scales.set(buf.subarray(n * 3, n * 5));
        bucket.rotations.set(buf.subarray(n * 5, n * 6));
        bucket.rgba.set(buf.subarray(n * 6, n * 10));
        bucket.cells.set(buf.subarray(n * 10, n * 11));
      }
      this.#finish(bucket, bucket.space === 'camera' ? simCamera : null, correction);
    }
  }

  clear(): void {
    for (const bucket of this.#buckets.values()) {
      bucket.count = 0;
      bucket.sprite.count = 0;
      bucket.sprite.visible = false;
      for (const attr of bucket.attributes) mark(attr, 0);
      if (bucket.blend === 'distort' && this.#options.distort !== undefined) placeDistort(bucket.sprite, this.#options.distort, 0, null);
    }
  }

  dispose(): void {
    for (const bucket of [...this.#buckets.values(), ...this.#distortWarm]) {
      bucket.sprite.removeFromParent();
      bucket.material.dispose();
    }
    this.#buckets.clear();
    this.#distortWarm.length = 0;
  }

  /** the legacy `#flush` after its sort (the fill sorted): count, update ranges, visibility, the distort placement */
  #finish(bucket: Bucket, cameraMatrix: Matrix4 | null, correction: Matrix4 | null): void {
    const count = bucket.count;
    bucket.sprite.count = count;
    bucket.sprite.visible = count > 0;
    for (const attr of bucket.attributes) mark(attr, count);
    if (bucket.blend === 'distort' && this.#options.distort !== undefined) {
      placeDistort(bucket.sprite, this.#options.distort, count, cameraMatrix);
    } else if (bucket.space === 'camera') correctCameraSpace(bucket.sprite, correction);
  }

  /**
   * F3: the distort-pass warm-up. The distort pass draws into its own RG target, so a distort sprite's program there is
   * linked only by that pass (as the shockwave's offset ring, `ShockwaveRenderer.armDistortWarm`). This puts one stand-in per
   * space, one zero-size particle of zero offset each (it writes nothing), in `scene` for the warm-up's closing render of the
   * pipeline; `done()` takes them out. The stand-ins are made once and kept (never disposed before the buckets are: a
   * program is freed with its last user, and the real bucket made later must find it linked). Nothing happens without the
   * distortion tier.
   */
  armDistortWarm(scene: Object3D): { armed: boolean; done(): void } {
    if (this.#options.distortEnabled === false) return { armed: false, done: () => undefined };
    if (this.#distortWarm.length === 0) {
      const spaces: FxSpace[] = this.#options.camera ? ['world', 'camera'] : ['world'];
      for (const space of spaces) {
        const b = makeBucket({ ...this.#options, capacity: 1 }, 'distort', space);
        b.sprite.removeFromParent();
        b.sprite.name = `ss:warm-up:distort:${b.sprite.name}`;
        b.sprite.count = 1;
        for (const attr of b.attributes) mark(attr, 1);
        this.#distortWarm.push(b);
      }
    }
    for (const b of this.#distortWarm) {
      b.sprite.visible = true;
      scene.add(b.sprite);
    }
    return {
      armed: true,
      done: () => {
        for (const b of this.#distortWarm) {
          b.sprite.visible = false;
          b.sprite.removeFromParent();
        }
      },
    };
  }
}
