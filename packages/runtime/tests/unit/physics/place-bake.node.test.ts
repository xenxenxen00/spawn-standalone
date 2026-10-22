// The runtime PlaceBake producer (compat/physics/place-bake.ts): colliders built at boot from a place's scene rows when no baked
// data is supplied, so a body standing on a static arena row does not fall. Negative control: without the producer it does.
import { afterEach, describe, expect, it } from 'vitest';
import { bakePlaceColliders, generatorColliders, PlaceBakeError, withRuntimePlaceBake } from '../../../src/compat/physics/place-bake.ts';
import { emptyPlaceBake } from '../../../src/compat/core/null-ports.ts';
import type { AssetFactsPort, PlaceBake } from '../../../src/compat/core/ports.ts';
import type { GeneratorModule } from '../../../src/render/geometry/generator-types.ts';
import type { ObjectView } from '../../../src/compat/core/types.ts';
import { ensurePhysics } from '../../../src/compat/physics/port.ts';
import { kernelWorld, LIVE_PLAYER_PHYSICS, type KernelWorld, type MiniCtx } from './kernel-fixture.ts';
import { GRAVITY } from './rapier-fixtures.ts';

const FALL = 'scripts/test/fall.js';

const FLOOR_GEN: GeneratorModule = { collider: () => ({ kind: 'box', width: 24, height: 1, depth: 24 }) } as unknown as GeneratorModule;
const load = async (script: string): Promise<GeneratorModule> => {
  if (script !== 'gen/floor.js') throw new Error(`no generator ${script}`);
  return FLOOR_GEN;
};
// a 24 x 1 x 24 box standing on the row's feet, which are 1 m under the origin: its top face is the y = 0 plane
const ARENA = { id: 'arena', spec: { feetPosition: { x: 0, y: -1, z: 0 }, physics: { body: 'static', collider: 'mesh' }, primitive: { kind: 'scripted', script: 'gen/floor.js' } } };
const nullAssets = (): AssetFactsPort => ({ get: () => undefined, placeBake: (p) => Promise.resolve(emptyPlaceBake(p)) });
const producer = (inner: AssetFactsPort = nullAssets(), rows = [ARENA]): AssetFactsPort =>
  withRuntimePlaceBake(inner, { rows: async () => rows, colliderOf: generatorColliders(load) });

let w: KernelWorld | undefined;
afterEach(() => w?.dispose());

type V = { x: number; y: number; z: number };
async function drop(assets: AssetFactsPort | null): Promise<number> {
  await ensurePhysics();
  w = await kernelWorld({
    places: { yard: { rows: [ARENA] } },
    modules: {
      [FALL]: {
        update: (ctx: MiniCtx, dt: number) => {
          const self = ctx.self as ObjectView & { velocity: V };
          self.velocity = { x: 0, y: self.velocity.y + GRAVITY * dt, z: 0 };
        },
      },
    },
    player: { tags: ['player', 'teammate'], physics: LIVE_PLAYER_PHYSICS, behavior: FALL },
  });
  if (assets) (w.k.ports as { assets: AssetFactsPort }).assets = assets;
  await w.enter('yard');
  const body = w.human('yard', { x: 0, y: 0.5, z: 0 });
  const self = w.k.store.handle(body, body.vm) as ObjectView & { feetPosition: V };
  w.ticks(60);
  return self.feetPosition.y;
}

describe('runtime place bake', () => {
  it('builds a collider instance for a static mesh row, at its feet, with a shared key', async () => {
    const twin = { id: 'twin', spec: { ...ARENA.spec, feetPosition: { x: 5, y: -1, z: 0 } } };
    const bake: PlaceBake = await bakePlaceColliders('yard', [ARENA, twin, { id: 'other', spec: { primitive: { kind: 'box' } } }], generatorColliders(load));
    expect(bake.colliders.keys.map((k) => k.box)).toEqual([[24, 1, 24]]);
    expect(bake.colliders.instances.map((i) => [i.rowId, i.key, i.mutable, Array.from(i.m.subarray(9))])).toEqual([
      ['arena', 0, false, [0, -1, 0]],
      ['twin', 0, false, [5, -1, 0]],
    ]);
  });

  it('refuses a rotated row instead of dropping its collider', async () => {
    await expect(bakePlaceColliders('yard', [{ id: 'r', spec: { ...ARENA.spec, rotation: { yaw: 1 } } }], generatorColliders(load))).rejects.toThrow(PlaceBakeError);
  });

  it('a body standing on the baked arena does not fall', async () => {
    const y = await drop(producer());
    expect(y).toBeGreaterThan(-0.05);
    expect(y).toBeLessThan(0.05);
  });

  it('negative control: without the producer the same body falls through', async () => {
    expect(await drop(null)).toBeLessThan(-3);
  });

  it('a supplied bake with colliders is left alone', async () => {
    const supplied = emptyPlaceBake('yard');
    supplied.colliders.keys.push({ id: 'k', box: [1, 1, 1] });
    const out = await producer({ get: () => undefined, placeBake: () => Promise.resolve(supplied) }).placeBake('yard');
    expect(out).toBe(supplied);
  });
});
