// Controls the scene's shadow-casting spot slot. Its color, intensity, range, cone and pose come from a light record.
// Rows requesting a shadowed spot route here; other local lights remain in the light grid. Off keeps the slot dark
// without removing its identity from the scene. Tier changes resize or disable its shadow map.
// A persistent shadow node survives shadow-off material builds; warm-up helpers restore the active tier state.
import { PCFShadowMap, ShadowNode } from 'three/webgpu';
import type { SpotLight } from 'three/webgpu';
import type { Vec3 } from '../../compat/core/types.ts';
import type { Linear3 } from '../color/color.ts';
import { LAYER_SHADOW_PROXY, LAYER_THIRD_PERSON_ONLY, LAYER_WORLD } from '../scene/scene-root.ts';
import type { LightHandle, LightRecord, LightTable } from './light-table.ts';

/** shadow camera near plane in metres (render §8.4) */
export const SHADOW_CASTER_SHADOW_NEAR = 0.1;
/** depth bias of the shadow lookup (in shadow-map depth units) */
export const SHADOW_CASTER_SHADOW_BIAS = -0.0006;
/** metres the lookup is pushed off the receiver along its normal */
export const SHADOW_CASTER_SHADOW_NORMAL_BIAS = 0.04;
/** largest shadow map edge accepted (WebGL2 guarantees 2,048; the tier table uses 1,024 and 512) */
export const SHADOW_CASTER_SHADOW_MAX = 2048;

/** the handle `routeLights` gives the owner's beam */
export const SHADOW_CASTER_HANDLE = -1 as LightHandle;

/** True for the one record the permanent `SpotLight` draws: the owner's own beam. */
export function isShadowCasterRecord(rec: LightRecord): boolean {
  return rec.kind === 'spot' && rec.shadow === true && rec.source === 'row';
}

/**
 * The shadowCaster's shadow node, kept for the session (render §8.4 "tier switch"; R14b).
 *
 * three r186 disposes a light's shadow node when `castShadow` turns off: the light's next material build with the shadow off
 * calls `shadowNode.dispose()` (`AnalyticLightNode.setup`), which resets it: its depth target is freed, `shadowMap` is null,
 * and the shadow pass's material goes too (every caster's depth render object with it). The node builder states built while
 * the shadow was on stay cached (three keys them by the render object's cache key, and a body that was not drawn while the
 * shadow was off is never rebuilt), so when the shadow is on again such a body draws through the disposed node and
 * `ShadowNode.updateShadow` reads `shadowMap.depthTexture` of null: the frame throws [M, R14b wave 1: "Cannot read
 * properties of null (reading 'depthTexture')" after a shadow-off build; the same path as a governor drop to `low` followed
 * by the player's pick of `medium`]. three takes a custom node as `light.shadow.shadowNode` and hands that one node to every
 * build of the light, on and off; this one keeps itself whole when three disposes it, so a cached state's node is always a
 * working one and its depth programs stay. `release()` is the real dispose (the shadowCaster's own `dispose`). The depth map's
 * GPU memory is still freed on a tier without a shadow (`setShadowSize`): three creates it again on the next shadow render.
 */
export class PersistentShadowNode extends ShadowNode {
  #released = false;

  /** kept: three calls this on every build with the shadow off (see the class); `release()` disposes */
  override dispose(): void {
    // nothing: the node stays whole for the cached states that hold it
  }

  /** the real dispose: the depth target, the shadow pass's material, the node */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    super.dispose();
  }

  get released(): boolean {
    return this.#released;
  }
}

/** the custom shadow node seam of three's `LightShadow` (r186 `AnalyticLightNode.setupShadow` reads it; untyped in @types/three) */
interface ShadowNodeSeam {
  shadowNode?: unknown;
}

export interface ShadowCasterOptions {
  /** the scene root's permanent `SpotLight` (`SceneRoot.lights.shadowCaster`), its target already in the scene */
  light: SpotLight;
  /** the tier's `shadowCasterMapSize`; default 0 (no shadow) */
  shadowSize?: number;
}

/** `renderer.shadowMap` */
export interface ShadowMapHost {
  shadowMap: { enabled: boolean; type: number };
}

export interface ShadowCasterControl {
  readonly light: SpotLight;
  /** the beam is lit (intensity > 0) */
  readonly on: boolean;
  /** the shadow map's edge in texels; 0 = no shadow on this tier */
  readonly shadowSize: number;
  /** Shadows on, `PCFShadowMap`. Once per renderer, also for one rebuilt after a device loss. */
  bindRenderer(renderer: ShadowMapHost): void;
  /** The owner's beam row: its numbers and pose go to the spot. `null`: no beam (intensity 0). */
  set(rec: Readonly<LightRecord> | null): void;
  /** 0 is off */
  setIntensity(v: number): void;
  /** linear */
  setColor(c: Readonly<Linear3>): void;
  /** World position and the world point the beam aims at (the bridge's `ShadowSpotSink`); a target on the light keeps the aim. */
  setPose(position: Readonly<Vec3>, target: Readonly<Vec3>): void;
  /** The same by direction: `direction` is light − target, any length (a light record's); a zero direction keeps the aim. */
  setAim(position: Readonly<Vec3>, direction?: Readonly<Vec3>): void;
  /** no beam: intensity 0 (the row is gone, or its light was set to null) */
  off(): void;
  /** Returns true when the shadow went on or off: lit programs change once, the caller holds a frame. */
  setShadowSize(size: number): boolean;
  setShadowTier(tier: { readonly shadowCasterMapSize: number }): boolean;
  /** Runs `fn` with `castShadow` forced to `on` (the warm-up's real shadow render), then restores the tier's state. */
  withShadow<T>(on: boolean, fn: () => T): T;
  /**
   * `withShadow` across an async pass (R14b: the warm-up of the shadow state the tier is not in, behind the LOADING hold):
   * `castShadow` is `on` until `fn` settles, then the tier's state again. A pass that forced the shadow on for a tier without
   * one frees the depth map it drew into.
   */
  whileShadow<T>(on: boolean, fn: () => Promise<T>): Promise<T>;
  /** the shadow node every build of the light uses (`light.shadow.shadowNode`, see `PersistentShadowNode`) */
  readonly shadowNode: PersistentShadowNode;
  /** dark, no shadow, the depth map freed, the shadow node released; the light itself belongs to the scene root and stays */
  dispose(): void;
}

const lit = (v: number): number => (v > 0 && Number.isFinite(v) ? v : 0);

export function createShadowCaster(opts: ShadowCasterOptions): ShadowCasterControl {
  const { light } = opts;
  const { shadow } = light;
  let shadowSize = 0;
  // unit, light − target
  let dx = 0;
  let dy = 0;
  let dz = 1;

  // the shadow camera: the world, the hidden local body and the shadow proxies. three's shadow pass uses this mask as soon as
  // it holds a layer beyond 0 (`ShadowNode.updateShadow`)
  shadow.camera.layers.enable(LAYER_WORLD);
  shadow.camera.layers.enable(LAYER_THIRD_PERSON_ONLY);
  shadow.camera.layers.enable(LAYER_SHADOW_PROXY);
  shadow.camera.near = SHADOW_CASTER_SHADOW_NEAR;
  shadow.camera.updateProjectionMatrix();
  shadow.bias = SHADOW_CASTER_SHADOW_BIAS;
  shadow.normalBias = SHADOW_CASTER_SHADOW_NORMAL_BIAS;
  shadow.autoUpdate = true;

  // one shadow node for every build of the light, never disposed by a shadow-off build (`PersistentShadowNode`); a second
  // shadowCaster on the same light keeps the node the first one gave it
  const seam = shadow as unknown as ShadowNodeSeam;
  const given = seam.shadowNode;
  const shadowNode = given instanceof PersistentShadowNode && !given.released ? given : new PersistentShadowNode(light, shadow);
  seam.shadowNode = shadowNode;

  const aim = (): void => {
    light.target.position.set(light.position.x - dx, light.position.y - dy, light.position.z - dz);
  };

  const freeMap = (): void => {
    // the depth target is three's (`ShadowNode` keeps it and re-creates its GPU side when the shadow is drawn again)
    (shadow.map as { dispose(): void } | null)?.dispose();
  };

  const control: ShadowCasterControl = {
    light,
    get on(): boolean {
      return light.intensity > 0;
    },
    get shadowSize(): number {
      return shadowSize;
    },

    bindRenderer(renderer: ShadowMapHost): void {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = PCFShadowMap;
    },

    set(rec: Readonly<LightRecord> | null): void {
      if (rec === null) {
        light.intensity = 0;
        return;
      }
      light.color.setRGB(rec.color[0], rec.color[1], rec.color[2]);
      light.intensity = lit(rec.intensity);
      light.distance = rec.distance > 0 && Number.isFinite(rec.distance) ? rec.distance : 0;
      light.decay = Number.isFinite(rec.decay) ? rec.decay : 2;
      if (typeof rec.angle === 'number' && Number.isFinite(rec.angle)) light.angle = rec.angle;
      light.penumbra = typeof rec.penumbra === 'number' && Number.isFinite(rec.penumbra) ? rec.penumbra : 0;
      control.setAim(rec.position, rec.direction);
    },

    setIntensity(v: number): void {
      light.intensity = lit(v);
    },

    setColor(c: Readonly<Linear3>): void {
      light.color.setRGB(c[0], c[1], c[2]);
    },

    setPose(position: Readonly<Vec3>, target: Readonly<Vec3>): void {
      control.setAim(position, { x: position.x - target.x, y: position.y - target.y, z: position.z - target.z });
    },

    off(): void {
      light.intensity = 0;
    },

    setAim(position: Readonly<Vec3>, direction?: Readonly<Vec3>): void {
      light.position.set(position.x, position.y, position.z);
      if (direction !== undefined) {
        const len = Math.hypot(direction.x, direction.y, direction.z);
        if (len > 0 && Number.isFinite(len)) {
          dx = direction.x / len;
          dy = direction.y / len;
          dz = direction.z / len;
        }
      }
      aim();
    },

    setShadowSize(size: number): boolean {
      if (!Number.isInteger(size) || size < 0 || size > SHADOW_CASTER_SHADOW_MAX) {
        throw new RangeError(`shadowCaster: the shadow map size must be an integer in 0..${SHADOW_CASTER_SHADOW_MAX}, got ${String(size)}`);
      }
      const was = shadowSize > 0;
      shadowSize = size;
      const now = size > 0;
      if (now) shadow.mapSize.set(size, size);
      light.castShadow = now;
      if (was && !now) freeMap();
      return was !== now;
    },

    setShadowTier(tier: { readonly shadowCasterMapSize: number }): boolean {
      return control.setShadowSize(tier.shadowCasterMapSize);
    },

    withShadow<T>(on: boolean, fn: () => T): T {
      light.castShadow = on;
      try {
        return fn();
      } finally {
        light.castShadow = shadowSize > 0;
      }
    },

    async whileShadow<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
      light.castShadow = on;
      try {
        return await fn();
      } finally {
        // the tier's state, also when a tier switch came in while the pass ran
        const tierOn = shadowSize > 0;
        light.castShadow = tierOn;
        if (on && !tierOn) freeMap();
      }
    },

    shadowNode,

    dispose(): void {
      light.intensity = 0;
      light.castShadow = false;
      shadowSize = 0;
      freeMap();
      shadowNode.release();
      if (seam.shadowNode === shadowNode) delete seam.shadowNode;
    },
  };

  aim();
  control.setShadowSize(opts.shadowSize ?? 0);
  return control;
}

/**
 * A `LightTable` that sends the owner's own beam to the shadowCaster (handle `SHADOW_CASTER_HANDLE`) and everything else to
 * `table`. One own beam exists at a time (the local player's); a second `add` of one replaces the first.
 */
export function routeLights(table: LightTable, shadowCaster: ShadowCasterControl): LightTable {
  return {
    add(rec: LightRecord): LightHandle {
      if (!isShadowCasterRecord(rec)) return table.add(rec);
      shadowCaster.set(rec);
      return SHADOW_CASTER_HANDLE;
    },
    remove(h: LightHandle): void {
      if (h === SHADOW_CASTER_HANDLE) shadowCaster.off();
      else table.remove(h);
    },
    setIntensity(h: LightHandle, v: number): void {
      if (h === SHADOW_CASTER_HANDLE) shadowCaster.setIntensity(v);
      else table.setIntensity(h, v);
    },
    setColor(h: LightHandle, c: Linear3): void {
      if (h === SHADOW_CASTER_HANDLE) shadowCaster.setColor(c);
      else table.setColor(h, c);
    },
    setPose(h: LightHandle, p: Vec3, dir?: Vec3): void {
      if (h === SHADOW_CASTER_HANDLE) shadowCaster.setAim(p, dir);
      else table.setPose(h, p, dir);
    },
    upload(camera): void {
      table.upload(camera);
    },
  };
}
