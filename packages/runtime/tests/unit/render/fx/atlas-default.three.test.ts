// The built-in fx atlas (opt-in): its pixels, and setupFxRuntime's fallback to it.
import { describe, expect, it } from 'vitest';
import type { Texture } from 'three/webgpu';
import { generateDefaultAtlas } from '../../../../src/render/fx/atlas-default.ts';
import { defaultAtlasTexture } from '../../../../src/render/fx/atlas-texture.ts';
import { FX_TEXTURES } from '../../../../src/render/fx/dsl/compile.ts';
import { setupFxRuntime, type FxSetupHost } from '../../../../src/render/fx/fx-setup.ts';
import type { FxRuntime, FxSystemOptions } from '../../../../src/render/fx/fx-system.ts';
import type { TierConfig } from '../../../../src/render/perf/budget.ts';

describe('generateDefaultAtlas', () => {
  const cell = 32;
  const a = generateDefaultAtlas(cell);
  const alphaAt = (i: number, px: number, py: number): number => a.data[(((Math.floor(i / 4) * cell + py) * a.width) + (i % 4) * cell + px) * 4 + 3]!;
  it('is a 4 x 4 grid of white tiles with the shape in alpha, deterministic', () => {
    expect(a.width).toBe(cell * 4);
    expect(a.data.length).toBe(a.width * a.height * 4);
    expect(Array.from(generateDefaultAtlas(cell).data.subarray(0, 4096))).toEqual(Array.from(a.data.subarray(0, 4096)));
    for (let p = 0; p < a.data.length; p += 4) if (a.data[p + 3]! > 0) expect([a.data[p], a.data[p + 1], a.data[p + 2]]).toEqual([255, 255, 255]);
  });
  it('draws every one of the 14 DSL textures, clear of its tile edge (no bleed under linear filtering)', () => {
    expect(FX_TEXTURES).toHaveLength(14);
    FX_TEXTURES.forEach((name, i) => {
      let sum = 0;
      for (let py = 0; py < cell; py++) for (let px = 0; px < cell; px++) sum += alphaAt(i, px, py);
      expect(sum, name).toBeGreaterThan(cell * 2 * 10);
      for (let k = 0; k < cell; k++) for (const [px, py] of [[k, 0], [k, cell - 1], [0, k], [cell - 1, k]] as const) expect(alphaAt(i, px, py), `${name} edge`).toBeLessThan(8);
    });
    // tiles 14 and 15 are unused: empty
    expect(alphaAt(14, 16, 16)).toBe(0);
  });
  it('soft-disc is brightest in the middle; droplet is pointed upward (+y is up)', () => {
    expect(alphaAt(0, 16, 16)).toBeGreaterThan(alphaAt(0, 16, 6));
    const width = (i: number, py: number): number => Array.from({ length: cell }, (_, px) => alphaAt(i, px, py)).filter((v) => v > 100).length;
    const droplet = FX_TEXTURES.indexOf('droplet');
    expect(width(droplet, 8)).toBeGreaterThan(width(droplet, 26));
  });
  it('wraps into a linear, mipmap-free sRGB DataTexture', () => {
    const t = defaultAtlasTexture();
    expect(t.image.width).toBe(256);
    expect(t.generateMipmaps).toBe(false);
    t.dispose();
  });
});

describe('setupFxRuntime with the built-in atlas', () => {
  function host(over: Partial<FxSetupHost>) {
    const logs: string[] = [];
    const atlases: unknown[] = [];
    const builtin = { dispose: () => logs.push('builtin-disposed') } as unknown as Texture;
    const h: FxSetupHost = {
      resolveAtlas: () => null,
      loadAtlas: async () => {
        throw new Error('nothing to load');
      },
      world: {} as never,
      camera: {} as never,
      tier: () => 'high',
      tierConfig: () => ({}) as TierConfig,
      lighting: null,
      lights: null,
      create: (o: FxSystemOptions) => {
        atlases.push(o.atlas);
        return { dispose: () => logs.push('fx-disposed') } as unknown as FxRuntime;
      },
      log: (m) => logs.push(m),
      ...over,
    };
    return { h, logs, atlases, builtin };
  }
  it('off (default): no atlas means null fx (negative control)', async () => {
    const t = host({});
    expect((await setupFxRuntime(t.h)).fx).toBeNull();
    expect(t.atlases).toEqual([]);
  });
  it('on: an unresolved atlas builds fx on the generated one and disposes it', async () => {
    const t = host({});
    const s = await setupFxRuntime({ ...t.h, builtinAtlas: () => t.builtin });
    expect(s.fx).not.toBeNull();
    expect(t.atlases).toEqual([t.builtin]);
    s.dispose();
    expect(t.logs.filter((l) => l.endsWith('disposed'))).toEqual(['fx-disposed', 'builtin-disposed']);
  });
  it('on: a game atlas that resolves and loads wins; one that fails to load falls back', async () => {
    const t = host({});
    const game = { dispose() {} } as unknown as Texture;
    await setupFxRuntime({ ...t.h, resolveAtlas: () => 'game.png', loadAtlas: async () => game, builtinAtlas: () => t.builtin });
    expect(t.atlases).toEqual([game]);
    await setupFxRuntime({ ...t.h, resolveAtlas: () => 'game.png', builtinAtlas: () => t.builtin });
    expect(t.atlases).toEqual([game, t.builtin]);
  });
});
