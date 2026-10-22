// Stable scene graph, neutral light slots, fog and background seams. The light set stays fixed because three.js
// includes light identity and shadow state in its material cache key. Authored records supply light poses and values.
// Ambient, hemisphere, two directional slots and one shadow-casting spot start dark. Other lights use the grid.
// Coordinates are right-handed, +Y up, with cameras looking down -Z. The viewmodel draws before world opaques.
import { AmbientLight, DirectionalLight, Fog, FogExp2, Group, HemisphereLight, Scene, SpotLight } from 'three/webgpu';
import type { Light, Lighting, Node, Object3D } from 'three/webgpu';

/** layer 0: the world */
export const LAYER_WORLD = 0;
/**
 * layer 1: `hideLocalPlayer` and `visibleInFirstPerson: false` rows (render §4.4): excluded from the world camera while the
 * local view is first person, included in the downed spectator view; the shadowCaster's shadow camera always sees it.
 */
export const LAYER_THIRD_PERSON_ONLY = 1;
/** layer 2: shadow-only proxies (LOD-5 hulls drawn into the shadowCaster shadow map only, render §8.4) */
export const LAYER_SHADOW_PROXY = 2;

/** `renderOrder` of the viewmodel's opaque meshes: first among opaques, so early-z rejects the world behind the gun (D7) */
export const VIEWMODEL_RENDER_ORDER = -100;

export interface PermanentLights {
  readonly ambient: AmbientLight;
  readonly hemisphere: HemisphereLight;
  /** the two moon rows; intensity 0 when a map has none */
  /** Neutral slots; light records supply their colour, pose and intensity. */
  readonly directionals: readonly [DirectionalLight, DirectionalLight];
  readonly shadowCaster: SpotLight;
  /** the five, in scene order */
  readonly all: readonly Light[];
}

/**
 * K14: the scene's fog type, chosen once when the root is made (three keys programs on the fog's type, so a swap at runtime
 * would recompile every material). 'exp2' is the legacy host's `FogExp2`; 'linear' is three's `Fog` with `near` / `far`.
 */
export type FogModel = 'exp2' | 'linear';

/** K14: the sun's shadow (a daylight world); the shadow state is in three's program key, so it is chosen once, here */
export interface SunShadowOptions {
  /** which permanent directional light is the sun (default 0) */
  slot?: 0 | 1;
  /** shadow map edge in texels (default 2048) */
  mapSize?: number;
  /** half-width of the orthographic shadow frustum in world units around the sun's focus (default 40) */
  extent?: number;
}

export interface SceneRootOptions {
  /** default 'exp2' */
  fogModel?: FogModel;
  /** K14: absent / false = no sun shadow; true = the defaults of `SunShadowOptions` */
  sunShadow?: boolean | SunShadowOptions;
}

/** the sun shadow's defaults */
export const SUN_SHADOW_DEFAULTS = Object.freeze({ mapSize: 2048, extent: 40, near: 0.5, bias: -0.0004, normalBias: 0.03 });

/** a linear fog that fogs nothing: the distances are far past any camera `far` */
export const LINEAR_FOG_OFF = Object.freeze({ near: 1e7, far: 2e7 });

export interface SceneRoot {
  readonly scene: Scene;
  /** parent of everything a place builds (map batches, rows, fx); the permanent lights sit beside it */
  readonly world: Group;
  /** the one fog: mutate `color` (linear, `setRGB`) and `density`, never replace it */
  readonly fog: FogExp2;
  readonly fogModel: FogModel;
  /** K14: the scene's fog when `fogModel` is 'linear' (then `scene.fog` is this and `fog` above is an unattached density holder); else null */
  readonly linearFog: Fog | null;
  readonly lights: PermanentLights;
  /** the lighting system installed on the renderer; null until R1b's `GridLighting` lands */
  readonly lighting: Lighting | null;
  /**
   * `renderer.lighting = lighting` (render §8.2). Given once by the lighting package; called again without an argument for a
   * rebuilt renderer (device loss, X3), which gets the same instance.
   */
  installLighting(renderer: { lighting: Lighting }, lighting?: Lighting): void;
  /** the sky (render §9.2); null = the clear colour */
  setBackgroundNode(node: Node | null): void;
  /** detaches the place content; the permanent lights stay (they live as long as the root) */
  dispose(): void;
}

export function createSceneRoot(opts: SceneRootOptions = {}): SceneRoot {
  const fogModel: FogModel = opts.fogModel === 'linear' ? 'linear' : 'exp2';
  const scene = new Scene();
  scene.name = 'ss:scene';

  const fog = new FogExp2(0x000000, 0);
  const linearFog = fogModel === 'linear' ? new Fog(0x000000, LINEAR_FOG_OFF.near, LINEAR_FOG_OFF.far) : null;
  scene.fog = linearFog ?? fog;

  const ambient = new AmbientLight(0xffffff, 0);
  ambient.name = 'ss:ambient';
  const hemisphere = new HemisphereLight(0xffffff, 0x000000, 0);
  hemisphere.name = 'ss:hemisphere';
  const moon = (i: number): DirectionalLight => {
    const l = new DirectionalLight(0xffffff, 0);
    l.name = `ss:moon${i}`;
    l.target.name = `ss:moon${i}:target`;
    return l;
  };
  const moons: readonly [DirectionalLight, DirectionalLight] = [moon(0), moon(1)];
  const shadowCaster = new SpotLight(0xffffff, 0);
  shadowCaster.name = 'ss:shadowCaster';
  shadowCaster.target.name = 'ss:shadowCaster:target';
  // its shadow pass uses the shadow camera's own mask once it holds layers beyond 0 (three ShadowNode), so the hidden local
  // body (layer 1) and the shadow proxies (layer 2) cast while the world camera does not draw them
  shadowCaster.shadow.camera.layers.enable(LAYER_WORLD);
  shadowCaster.shadow.camera.layers.enable(LAYER_THIRD_PERSON_ONLY);
  shadowCaster.shadow.camera.layers.enable(LAYER_SHADOW_PROXY);

  const all: readonly Light[] = Object.freeze([ambient, hemisphere, moons[0], moons[1], shadowCaster]);
  for (const l of all) {
    l.castShadow = false; // the shadowCaster's shadow is switched on by its owner (R1b) from the tier, before the first compile
    scene.add(l);
  }
  // K14: the sun's shadow, on from creation so the light set's program key never changes (shadow state is part of it)
  if (opts.sunShadow !== undefined && opts.sunShadow !== false) {
    const o: SunShadowOptions = opts.sunShadow === true ? {} : opts.sunShadow;
    const sun = moons[o.slot === 1 ? 1 : 0];
    const extent = o.extent !== undefined && o.extent > 0 ? o.extent : SUN_SHADOW_DEFAULTS.extent;
    const size = o.mapSize !== undefined && o.mapSize > 0 ? Math.round(o.mapSize) : SUN_SHADOW_DEFAULTS.mapSize;
    sun.castShadow = true;
    sun.shadow.mapSize.set(size, size);
    sun.shadow.bias = SUN_SHADOW_DEFAULTS.bias;
    sun.shadow.normalBias = SUN_SHADOW_DEFAULTS.normalBias;
    const cam = sun.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = SUN_SHADOW_DEFAULTS.near;
    cam.far = 300;
    cam.updateProjectionMatrix();
    // as the shadowCaster's: three's shadow pass falls back to the world camera's mask while the shadow camera holds layer 0
    // alone, and that mask leaves out the shadow proxies (layer 2), through which every batched map row casts
    cam.layers.enable(LAYER_WORLD);
    cam.layers.enable(LAYER_THIRD_PERSON_ONLY);
    cam.layers.enable(LAYER_SHADOW_PROXY);
  }
  // a light's direction is position → target: the targets need a place in the graph for their world matrices to update
  scene.add(moons[0].target, moons[1].target, shadowCaster.target);

  const world = new Group();
  world.name = 'ss:world';
  scene.add(world);

  let lighting: Lighting | null = null;

  return {
    scene,
    world,
    fog,
    fogModel,
    linearFog,
    lights: Object.freeze({ ambient, hemisphere, directionals: moons, shadowCaster: shadowCaster, all }),
    get lighting(): Lighting | null {
      return lighting;
    },
    installLighting(renderer, next) {
      if (next !== undefined) lighting = next;
      if (lighting !== null) renderer.lighting = lighting;
    },
    setBackgroundNode(node) {
      scene.backgroundNode = node;
    },
    dispose() {
      world.clear();
    },
  };
}

/**
 * Static objects (render §4.1): `matrixAutoUpdate = false` after one `updateMatrix()`, and for the subtree
 * `matrixWorldAutoUpdate = false` after its first world update, so three's per-frame traversal skips them. Call it once the
 * object is placed and parented; moving rows keep the defaults.
 */
export function markStatic(root: Object3D): void {
  root.traverse((o) => {
    o.updateMatrix();
    o.matrixAutoUpdate = false;
  });
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    o.matrixWorldAutoUpdate = false;
  });
}
