// BootEnv.placeBake: a place module served as `{ default: { rows } }`, and a generator script outside the registry.
import { describe, expect, it } from 'vitest';
import { generatorWithModuleIndex, rowsOfPlaceModule } from '../../src/compat/physics/place-bake.ts';
import type { GeneratorModule } from '../../src/render/geometry/generator-types.ts';

const ROW = { id: 'a', spec: {} };

describe('rowsOfPlaceModule', () => {
  it('reads both the namespace and the default export; anything else is no rows', () => {
    expect(rowsOfPlaceModule({ rows: [ROW] })).toEqual([ROW]);
    expect(rowsOfPlaceModule({ default: { rows: [ROW] } })).toEqual([ROW]);
    expect(rowsOfPlaceModule(undefined)).toEqual([]);
    expect(rowsOfPlaceModule({ default: {} })).toEqual([]);
    expect(rowsOfPlaceModule({ default: { rows: 3 } })).toEqual([]);
  });
});

describe('generatorWithModuleIndex', () => {
  const inRegistry = { id: 'registry' } as unknown as GeneratorModule;
  const island = { id: 'island' } as unknown as GeneratorModule;
  const primary = async (s: string): Promise<GeneratorModule> => {
    if (s === 'scripts/gen/a.js') return inRegistry;
    throw new Error(`registry: unknown module ${s}`);
  };
  const load = generatorWithModuleIndex(primary, { './scripts/podium-island.js': async () => island });

  it('the registry first, then the index (keys and names normalised alike)', async () => {
    expect(await load('scripts/gen/a.js')).toBe(inRegistry);
    expect(await load('scripts/podium-island.js')).toBe(island);
    expect(await load('/scripts/podium-island.js')).toBe(island);
  });
  it('negative: a script in neither fails with the registry error', async () => {
    await expect(load('scripts/gen/missing.js')).rejects.toThrow('registry: unknown module scripts/gen/missing.js');
  });
});
