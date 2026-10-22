import { afterEach, describe, expect, it } from 'vitest';
import { DataTexture, Object3D, RGBAFormat, Scene, UnsignedByteType } from 'three/webgpu';
import { createRenderBudget } from '../../../../src/render/perf/budget.ts';
import { createFxSystem, type FxSystemOptions } from '../../../../src/render/fx/fx-system.ts';
import type { BridgeLights } from '../../../../src/render/bridge/bridge-types.ts';
import type { LightHandle, LightRecord } from '../../../../src/render/lighting/light-table.ts';

const atlas = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType);
const records: LightRecord[] = [];
const removed: LightHandle[] = [];
let nextLight = 1;
const lights: BridgeLights = {
  add(record) { records.push(record); return nextLight++ as LightHandle; },
  remove(handle) { removed.push(handle); },
  setIntensity() {}, setColor() {}, setPose() {},
};

function createSystem(overrides: Partial<FxSystemOptions> = {}) {
  const world = new Scene();
  const camera = new Object3D();
  const base: FxSystemOptions = { world, camera, atlas, budget: createRenderBudget('high'), lights };
  const system = createFxSystem({ ...base, ...overrides });
  return { world, camera, system };
}

describe('FX runtime', () => {
  afterEach(() => {
    records.length = 0;
    removed.length = 0;
    nextLight = 1;
  });

  it('binds to a row transform and restarts or ends the effect on bridge writes', () => {
    const node = new Object3D();
    node.position.set(4, 2, -3);
    node.updateMatrixWorld(true);
    const { system } = createSystem();
    const binding = system.bind('row-1', { script: 'fx\npop flash burst=2 life=1 r=sprite(ember,add)' }, node);
    expect(binding).not.toBeNull();
    expect(system.particleCount).toBe(2);
    expect(system.simulations[0]?.positions[0]).toBeCloseTo(4);
    expect(system.simulations[0]?.positions[1]).toBeCloseTo(2);
    binding!.restart({ script: 'fx\npop held n=3 life=1 r=sprite(soft-disc,alpha)' });
    expect(system.particleCount).toBe(3);
    system.update({ dt: 0, now: 1000 });
    expect(system.sprites.get('alpha')?.visible).toBe(true);
    binding!.end();
    expect(system.effectCount).toBe(0);
    system.dispose();
  });

  it('writes light sinks to the grid bridge and removes their handles without creating Three lights', () => {
    const { world, system } = createSystem();
    const id = system.emit({ script: 'fx\npop flash burst=1 life=.1 col=<1,.5,.25> r=light(<1,.5,.25>,2,5)' }, [7, 1, -2]);
    expect(id).not.toBeNull();
    system.update({ dt: 0, now: 1000 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ source: 'fx', mobility: 'transient', intensity: 2, distance: 5, position: { x: 7, y: 1, z: -2 } });
    expect(world.children.some((child) => (child as Object3D & { isLight?: boolean }).isLight === true)).toBe(false);
    system.end(id!);
    expect(removed).toHaveLength(1);
    system.dispose();
  });

  it('draws mesh sinks in the world bucket with origin-independent culling', () => {
    const { world, system } = createSystem();
    const id = system.emit({ script: 'fx\npop drops burst=3 life=1 size=1 col=hdr(2,.5,.25) r=mesh(box,1,.5,2)' }, [0, 3, 0]);
    expect(id).not.toBeNull();
    system.update({ dt: 0, now: 1000 });
    const mesh = world.children.find((child) => child.name.startsWith('ss:primitives:')) as (Object3D & { count?: number; frustumCulled?: boolean }) | undefined;
    expect(mesh).toBeDefined();
    expect(mesh?.count).toBe(3);
    expect(mesh?.frustumCulled).toBe(false);
    system.dispose();
  });

  it('shares the tier-wide particle ceiling across concurrent effects', () => {
    const { system } = createSystem();
    const decapitation = { script: 'fx\npop gibs burst=20000 life=1' };
    expect(system.emit(decapitation)).not.toBeNull();
    expect(system.emit(decapitation)).not.toBeNull();
    expect(system.particleCount).toBe(30_000);
    system.dispose();
  });

  it('has() reports the runtime\'s live effects: true after emit, false after end or update', () => {
    const { system } = createSystem();
    const id = system.emit({ script: 'fx\npop flash burst=1 life=1' }, [0, 0, 0]);
    expect(id).not.toBeNull();
    expect(system.has(id!)).toBe(true);
    system.end(id!);
    expect(system.has(id!)).toBe(false);
    // a one-shot that runs its course is removed by update, the way the act router's pruning expects
    const oneShot = system.emit({ script: 'fx\npop flash burst=1 life=.1' }, [0, 0, 0]);
    expect(oneShot).not.toBeNull();
    expect(system.has(oneShot!)).toBe(true);
    for (let i = 0; i < 8 && system.effectCount > 0; i++) system.update({ dt: 1, now: 1000 + i * 1000 });
    expect(system.effectCount).toBe(0);
    expect(system.has(oneShot!)).toBe(false);
    system.dispose();
  });
});
