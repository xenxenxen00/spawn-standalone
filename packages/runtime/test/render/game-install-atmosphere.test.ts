// K14: the atmosphere options of createRenderer reach the atmosphere of installGame; the default stays PP's night.
import { describe, expect, it, vi } from 'vitest';

vi.mock('virtual:ss/vendor', () => ({ vendor: {} }));
import { worldAtmosphereOption } from '../../src/render/world/install.ts';
import { createAtmosphere } from '../../src/render/atmosphere/atmosphere.ts';
import { createSceneRoot } from '../../src/render/scene/scene-root.ts';

const atmosphereFor = (host: Parameters<typeof worldAtmosphereOption>[0]) => createAtmosphere({ root: createSceneRoot(), warn: () => undefined, ...(worldAtmosphereOption(host).atmosphere ?? {}) });

describe('worldAtmosphereOption', () => {
  it("model 'daylight' (with its sun options) gives the daylight atmosphere", () => {
    expect(worldAtmosphereOption({ atmosphereOptions: { model: 'daylight', sunSlot: 1, sunDistance: 90 } })).toEqual({ atmosphere: { model: 'daylight', sunSlot: 1, sunDistance: 90 } });
    expect(atmosphereFor({ atmosphereOptions: { model: 'daylight' } }).model).toBe('daylight');
  });
  it('negative: no options, or no model, stays the night model', () => {
    expect(worldAtmosphereOption({})).toEqual({});
    expect(worldAtmosphereOption({ atmosphereOptions: {} })).toEqual({});
    expect(atmosphereFor({}).model).toBe('night');
    expect(atmosphereFor({ atmosphereOptions: {} }).model).toBe('night');
  });
});
