// fx lights without the atlas (`fxLightsWithoutAtlas`) and axis-turned stretched cards (`fxAlignedCards`); both opt-in, PP default.
import { describe, expect, it } from 'vitest';
import { DataTexture, InstancedMesh, Matrix4, Object3D, Quaternion, RGBAFormat, Scene, UnsignedByteType, Vector3 } from 'three/webgpu';
import type { Texture } from 'three/webgpu';
import { compileProgram } from '../../src/render/fx/dsl/compile.ts';
import { createFxSimulation } from '../../src/render/fx/sim/simulator.ts';
import { FxStretchedBuckets, composeAxisCard } from '../../src/render/fx/render/stretched-buckets.ts';
import { setupFxRuntime, type FxSetupHost } from '../../src/render/fx/fx-setup.ts';
import { createFxSystem, type FxSystemOptions } from '../../src/render/fx/fx-system.ts';
import { placeholderAtlasTexture } from '../../src/render/fx/atlas-texture.ts';
import { createRenderBudget } from '../../src/render/perf/budget.ts';
import type { BridgeLights } from '../../src/render/bridge/bridge-types.ts';
import type { LightHandle, LightRecord } from '../../src/render/lighting/light-table.ts';
import type { TierConfig } from '../../src/render/perf/budget.ts';

const TORCH = 'fx\npop glow n=1 at=point().c(.2) glo=fire()*.25+.75 r=light(<1,.72,.45>,$glo*70,22)\npop dot n=2 r=sprite(ember,add)';

function lightsSink() {
  const records: LightRecord[] = [];
  let next = 1;
  const lights: BridgeLights = { add: (r) => (records.push(r), next++ as LightHandle), remove() {}, setIntensity() {}, setColor() {}, setPose() {} };
  return { records, lights };
}

function setupHost(over: Partial<FxSetupHost>, create: (o: FxSystemOptions) => ReturnType<typeof createFxSystem>): FxSetupHost {
  return {
    resolveAtlas: () => null,
    loadAtlas: async () => { throw new Error('404'); },
    world: new Scene(),
    camera: new Object3D(),
    tier: () => 'high',
    tierConfig: () => ({}) as TierConfig,
    lighting: null,
    lights: null,
    create,
    log: () => undefined,
    ...over,
  };
}

describe('fx lights without the atlas', () => {
  it('lightsOnlyAtlas: no atlas still starts the runtime, light() sinks reach the grid, sprites draw nothing', async () => {
    const { records, lights } = lightsSink();
    const world = new Scene();
    let seen: FxSystemOptions | null = null;
    const s = await setupFxRuntime(setupHost({ world, lights, lightsOnlyAtlas: placeholderAtlasTexture }, (o) => ((seen = o), createFxSystem({ ...o, budget: createRenderBudget('high') }))));
    expect(s.fx).not.toBeNull();
    expect(seen!.lightsOnly).toBe(true);
    s.fx!.emit({ script: TORCH }, [1, 2, 3]);
    s.fx!.update({ dt: 0.016, now: 1000 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ source: 'fx', kind: 'point', distance: 22 });
    expect(s.fx!.sprites.get('add')).toBeUndefined();
    expect(s.fx!.warmObjects()).toEqual([]);
    s.dispose();
  });
  it('also when the atlas file fails to load', async () => {
    let seen: FxSystemOptions | null = null;
    const s = await setupFxRuntime(setupHost({ resolveAtlas: () => 'x.png', lightsOnlyAtlas: placeholderAtlasTexture }, (o) => ((seen = o), createFxSystem({ ...o, budget: createRenderBudget('high') }))));
    expect(s.fx).not.toBeNull();
    expect(seen!.lightsOnly).toBe(true);
    s.dispose();
  });
  it('the built-in atlas wins when both are on (full fx, not lights only)', async () => {
    let seen: FxSystemOptions | null = null;
    const builtin = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType) as Texture;
    const s = await setupFxRuntime(setupHost({ builtinAtlas: () => builtin, lightsOnlyAtlas: placeholderAtlasTexture }, (o) => ((seen = o), createFxSystem({ ...o, budget: createRenderBudget('high') }))));
    expect(seen!.atlas).toBe(builtin);
    expect(seen!.lightsOnly).toBeUndefined();
    s.dispose();
  });
  it('negative (PP): neither option, fx stays off', async () => {
    const s = await setupFxRuntime(setupHost({}, () => { throw new Error('not built'); }));
    expect(s.fx).toBeNull();
  });
});

// Crown & Clash's candle row: the path(js{}) shape parses and births (render wave 7); what drew nothing was the game's
// `fxLightsWithoutAtlas` (sprites off by design). With the built-in atlas (`fxBuiltinAtlas`) the same row draws its flame sprites.
describe('candle flames (path shape) need a sprite atlas', () => {
  const CANDLE = 'fx\npop flame n=?mobile:15|25 on=path(js{ [[[0,0.29,0],[0,0.293,0]],[[0.075,0.2,0.045],[0.075,0.203,0.045]]] }) life=.25..0.45 v=up(.2) size=.03..0.05 sz=$size*(.7>1:.3>.4)*flick(9,.2) col=hdr(4.6,3,1.2)>hdr(2.6,1.1,.25) a=0>.15:1>.8:.8>0 r=sprite(flame-wisp,add)\npop glow n=1 at=point().c(0.39) glo=fire()*.3+.7 r=light(<1,.6,.3>,$glo*3,6)';
  const start = async (over: Partial<FxSetupHost>) => {
    const { records, lights } = lightsSink();
    const s = await setupFxRuntime(setupHost({ lights, ...over }, (o) => createFxSystem({ ...o, budget: createRenderBudget('high') })));
    s.fx!.emit({ script: CANDLE }, [5, 1, -4]);
    s.fx!.update({ dt: 0.016, now: 1000 });
    return { s, records };
  };
  it('lights only: the glow light is made, no flame sprite is drawn', async () => {
    const { s, records } = await start({ lightsOnlyAtlas: placeholderAtlasTexture });
    expect(records).toHaveLength(1);
    expect(s.fx!.sprites.get('add')).toBeUndefined();
    s.dispose();
  });
  it('with the built-in atlas: the flames draw as add sprites, with the light too', async () => {
    const builtin = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType) as Texture;
    const { s, records } = await start({ builtinAtlas: () => builtin, lightsOnlyAtlas: placeholderAtlasTexture });
    expect(records).toHaveLength(1);
    const mesh = s.fx!.sprites.get('add') as unknown as InstancedMesh;
    expect(mesh).toBeDefined();
    expect(mesh.count).toBeGreaterThanOrEqual(15);
    s.dispose();
  });
});

describe('fx aligned cards', () => {
  const atlas = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType);
  const BEAM = 'fx\npop beam n=1 size=1.5 sz=$size a=.07 col=<.45,.6,1> r=sprite(soft-disc,add,axis,7.7,axis=<0.570,-0.814,0.109>)';
  const decompose = (mesh: InstancedMesh, i = 0) => {
    const m = new Matrix4().fromArray(mesh.instanceMatrix.array as Float32Array, i * 16);
    const x = new Vector3().setFromMatrixColumn(m, 0), y = new Vector3().setFromMatrixColumn(m, 1), z = new Vector3().setFromMatrixColumn(m, 2);
    return { x, y, z, at: new Vector3().setFromMatrixPosition(m) };
  };

  it('composeAxisCard: +y is the axis times length, +x across at width, +z faces the viewer', () => {
    const out = new Float32Array(16);
    const dir = new Vector3(0.570, -0.814, 0.109).normalize();
    const at = new Vector3(2, 6, -1), viewer = new Vector3(0, 8, 14);
    composeAxisCard(out, 0, at, dir, viewer, 1.5, 9.2);
    const m = new Matrix4().fromArray(out);
    const x = new Vector3().setFromMatrixColumn(m, 0), y = new Vector3().setFromMatrixColumn(m, 1), z = new Vector3().setFromMatrixColumn(m, 2);
    expect(y.length()).toBeCloseTo(9.2);
    expect(y.clone().normalize().dot(dir)).toBeCloseTo(1);
    expect(x.length()).toBeCloseTo(1.5);
    expect(x.dot(dir)).toBeCloseTo(0);
    expect(z.dot(viewer.clone().sub(at))).toBeGreaterThan(0);
    expect(z.dot(dir)).toBeCloseTo(0);
  });

  it('alignedCards: an axis sprite is size + stretch long along the axis and drawn without the full billboard', () => {
    const world = new Scene();
    const camera = new Object3D();
    camera.position.set(0, 10, 20);
    world.add(camera);
    world.updateMatrixWorld(true);
    const buckets = new FxStretchedBuckets({ world, camera, atlas, capacity: 8, additiveFog: 'three', alignedCards: true });
    const sim = createFxSimulation(compileProgram(BEAM, {}, { low: false, mobile: false }), { seed: 1, capacity: 4, origin: [0, 5, 0] });
    buckets.update([sim]);
    const mesh = buckets.get('add')!;
    expect(mesh.count).toBe(1);
    expect(mesh.material).toHaveProperty('vertexNode', null);
    const { x, y, z, at } = decompose(mesh);
    expect(y.length()).toBeCloseTo(1.5 + 7.7);
    expect(y.clone().normalize().dot(new Vector3(0.570, -0.814, 0.109).normalize())).toBeCloseTo(1);
    expect(x.length()).toBeCloseTo(1.5);
    expect(z.dot(camera.position.clone().sub(at))).toBeGreaterThan(0);
    sim.dispose();
    buckets.dispose();
  });

  it('alignedCards: a velocity sprite turns its long side to the velocity', () => {
    const world = new Scene();
    const camera = new Object3D();
    camera.position.set(0, 0, 10);
    world.add(camera);
    world.updateMatrixWorld(true);
    const buckets = new FxStretchedBuckets({ world, camera, atlas, capacity: 8, additiveFog: 'three', alignedCards: true });
    const sim = createFxSimulation(compileProgram('fx\npop s burst=1 life=1 size=.1 v=<3,0,0> r=sprite(ember,add,velocity,.5)', {}, { low: false, mobile: false }), { seed: 2, capacity: 4 });
    buckets.update([sim]);
    const { y } = decompose(buckets.get('add')!);
    expect(y.length()).toBeCloseTo(0.1 + 3 * 0.5);
    expect(Math.abs(y.clone().normalize().x)).toBeCloseTo(1);
    sim.dispose();
    buckets.dispose();
  });

  it('negative (PP): without the option the bucket keeps its full billboard and an identity turn', () => {
    const world = new Scene();
    const buckets = new FxStretchedBuckets({ world, atlas, capacity: 8, additiveFog: 'three' });
    const sim = createFxSimulation(compileProgram('fx\npop s burst=1 life=1 size=.1 v=<3,0,0> r=sprite(ember,add,velocity,.5)', {}, { low: false, mobile: false }), { seed: 2, capacity: 4 });
    buckets.update([sim]);
    const mesh = buckets.get('add')!;
    expect(mesh.material).not.toHaveProperty('vertexNode', null);
    const q = new Quaternion();
    new Matrix4().fromArray(mesh.instanceMatrix.array as Float32Array, 0).decompose(new Vector3(), q, new Vector3());
    expect(q.equals(new Quaternion())).toBe(true);
    sim.dispose();
    buckets.dispose();
  });
});

describe('fx held follow', () => {
  const run = (heldFollow: boolean) => {
    const { records, lights } = lightsSink();
    const atlas = placeholderAtlasTexture();
    const fx = createFxSystem({ world: new Scene(), camera: new Object3D(), atlas, budget: createRenderBudget('high'), lights, lightsOnly: true, ...(heldFollow ? { heldFollow: true } : {}) });
    // bound before the row is placed (the bridge binds while the row's matrix is still the identity)
    const node = new Object3D();
    node.updateMatrixWorld(true);
    fx.bind('torch', { script: TORCH }, node);
    node.position.set(4, 9, -6);
    node.updateMatrixWorld(true);
    fx.update({ dt: 0.016, now: 1000 });
    const light = fx.simulations[0]!.populations.find((p) => p.program.sink?.kind === 'light')!;
    const i = light.indices[0]! * 3;
    const at = [fx.simulations[0]!.positions[i]!, fx.simulations[0]!.positions[i + 1]!, fx.simulations[0]!.positions[i + 2]!];
    fx.dispose();
    return { at, records };
  };
  it('heldFollow: an at= glow and its light move with the row placed after the bind', () => {
    const { at } = run(true);
    expect(at[0]).toBeCloseTo(4);
    expect(at[1]).toBeCloseTo(9.2);
    expect(at[2]).toBeCloseTo(-6);
  });
  it('negative (PP): the glow stays where it was born', () => {
    const { at } = run(false);
    expect(at[0]).toBeCloseTo(0);
    expect(at[1]).toBeCloseTo(0.2);
  });
});
