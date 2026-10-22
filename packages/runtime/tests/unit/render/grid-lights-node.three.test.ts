// GridLighting / GridLightsNode without a renderer (docs/design/rendering.md §8.2, Appendix B.2; WP R1b): what three's node
// system is handed, and what `update` keeps in step. The shaders themselves are compiled and read back in the browser spec
// (tests/e2e/render-r1b.spec.ts).
import { AmbientLight, Lighting, LightsNode, PerspectiveCamera, PointLight, Scene, SpotLight, SpotLightNode } from 'three/webgpu';
import type { NodeBuilder } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { createRenderLoop, type FrameInfo } from '../../../src/render/engine/render-loop.ts';
import { createFlashGuard } from '../../../src/render/lighting/flash-guard.ts';
import { createShadowCaster } from '../../../src/render/lighting/shadow-caster.ts';
import { GRID_NODE_KEY, GridLighting, GridLightsNode, attachGridLighting, steadyShadowColor, type GridLightingHost } from '../../../src/render/lighting/grid-lights-node.ts';
import { cellIndexAt, cellLights } from '../../../src/render/lighting/light-grid.ts';
import type { LightRecord } from '../../../src/render/lighting/light-table.ts';
import { TIER_IDS, TIER_TABLE, tierConfig, type TierConfig, type TierId } from '../../../src/render/perf/budget.ts';
import { createSceneRoot } from '../../../src/render/scene/scene-root.ts';

const lamp = (x: number, z: number, over: Partial<LightRecord> = {}): LightRecord => ({
  kind: 'point',
  color: [1, 0.9, 0.7],
  intensity: 20,
  distance: 18,
  decay: 2,
  position: { x, y: 3, z },
  mobility: 'static',
  shadow: false,
  source: 'row',
  ...over,
});

function camera(): PerspectiveCamera {
  const cam = new PerspectiveCamera(70, 16 / 9, 0.1, 500);
  cam.position.set(0, 1.6, 6);
  cam.lookAt(0, 1.5, -10);
  return cam;
}

/** the part of a NodeBuilder `LightsNode#setupLightsNode` reads */
function fakeBuilder(): NodeBuilder {
  const data = new Map<object, Record<string, unknown>>();
  return {
    getDataFromNode(node: object) {
      let d = data.get(node);
      if (d === undefined) data.set(node, (d = {}));
      return d;
    },
    context: { materialLightings: [] },
    renderer: { library: { getLightNodeClass: () => null } },
  } as unknown as NodeBuilder;
}

describe('GridLighting', () => {
  it('is a three Lighting whose node is a GridLightsNode holding the scene’s lights', () => {
    const lighting = new GridLighting();
    expect(lighting).toBeInstanceOf(Lighting);
    const lights = [new AmbientLight(), new SpotLight()];
    const node = lighting.createNode(lights);
    expect(node).toBeInstanceOf(GridLightsNode);
    expect(node).toBeInstanceOf(LightsNode);
    expect(node.getLights()).toBe(lights);
    expect(lighting.createNode().getLights()).toEqual([]);
    // three asks per scene and keeps the node
    const scene = new Scene();
    expect(lighting.getNode(scene)).toBeInstanceOf(GridLightsNode);
    expect(lighting.getNode(scene)).toBe(lighting.getNode(scene));
    expect(lighting.getNode(new Scene())).not.toBe(lighting.getNode(scene));
  });

  it('adds the grid and the dynamic data node after three’s own light nodes, and always has lights', () => {
    const lighting = new GridLighting();
    const node = lighting.createNode() as GridLightsNode;
    expect(node.hasLights).toBe(true);
    expect(new LightsNode().hasLights).toBe(false);
    const list = node.setupLightsNode(fakeBuilder());
    expect(list).toHaveLength(2);
    expect(list[0]).toBe(node.gridNode);
    expect(list[1]).toBe(node.dynamicNode);
    expect((node.gridNode as unknown as { mode: string }).mode).toBe('grid');
    expect((node.dynamicNode as unknown as { mode: string }).mode).toBe('dynamic');
    // one Loop per data node: two nodes, the same objects in the lights node of every scene (a node's cache key holds its
    // id, so a pair per scene would compile one material once per scene)
    expect(node.gridNode).not.toBe(node.dynamicNode);
    expect(node.setupLightsNode(fakeBuilder())[0]).toBe(node.gridNode);
    const other = lighting.createNode() as GridLightsNode;
    expect(other).not.toBe(node);
    expect(other.gridNode).toBe(node.gridNode);
    expect(other.dynamicNode).toBe(node.dynamicNode);
    expect(lighting.nodes).toEqual({ grid: node.gridNode, dynamic: node.dynamicNode });
  });

  it('the cache key holds a constant for the data nodes and nothing of the table: 48 lights are the material of 8', () => {
    const lighting = new GridLighting();
    const cam = camera();
    const ambient = new AmbientLight();
    const shadowCaster = new SpotLight();
    const node = lighting.createNode([ambient, shadowCaster]);
    // 8 lights in the grid
    for (let i = 0; i < 8; i++) lighting.table.add(lamp(i * 3, 0));
    lighting.update(cam);
    const custom = node.customCacheKey();
    const full = node.getCacheKey(true);
    // 48 in the grid and a full dynamic block
    for (let i = 0; i < 40; i++) lighting.table.add(lamp(i, -i));
    for (let i = 0; i < 16; i++) lighting.table.add(lamp(i, 4, { mobility: 'transient' }));
    lighting.update(cam);
    expect(lighting.table.staticCount).toBe(48);
    expect(lighting.inputs.dynamicCount.value).toBe(16);
    expect(node.customCacheKey()).toBe(custom);
    expect(node.getCacheKey(true)).toBe(full);
    // the lights node of another scene has the same key: one program per material, whatever scene draws it
    const again = lighting.createNode([ambient, shadowCaster]);
    expect(again.customCacheKey()).toBe(custom);
    expect(again.getCacheKey(true)).toBe(full);
    // it is three's key for the permanent lights plus our constant
    const plain = new LightsNode().setLights([ambient, shadowCaster]);
    expect(custom).not.toBe(plain.customCacheKey());
    expect(GRID_NODE_KEY).toBe(0x9b1d);
    // the key does not move with the lights' values, the caps or a new place
    lighting.setCaps(tierConfig('minimum'));
    lighting.table.setIntensity(lighting.table.add(lamp(2, 2)), 0);
    lighting.update(cam);
    lighting.clear();
    lighting.update(cam);
    expect(node.getCacheKey(true)).toBe(full);
    // while a three light added to the scene does change it (which is why every other light is a table record)
    expect(lighting.createNode([ambient, shadowCaster, new PointLight()]).customCacheKey()).not.toBe(custom);
    // and so does the shadowCaster's shadow switch (R4's one recompile at a tier switch)
    shadowCaster.castShadow = true;
    expect(lighting.createNode([ambient, shadowCaster]).customCacheKey()).not.toBe(custom);
  });

  it('update builds the grid when the static lights changed, uploads, and keeps the loops’ inputs in step', () => {
    const lighting = new GridLighting();
    const { table, grid, inputs } = lighting;
    const cam = camera();
    expect(inputs.lightTex.value).toBe(table.texture);
    lighting.setBounds({ min: { x: -30, y: 0, z: -30 }, max: { x: 30, y: 8, z: 30 } });
    const a = table.add(lamp(-10, 0));
    table.add(lamp(12, 4));
    const flash = table.add(lamp(0, 2, { mobility: 'transient', source: 'fx', intensity: 45, distance: 10 }));
    lighting.update(cam);
    expect(grid.revision).toBe(1);
    expect(inputs.gridOrigin.value.toArray()).toEqual([-40, -10, -40]);
    expect(inputs.gridDims.value.toArray()).toEqual([10, 4, 10]);
    expect(inputs.dynamicBase.value).toBe(table.dynamicBase);
    expect(inputs.dynamicCount.value).toBe(1);
    expect(inputs.cellHeadTex.value).toBe(grid.headTexture);
    expect(inputs.cellIdxTex.value).toBe(grid.indexTexture);
    expect(cellLights(grid.data, cellIndexAt(grid.data, -10, 3, 0))).toEqual([0]);
    expect(cellLights(grid.data, cellIndexAt(grid.data, 12, 3, 4))).toEqual([1]);

    // intensity, colour, a transient ending: no rebuild
    table.setIntensity(a, 0);
    table.setColor(a, [1, 0, 0]);
    table.remove(flash);
    lighting.update(cam);
    expect(grid.revision).toBe(1);
    expect(inputs.dynamicCount.value).toBe(0);

    // a new static light: one rebuild on the next frame
    table.add(lamp(-10, 2, { intensity: 60 }));
    lighting.update(cam);
    lighting.update(cam);
    expect(grid.revision).toBe(2);
    expect(cellLights(grid.data, cellIndexAt(grid.data, -10, 3, 0))).toEqual([2, 0]);

    // the table outgrows its texture: the node follows the new one, and the dynamic block moves with it
    const lightTexNode = inputs.lightTex;
    for (let i = 0; i < 40; i++) table.add(lamp(-20 + i, -20));
    lighting.update(cam);
    expect(inputs.lightTex).toBe(lightTexNode);
    expect(inputs.lightTex.value).toBe(table.texture);
    expect(table.staticSlots).toBe(48);
    expect(inputs.dynamicBase.value).toBe(48);
  });

  it('a tier switch is new lists and a new dynamic count, on the same nodes', () => {
    const lighting = new GridLighting();
    const cam = camera();
    for (let i = 0; i < 30; i++) lighting.table.add(lamp(-3 + (i % 6), -3 + Math.floor(i / 6), { intensity: 10 + i }));
    for (let i = 0; i < 20; i++) lighting.table.add(lamp(0, -i, { mobility: 'transient' }));
    const node = lighting.createNode();
    const inputs = lighting.inputs;
    const seen: Array<[number, number]> = [];
    for (const tier of TIER_IDS) {
      lighting.setCaps(tierConfig(tier));
      lighting.update(cam);
      seen.push([lighting.grid.data.maxPerCell, inputs.dynamicCount.value]);
      expect(lighting.caps).toEqual({ lightsPerCell: tierConfig(tier).lightsPerCell, dynamicLights: tierConfig(tier).dynamicLights, fxLights: tierConfig(tier).fxLights });
    }
    expect(seen).toEqual([
      [24, 16],
      [16, 8],
      [8, 4],
      [6, 2],
    ]);
    expect(lighting.inputs).toBe(inputs);
    expect(lighting.createNode().customCacheKey()).toBe(node.customCacheKey());
    // setting the same caps again rebuilds nothing
    const revision = lighting.grid.revision;
    lighting.setCaps(tierConfig('minimum'));
    lighting.update(cam);
    expect(lighting.grid.revision).toBe(revision);
  });

  it('runs the FlashGuard before the upload when the frame clock is given', () => {
    const guard = createFlashGuard();
    guard.setEnabled(true);
    const lighting = new GridLighting({ flashGuard: guard });
    const cam = camera();
    const h = lighting.table.add(lamp(0, 0, { color: [1, 1, 1] }));
    lighting.update(cam, 0, 1 / 100);
    lighting.table.setIntensity(h, 0);
    lighting.update(cam, 10, 1 / 100);
    // 20 → 0 is a 250 ms fade under the guard: 0.8 per 10 ms
    expect(lighting.table.data[4]).toBeCloseTo(19.2, 5);
    // without a clock the guard is not run: the writer's value goes straight in
    const plain = new GridLighting({ flashGuard: guard });
    const p = plain.table.add(lamp(0, 0, { color: [1, 1, 1] }));
    plain.update(cam);
    plain.table.setIntensity(p, 0);
    plain.update(cam);
    expect(plain.table.data[4]).toBe(0);
  });

  it('clear empties the place and the next place builds its own grid on the same nodes', () => {
    const lighting = new GridLighting();
    const cam = camera();
    lighting.setBounds({ min: { x: -30, y: 0, z: -30 }, max: { x: 30, y: 8, z: 30 } });
    for (let i = 0; i < 20; i++) lighting.table.add(lamp(i - 10, 0));
    lighting.update(cam);
    const head = lighting.grid.headTexture;
    const inputs = lighting.inputs;
    lighting.clear();
    lighting.update(cam);
    expect(lighting.table.size).toBe(0);
    expect(lighting.grid.data.cellCount).toBe(1);
    expect(lighting.inputs.cellHeadTex.value).toBe(lighting.grid.headTexture);
    expect(lighting.grid.headTexture).not.toBe(head);
    lighting.setBounds({ min: { x: -100, y: 0, z: -100 }, max: { x: 100, y: 20, z: 100 } });
    lighting.table.add(lamp(50, 50));
    lighting.update(cam);
    expect(lighting.grid.data.dims).toEqual([28, 5, 28]);
    expect(lighting.inputs).toBe(inputs);
    expect(inputs.gridDims.value.toArray()).toEqual([28, 5, 28]);
  });

  it('attachGridLighting wires it into the facade’s seams: the renderer, the `lights` stage, the tier', () => {
    const root = createSceneRoot();
    const guard = createFlashGuard();
    const lighting = new GridLighting({ flashGuard: guard });
    const renderer = { lighting: new Lighting() };
    const world = camera();
    let drawn = 0;
    const loop = createRenderLoop({ draw: () => ++drawn > 0, clock: { requestAnimationFrame: () => 1, cancelAnimationFrame: () => undefined } });
    const tierListeners = new Set<(tier: TierId, config: TierConfig) => void>();
    const host: GridLightingHost = {
      root,
      engine: { renderer },
      loop,
      camera: { world },
      tierConfig: tierConfig('medium'),
      onTierChange(cb) {
        tierListeners.add(cb);
        return () => void tierListeners.delete(cb);
      },
    };
    const detach = attachGridLighting(host, lighting);
    expect(renderer.lighting).toBe(lighting);
    expect(root.lighting).toBe(lighting);
    expect(lighting.caps).toEqual({ lightsPerCell: 16, dynamicLights: 8, fxLights: Number.POSITIVE_INFINITY });

    // the loop's `lights` stage: the FlashGuard with the frame's clock, then the upload
    guard.setEnabled(true);
    const lampHandle = lighting.table.add(lamp(0, 0, { color: [1, 1, 1] }));
    const frame = (now: number): FrameInfo => ({ now, dt: 1 / 100, realDt: 1 / 100, alpha: 0, frameIndex: now / 10, paused: false });
    loop.update(frame(0));
    expect(lighting.grid.revision).toBe(1);
    expect(lighting.table.data[4]).toBe(20);
    lighting.table.setIntensity(lampHandle, 0);
    loop.update(frame(10));
    expect(lighting.table.data[4]).toBeCloseTo(19.2, 5);

    // a tier switch reaches the caps
    for (const cb of tierListeners) cb('minimum', tierConfig('minimum'));
    expect(lighting.caps).toEqual({ lightsPerCell: 6, dynamicLights: 2, fxLights: 4 });
    expect(lighting.table.dynamicCap).toBe(2);

    // a rebuilt renderer gets the same instance from the root
    const rebuilt = { lighting: new Lighting() };
    root.installLighting(rebuilt);
    expect(rebuilt.lighting).toBe(lighting);

    detach();
    expect(tierListeners.size).toBe(0);
    const before = lighting.table.data[4];
    loop.update(frame(20));
    expect(lighting.table.data[4]).toBe(before);
    loop.dispose();
  });

  it('survives a renderer rebuild: the scene root hands the same instance to the new renderer (X3)', () => {
    const root = createSceneRoot();
    const lighting = new GridLighting();
    const h = lighting.table.add(lamp(1, 1));
    const first = { lighting: new Lighting() };
    root.installLighting(first, lighting);
    expect(first.lighting).toBe(lighting);
    const rebuilt = { lighting: new Lighting() };
    root.installLighting(rebuilt);
    expect(rebuilt.lighting).toBe(lighting);
    expect(root.lighting).toBe(lighting);
    // the records are CPU data: nothing was lost with the device
    expect(lighting.table.staticIndex(h)).toBe(0);
    expect(lighting.table.size).toBe(1);
  });
});

describe('the shadowCaster’s shadow colour node across shadow off and on (R14b, steadyShadowColor)', () => {
  /** what `AnalyticLightNode.setup` reads of a node builder (no shader is built) */
  const builderFor = (receiveShadow = true): NodeBuilder =>
    ({
      object: { receiveShadow },
      renderer: { shadowMap: { enabled: true } },
      context: {},
      lightsNode: { setupDirectLight: () => undefined, setupDirectRectAreaLight: () => undefined },
    }) as unknown as NodeBuilder;
  type LightNodeState = { shadowColorNode: unknown; shadowNode: unknown; colorNode: unknown; setup(b: NodeBuilder): unknown };
  const stateOf = (n: unknown): LightNodeState => n as LightNodeState;

  it('control: three r186 makes a new shadow colour node after every build with the shadow off', () => {
    const light = new SpotLight();
    const node = stateOf(new SpotLightNode(light));
    light.castShadow = true;
    node.setup(builderFor());
    const first = node.shadowColorNode;
    expect(first).not.toBeNull();
    light.castShadow = false;
    node.setup(builderFor());
    expect(node.shadowColorNode).toBeNull();
    light.castShadow = true;
    node.setup(builderFor());
    expect(node.shadowColorNode).not.toBe(first);
  });

  it('the shadowCaster’s light node keeps one for the session; a build with the shadow off still draws without it', () => {
    const shadowCaster = createShadowCaster({ light: createSceneRoot().lights.shadowCaster, shadowSize: 1024 });
    const node = stateOf(new SpotLightNode(shadowCaster.light));
    expect(steadyShadowColor(node)).toBe(true);
    expect(steadyShadowColor(node)).toBe(false);
    node.setup(builderFor());
    const first = node.shadowColorNode;
    expect(first).not.toBeNull();
    expect(node.colorNode).toBe(first);
    // a governor drop to `low`, the player's pick of `medium`, and so on; receivers and other surfaces built in each
    for (const tier of ['low', 'medium', 'minimum', 'high'] as const) {
      shadowCaster.setShadowTier(TIER_TABLE[tier]);
      node.setup(builderFor());
      node.setup(builderFor(false));
      node.setup(builderFor());
      expect(node.shadowColorNode, tier).toBe(first);
      expect(node.shadowNode, tier).toBe(shadowCaster.shadowNode);
      // the colour the build's direct light was set up with: the shadow's on a receiver with the shadow on, the light's own off
      expect(node.colorNode === first, tier).toBe(TIER_TABLE[tier].shadowCasterMapSize > 0);
    }
    // a light whose shadow node is three's own is left as three made it (its node is reset by that drop)
    expect(steadyShadowColor(new SpotLightNode(new SpotLight()))).toBe(false);
    expect(steadyShadowColor(null)).toBe(false);
  });

  it('the grid’s lights node hands three’s light nodes through with the shadowCaster’s kept steady', () => {
    const shadowCaster = createShadowCaster({ light: createSceneRoot().lights.shadowCaster, shadowSize: 512 });
    const lighting = new GridLighting();
    const node = lighting.createNode([new AmbientLight(), shadowCaster.light]) as GridLightsNode;
    const builder = fakeBuilder();
    (builder as unknown as { renderer: { library: { getLightNodeClass: (c: unknown) => unknown } } }).renderer.library.getLightNodeClass = (c) => (c === SpotLight ? SpotLightNode : null);
    const list = node.setupLightsNode(builder);
    expect(list).toHaveLength(3);
    const spot = list[0] as unknown as { light: unknown } & Record<symbol, unknown>;
    expect(spot.light).toBe(shadowCaster.light);
    expect(spot[Symbol.for('ss.steadyShadowColor')]).toBe(true);
    expect(list[1]).toBe(node.gridNode);
    expect(list[2]).toBe(node.dynamicNode);
  });
});
