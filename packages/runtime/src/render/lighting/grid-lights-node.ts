// GridLighting / GridLightsNode and the two light data nodes (docs/design/rendering.md §8.2, Appendix B.2, B.3; D3; WP R1b).
//
// `renderer.lighting = new GridLighting()` (through `SceneRoot.installLighting`). Its `createNode(lights)` returns a
// `GridLightsNode`, which gives three its own light nodes for the five permanent three lights (ambient, hemisphere, two
// moons, the shadowCaster with its shadow) and adds two data nodes:
//
//   grid node      one `Loop` over the list of the cell the fragment's world position falls in (light-grid.ts)
//   dynamic node   one `Loop` over the dynamic block of the light texture, `dynamicCount` long (dynamic-lights.ts)
//
// Each iteration reads the light's four texels (light-table.ts), rejects it by range after the first one, and calls
// `lightingModel.direct()` with a loop-local accumulator, which is added to three's `reflectedLight` after the loop: the
// pattern of three's own `DynamicLightsNode` / `SpotLightDataNode` (three/examples/jsm/tsl/lighting/). The lighting model is
// `ScriptLightingModel` (the live `scripts/lighting.js`), which adds to the accumulator it is handed.
//
// **The shader never changes** with the lights: lamps that flicker, die or black out, fx lights that pop, a tier's caps and
// a new place are texels, uniforms and texture bindings. `customCacheKey()` adds a constant to three's key for the permanent
// lights, so a material compiled with 8 lights in the table is the material used with 48.
//
// The radiance pieces (render §8.1, B.3):
//   distance   three's `getDistanceAttenuation`: 1 / max(d^decay, 0.01) · (cutoff > 0 ? saturate(1 − (d / cutoff)⁴)² : 1)
//   cone       `ssSmoothstep(cos(angle), cos(angle · (1 − penumbra)), cos θ)`: t² (3 − 2t), t = clamp((x − e0) / (e1 − e0), 0, 1),
//              the WGSL definition Spawn's WebGPU renderer ran. GLSL leaves `smoothstep` undefined for e0 ≥ e1, and the live
//              map spots (angle 38 and 40, read as radians) have exactly those edges: the inverted cones are the live look
//              (FX-25). Equal edges give step(e0, x). Written with arithmetic masks, never `select()`: three emits an
//              expression inside the first block that uses it (the hazard R1a measured).
//   point      a point light's texels hold the edges (−2, −1), for which the cone term is 1: no branch on the kind.
//
// This relies on three internals (render §20 risk 2): `builder.context.{lightingModel, reflectedLight, positionView}`,
// `LightsNode#setupLightsNode` passing node-valued entries through, and the `start → lights → indirect` order. The browser
// specs (tests/e2e/render-r1b.spec.ts) fail if an upgrade changes them.
//
// R14b, the shadowCaster's light node: `steadyShadowColor` keeps its shadow colour node across builds with the shadow off
// (see the function), so a lit surface's text with the shadow on is the same in every build after the first.
import { Continue, If, Loop, float, getDistanceAttenuation, int, ivec2, mix, positionView, positionWorld, renderGroup, step, texture, uniform, vec3 } from 'three/tsl';
import { Lighting, LightsNode, Node, NodeUtils, Vector3 } from 'three/webgpu';
import type { Light, LightingModel, LightingModelReflectedLight, NodeBuilder, PerspectiveCamera, TextureNode, UniformNode } from 'three/webgpu';
import type { FrameInfo } from '../engine/render-loop.ts';
import type { TierConfig, TierId } from '../perf/budget.ts';
import type { FlashGuardControl } from './flash-guard.ts';
import { PersistentShadowNode } from './shadow-caster.ts';
import { CELL_TEXTURE_WIDTH, GRID_CELL, LightGrid, type GridBounds, type LightGridData } from './light-grid.ts';
import { LIGHT_TEXELS, createLightTable, type LightTableControl } from './light-table.ts';

/** added to three's lights cache key: the two data nodes are part of every lit material, whatever the table holds */
export const GRID_NODE_KEY = 0x9b1d;

/** the three rows of the tier table the lights read (`TierConfig` fits) */
export interface LightingCaps {
  /** `LIGHT_CAP`: lights per grid cell (24 / 16 / 8 / 6) */
  lightsPerCell: number;
  /** `DYN_CAP`: lights in the dynamic block (16 / 8 / 4 / 2) */
  dynamicLights: number;
  /** fire lights in the grid: the brightest n of the place (all / all / 8 / 4) */
  fxLights: number;
}

/** what the two loops read: three textures and the uniforms beside them, shared by every lit material */
export interface LightLoopInputs {
  /** RGBA32F, four texels per light (light-table.ts) */
  readonly lightTex: TextureNode;
  /** RG32F, per cell (offset, count) */
  readonly cellHeadTex: TextureNode;
  /** R32F, the packed cell lists */
  readonly cellIdxTex: TextureNode;
  readonly gridOrigin: UniformNode<'vec3', Vector3>;
  /** cells along x, y, z */
  readonly gridDims: UniformNode<'vec3', Vector3>;
  /** first slot of the dynamic block */
  readonly dynamicBase: UniformNode<'int', number>;
  /** lights in the dynamic block this frame */
  readonly dynamicCount: UniformNode<'int', number>;
}

type F = Node<'float'>;

/** the smoothstep of the light loops (Appendix B.3), defined for any edge order; `step(e0, x)` for equal edges */
function ssSmoothstepNode(e0: F, e1: F, x: F): F {
  const span = e1.sub(e0);
  const equal = float(e0.equal(e1));
  // span + equal is never 0: no division by zero to mask afterwards
  const t = x.sub(e0).div(span.add(equal)).clamp(0, 1);
  const smooth = t.mul(t).mul(float(3).sub(t.mul(2)));
  return mix(smooth, step(e0, x), equal) as F;
}

interface LightingContext {
  lightingModel?: LightingModel;
  reflectedLight?: { directDiffuse: Node<'vec3'>; directSpecular: Node<'vec3'> };
  positionView?: Node<'vec3'>;
}

/**
 * A light data node: `setup` emits one `Loop` and returns nothing. `mode` picks what it runs over; the body is the same.
 */
class LightLoopNode extends Node {
  static get type(): string {
    return 'SSLightLoopNode';
  }

  readonly mode: 'grid' | 'dynamic';
  readonly #inputs: LightLoopInputs;

  constructor(inputs: LightLoopInputs, mode: 'grid' | 'dynamic') {
    super('vec3');
    this.#inputs = inputs;
    this.mode = mode;
  }

  override setup(builder: NodeBuilder): undefined {
    const context = builder.context as LightingContext;
    const { lightingModel, reflectedLight } = context;
    if (!lightingModel || !reflectedLight) {
      throw new Error('light loop: three no longer provides context.lightingModel / reflectedLight to a light node (render §20 risk 2)');
    }
    const inputs = this.#inputs;
    const surface = (context.positionView ?? positionView) as Node<'vec3'>;
    const diffuse = vec3(0).toVar(`${this.mode}Diffuse`);
    const specular = vec3(0).toVar(`${this.mode}Specular`);
    // the loop-local accumulators, never builder.context's
    const local = { directDiffuse: diffuse, directSpecular: specular } as unknown as LightingModelReflectedLight;

    /** one light: `slot` is its slot in the light texture */
    const shade = (slot: Node<'int'>): void => {
      const x = slot.mul(LIGHT_TEXELS).toVar();
      const positionAndCutoff = inputs.lightTex.load(ivec2(x, 0)) as unknown as Node<'vec4'>;
      const cutoff = positionAndCutoff.w;
      const toLight = positionAndCutoff.xyz.sub(surface).toVar();
      const dist = toLight.length().toVar();
      // dark or empty slot (cut-off < 0), or out of range: one fetch and on to the next light
      If(cutoff.lessThan(0).or(cutoff.greaterThan(0).and(dist.greaterThan(cutoff))), () => {
        Continue();
      });
      const colorAndDecay = inputs.lightTex.load(ivec2(x.add(1), 0)) as unknown as Node<'vec4'>;
      const directionAndCone = inputs.lightTex.load(ivec2(x.add(2), 0)) as unknown as Node<'vec4'>;
      const penumbra = inputs.lightTex.load(ivec2(x.add(3), 0)) as unknown as Node<'vec4'>;
      // towards the light, view space
      const dir = toLight.div(dist.max(1e-5)).toVar();
      // directionAndCone.xyz is (light − target), so this is the cosine three's own spot term uses
      const cone = ssSmoothstepNode(directionAndCone.w, penumbra.x, dir.dot(directionAndCone.xyz) as F);
      const falloff = getDistanceAttenuation({ lightDistance: dist, cutoffDistance: cutoff, decayExponent: colorAndDecay.w }) as unknown as F;
      const lightColor = colorAndDecay.xyz.mul(falloff).mul(cone);
      lightingModel.direct({ lightDirection: dir, lightColor, lightNode: { light: {}, shadowNode: null } as unknown as Node, reflectedLight: local }, builder);
    };

    if (this.mode === 'grid') {
      // cellCoord: floor((positionWorld − gridOrigin) / 8), clamped to the grid → linear index → texel
      const cell3 = positionWorld.sub(inputs.gridOrigin).div(GRID_CELL).floor().clamp(vec3(0), inputs.gridDims.sub(1)).toVar();
      const cell = int(cell3.x.add(inputs.gridDims.x.mul(cell3.y.add(inputs.gridDims.y.mul(cell3.z)))).add(0.5)).toVar();
      const head = (inputs.cellHeadTex.load(ivec2(cell.mod(int(CELL_TEXTURE_WIDTH)), cell.div(int(CELL_TEXTURE_WIDTH)))) as unknown as Node<'vec4'>).toVar();
      const offset = int(head.x.add(0.5)).toVar();
      const count = int(head.y.add(0.5)).toVar();
      Loop(count, ({ i }) => {
        const k = offset.add(i).toVar();
        const entry = inputs.cellIdxTex.load(ivec2(k.mod(int(CELL_TEXTURE_WIDTH)), k.div(int(CELL_TEXTURE_WIDTH)))) as unknown as Node<'vec4'>;
        shade(int(entry.x.add(0.5)));
      });
    } else {
      Loop(inputs.dynamicCount, ({ i }) => {
        shade(inputs.dynamicBase.add(i) as unknown as Node<'int'>);
      });
    }

    reflectedLight.directDiffuse.addAssign(diffuse);
    reflectedLight.directSpecular.addAssign(specular);
    return undefined;
  }
}

type LightNodeList = ReturnType<LightsNode['setupLightsNode']>;

/** what `steadyShadowColor` touches of three's `AnalyticLightNode` (r186) */
interface ShadowedLightNode {
  light?: { castShadow?: boolean; shadow?: { shadowNode?: unknown } | null } | null;
  shadowNode: unknown;
  shadowColorNode: unknown;
  setup(builder: NodeBuilder): unknown;
}

/** marks a light node whose shadow colour node is kept (a node seen twice must not be wrapped twice) */
const STEADY = Symbol.for('ss.steadyShadowColor');

/**
 * R14b (render §7.2, §15.2). three r186's `AnalyticLightNode.setup` drops a light's shadow node and its shadow colour node
 * (`shadowColorNode`: the light's colour times the shadow) on every build with `castShadow` off, and the next build with it
 * on makes a new colour node. The build that makes it writes another text than the builds that reuse it, so whichever
 * surface happens to be built first after the shadow comes back links a program no warm-up wrote [M, R14b SwiftShader
 * program-text diff, a `low` session picking `medium` during gameplay: the first packed surface drawn after the switch declared
 * `colour × shadow` inline, every build before it had a variable for it; the next switch's first surface did the same].
 * For a light whose shadow node is the session's own (`PersistentShadowNode`: three's drop disposes nothing of it), this
 * puts the two back after a build with the shadow off, so after the first build with the shadow on every one reuses them:
 * the text of a lit surface no longer depends on what was built before it. A build with the shadow off still draws without
 * the shadow (three set the light's colour back before its direct light was set up). True when it wrapped the node.
 */
export function steadyShadowColor(lightNode: unknown): boolean {
  if (typeof lightNode !== 'object' || lightNode === null) return false;
  const n = lightNode as ShadowedLightNode & { [STEADY]?: true };
  if (n[STEADY] === true || typeof n.setup !== 'function' || !('shadowColorNode' in n) || !('shadowNode' in n)) return false;
  if (!(n.light?.shadow?.shadowNode instanceof PersistentShadowNode)) return false;
  n[STEADY] = true;
  const setup = n.setup;
  n.setup = function (this: ShadowedLightNode, builder: NodeBuilder): unknown {
    const shadowNode = this.shadowNode;
    const shadowColorNode = this.shadowColorNode;
    const out = setup.call(this, builder);
    if (this.light?.castShadow !== true && this.shadowColorNode === null && shadowColorNode !== null && shadowNode instanceof PersistentShadowNode && !shadowNode.released) {
      this.shadowNode = shadowNode;
      this.shadowColorNode = shadowColorNode;
    }
    return out;
  };
  return true;
}

/** the two data nodes of one `GridLighting` */
export interface LightLoopNodes {
  readonly grid: Node;
  readonly dynamic: Node;
}

/**
 * The grid and the dynamic data node over `inputs`. One pair per `GridLighting`, shared by the lights node of every scene:
 * a node's cache key holds its id, so two pairs would make two programs out of one material.
 */
export function createLightLoopNodes(inputs: LightLoopInputs): LightLoopNodes {
  return { grid: new LightLoopNode(inputs, 'grid'), dynamic: new LightLoopNode(inputs, 'dynamic') };
}

/** three's lights node plus the grid and the dynamic data node (render Appendix B.2) */
export class GridLightsNode extends LightsNode {
  static get type(): string {
    return 'SSGridLightsNode';
  }

  readonly gridNode: Node;
  readonly dynamicNode: Node;

  constructor(nodes: LightLoopNodes) {
    super();
    this.gridNode = nodes.grid;
    this.dynamicNode = nodes.dynamic;
  }

  /** the permanent three lights (three's own nodes, the shadowCaster's shadow included, `steadyShadowColor`), then our two loops */
  override setupLightsNode(builder: NodeBuilder): LightNodeList {
    const lights = super.setupLightsNode(builder);
    for (const node of lights) steadyShadowColor(node);
    return [...lights, this.gridNode as unknown as LightNodeList[number], this.dynamicNode as unknown as LightNodeList[number]];
  }

  /** never changes with the table's lights */
  override customCacheKey(): number {
    return NodeUtils.hashArray([super.customCacheKey(), GRID_NODE_KEY]);
  }

  /** the loops are there even when the scene holds no three light */
  override get hasLights(): boolean {
    return true;
  }
}

export interface GridLightingOptions {
  /** default: tier `high` (24 per cell, 16 dynamic, every fx light) */
  caps?: LightingCaps;
  /** the FlashGuard every light's intensity passes through (render §8.5) */
  flashGuard?: FlashGuardControl | null;
}

const HIGH_CAPS: LightingCaps = { lightsPerCell: 24, dynamicLights: 16, fxLights: Number.POSITIVE_INFINITY };

/**
 * The lighting system of the renderer: the light table, the world grid and the nodes that read them. One instance lives as
 * long as the render facade; a renderer rebuilt after a device loss gets the same instance (`SceneRoot.installLighting`),
 * since everything here is CPU data and node graphs.
 */
export class GridLighting extends Lighting {
  readonly table: LightTableControl;
  readonly grid: LightGrid;
  readonly inputs: LightLoopInputs;
  /** the two data nodes, the same objects in the lights node of every scene */
  readonly nodes: LightLoopNodes;

  #caps: LightingCaps;
  #bounds: GridBounds | null = null;
  #builtRevision = -1;
  #gridDirty = true;

  constructor(opts: GridLightingOptions = {}) {
    super();
    this.table = createLightTable({ flashGuard: opts.flashGuard ?? null });
    this.grid = new LightGrid();
    this.#caps = { ...(opts.caps ?? HIGH_CAPS) };
    this.table.setDynamicCap(this.#caps.dynamicLights);
    this.inputs = {
      lightTex: texture(this.table.texture),
      cellHeadTex: texture(this.grid.headTexture),
      cellIdxTex: texture(this.grid.indexTexture),
      gridOrigin: uniform(new Vector3()).setGroup(renderGroup).setName('ssGridOrigin'),
      gridDims: uniform(new Vector3(1, 1, 1)).setGroup(renderGroup).setName('ssGridDims'),
      dynamicBase: uniform(this.table.dynamicBase, 'int').setGroup(renderGroup).setName('ssDynBase'),
      dynamicCount: uniform(0, 'int').setGroup(renderGroup).setName('ssDynCount'),
    };
    this.nodes = createLightLoopNodes(this.inputs);
  }

  override createNode(lights: Light[] = []): LightsNode {
    return new GridLightsNode(this.nodes).setLights(lights);
  }

  get caps(): Readonly<LightingCaps> {
    return this.#caps;
  }

  /** A tier switch (render §7.2): new caps are new lists and a new count, never a new shader. */
  setCaps(caps: LightingCaps): void {
    if (caps.lightsPerCell !== this.#caps.lightsPerCell || caps.fxLights !== this.#caps.fxLights) this.#gridDirty = true;
    this.#caps = { lightsPerCell: caps.lightsPerCell, dynamicLights: caps.dynamicLights, fxLights: caps.fxLights };
    this.table.setDynamicCap(caps.dynamicLights);
  }

  /** The AABB of all rows of the place (the grid adds its 10 m); null: the static lights' own extent. */
  setBounds(bounds: GridBounds | null): void {
    this.#bounds = bounds === null ? null : { min: { ...bounds.min }, max: { ...bounds.max } };
    this.#gridDirty = true;
  }

  /** Builds the cell lists now. `update` does it when the static lights, the bounds or the caps changed. */
  rebuildGrid(): LightGridData {
    // the new lists name live lights only, so the slots of removed ones are free again
    this.table.releaseRetired();
    const data = this.grid.rebuild(this.table.gridLights(), { bounds: this.#bounds, lightsPerCell: this.#caps.lightsPerCell, fxLights: this.#caps.fxLights });
    this.#builtRevision = this.table.staticRevision;
    this.#gridDirty = false;
    return data;
  }

  /**
   * Once per rendered frame, after the frame's row writes: the FlashGuard (when a clock is given), the grid if it is stale,
   * the view-space upload, and the uniforms and texture bindings of the loops.
   */
  update(camera: PerspectiveCamera, nowMs?: number, dt?: number): void {
    const { table, grid, inputs } = this;
    if (this.#gridDirty || this.#builtRevision !== table.staticRevision) this.rebuildGrid();
    if (nowMs !== undefined) table.applyFlashGuard(nowMs, dt ?? 0);
    table.upload(camera);
    // a grown table or a rebuilt grid may have replaced a texture: the nodes follow
    if (inputs.lightTex.value !== table.texture) inputs.lightTex.value = table.texture;
    if (inputs.cellHeadTex.value !== grid.headTexture) inputs.cellHeadTex.value = grid.headTexture;
    if (inputs.cellIdxTex.value !== grid.indexTexture) inputs.cellIdxTex.value = grid.indexTexture;
    const { origin, dims } = grid.data;
    inputs.gridOrigin.value.set(origin[0], origin[1], origin[2]);
    inputs.gridDims.value.set(dims[0], dims[1], dims[2]);
    inputs.dynamicBase.value = table.dynamicBase;
    inputs.dynamicCount.value = table.dynamicCount;
  }

  /** A place change: every light goes, the bounds are forgotten; the nodes and the compiled materials stay. */
  clear(): void {
    this.table.clear();
    this.#bounds = null;
    this.#gridDirty = true;
  }

  dispose(): void {
    this.table.dispose();
    this.grid.dispose();
  }
}

/** what `attachGridLighting` needs of the render facade (`RenderFacade` of src/render/index.ts fits) */
export interface GridLightingHost {
  readonly root: { installLighting(renderer: { lighting: Lighting }, lighting?: Lighting): void };
  readonly engine: { readonly renderer: { lighting: Lighting } };
  readonly loop: { setStage(stage: 'lights', run: ((frame: FrameInfo) => void) | null): void };
  readonly camera: { readonly world: PerspectiveCamera };
  readonly tierConfig: LightingCaps;
  onTierChange(cb: (tier: TierId, config: TierConfig) => void): () => void;
}

/**
 * Wires a `GridLighting` into the render facade through its seams: installs it on the renderer (`SceneRoot.installLighting`,
 * which hands the same instance to a renderer rebuilt after a device loss), takes the tier's caps now and on every tier
 * change, and fills the loop's `lights` stage (docs/architecture.md §4.2 step 4) with `update(camera, frame.now, frame.dt)`:
 * the FlashGuard, then the upload, after the frame's row writes. Returns the function that undoes the stage and the listener.
 */
export function attachGridLighting(host: GridLightingHost, lighting: GridLighting): () => void {
  lighting.setCaps(host.tierConfig);
  host.root.installLighting(host.engine.renderer, lighting);
  host.loop.setStage('lights', (frame) => lighting.update(host.camera.world, frame.now, frame.dt));
  const off = host.onTierChange((_tier, config) => lighting.setCaps(config));
  return () => {
    off();
    host.loop.setStage('lights', null);
  };
}
