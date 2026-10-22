// The three side of the fx (render §13.4; DR-53/DR-54; DESIGN §3, §11): the sprite, stretched-quad and mesh-sink buckets, the
// objects every frame's fx are drawn with. The in-process runtime fills them with the shared fills (`fillInline`); the worker
// facade copies a result of the fx Worker into them (`apply`). The buckets are made from the same factories either way, so
// the warm-up that links their programs before LOADING ends covers both (render §7.2: zero program creations after LOADING).
import { Matrix4, type Object3D, type Texture } from 'three/webgpu';
import type { AdditiveFog } from '../calibration.ts';
import type { LightingScript } from '../surface/script-types.ts';
import type { FxFrameOut } from './fx-protocol.ts';
import type { FxSimulation } from './sim/simulator.ts';
import { FxSpriteBuckets, type FxDistortTarget } from './render/buckets.ts';
import { FxStretchedBuckets } from './render/stretched-buckets.ts';
import { FxMeshBuckets } from './render/mesh-buckets.ts';
import { invertInto, multiplyInto } from './world/fx-math.ts';

export interface FxPresenterOptions {
  readonly world: Object3D;
  readonly camera?: Object3D | null;
  readonly distortScene?: FxDistortTarget;
  readonly distortEnabled: boolean;
  readonly atlas: Texture;
  /** the particle cap at construction */
  readonly capacity: number;
  readonly additiveFog: AdditiveFog;
  readonly alignedCards?: boolean;
  readonly lightsOnly?: boolean;
  readonly lighting?: LightingScript | null;
  readonly log?: (message: string) => void;
}

export class FxPresenter {
  readonly sprites: FxSpriteBuckets;
  readonly stretched: FxStretchedBuckets;
  readonly meshes: FxMeshBuckets;
  readonly #camera: Object3D | null;
  readonly #lightsOnly: boolean;
  readonly #inverse = new Float64Array(16);
  readonly #product = new Float64Array(16);
  readonly #simCamera = new Matrix4();
  readonly #correction = new Matrix4();
  readonly #identity = new Matrix4();

  constructor(o: FxPresenterOptions) {
    this.#camera = o.camera ?? null;
    this.#lightsOnly = o.lightsOnly === true;
    const renderOptions = {
      world: o.world,
      ...(o.camera === undefined ? {} : { camera: o.camera }),
      ...(o.distortScene === undefined ? {} : { distort: o.distortScene }),
      distortEnabled: o.distortEnabled,
      atlas: o.atlas,
      capacity: o.capacity,
      additiveFog: o.additiveFog,
      ...(o.alignedCards === undefined ? {} : { alignedCards: o.alignedCards }),
    };
    this.sprites = new FxSpriteBuckets(renderOptions);
    this.stretched = new FxStretchedBuckets(renderOptions);
    this.meshes = new FxMeshBuckets({
      world: o.world,
      ...(o.camera === undefined ? {} : { camera: o.camera }),
      capacity: o.capacity,
      ...(o.lighting === undefined ? {} : { lighting: o.lighting }),
      ...(o.log === undefined ? {} : { log: o.log }),
    });
  }

  /** the camera's world matrix now (after `updateWorldMatrix(true, false)`), or null without a camera */
  cameraMatrix(): Float64Array | null {
    const camera = this.#camera;
    if (camera === null) return null;
    camera.updateWorldMatrix(true, false);
    return Float64Array.from(camera.matrixWorld.elements);
  }

  /** the in-process frame: the shared fills on the buckets' own arrays, against the camera as it is now */
  fillInline(sims: readonly FxSimulation[], roughness: number): void {
    if (this.#lightsOnly) return;
    const camera = this.#camera;
    let inverse: Float64Array | null = null;
    if (camera !== null) {
      camera.updateWorldMatrix(true, false);
      inverse = invertInto(camera.matrixWorld.elements, this.#inverse);
    }
    this.sprites.fill(sims, inverse);
    this.stretched.fill(sims, inverse);
    this.meshes.fill(sims, inverse, roughness);
  }

  /**
   * A result of the fx world, simulated with the camera `simCamera` (its world matrix; null without a camera). The buckets of
   * camera space are drawn under the camera of this frame, so each gets inverse(camera now) · camera then (DESIGN §11).
   * `sameFrame`: the result was simulated in this very frame (the in-process fallback): the correction is the identity.
   */
  apply(out: FxFrameOut, simCamera: Float64Array | null, sameFrame = false): void {
    if (this.#lightsOnly) return;
    const camera = this.#camera;
    let sim: Matrix4 | null = null;
    let correction: Matrix4 | null = null;
    if (camera !== null && simCamera !== null) {
      sim = this.#simCamera.fromArray(simCamera);
      if (sameFrame) correction = this.#identity;
      else {
        camera.updateWorldMatrix(true, false);
        invertInto(camera.matrixWorld.elements, this.#inverse);
        correction = this.#correction.fromArray(multiplyInto(this.#inverse, simCamera, this.#product));
      }
    }
    this.sprites.apply(out.sprites, sim, correction);
    this.stretched.apply(out.stretched, sim, correction);
    this.meshes.apply(out.meshes, correction);
  }

  /** the warm-up's stand-ins of every sprite and stretched bucket (`FxRuntime.warmObjects`) */
  warmObjects(): Object3D[] {
    if (this.#lightsOnly) return [];
    return [...this.sprites.warmProxies(), ...this.stretched.warmProxies()];
  }

  /** F3: the distort sprites' stand-ins in the distort scene for the warm-up's closing render (`FxRuntime.armDistortWarm`) */
  armDistortWarm(scene: Object3D): { armed: boolean; done(): void } {
    if (this.#lightsOnly) return { armed: false, done: () => undefined };
    const a = this.sprites.armDistortWarm(scene);
    const b = this.stretched.armDistortWarm(scene);
    return { armed: a.armed || b.armed, done: () => { a.done(); b.done(); } };
  }

  dispose(): void {
    this.sprites.dispose();
    this.stretched.dispose();
    this.meshes.dispose();
  }
}
