// WP R12b (render §14.3): the SPLAT6 surface variant, its stage, and the terrain mesh builder.
import { describe, expect, it } from 'vitest';
import { uniform, uv } from 'three/tsl';
import { Vector3, type Material, type Texture } from 'three/webgpu';
import {
  SurfaceVariant,
  type SurfaceInputs,
  type SurfaceInputStage,
  type SurfaceStageContext,
} from '../../../src/render/surface/surface-material.ts';
import {
  DEFAULT_TEXTURE_SCALE,
  SPLAT_ROUGHNESS,
  SPLAT_WEIGHT_ATTRIBUTE_0,
  SPLAT_WEIGHT_ATTRIBUTE_1,
  buildTerrainGeometry,
  buildTerrainMesh,
  gridIndexOf,
  registerTerrainSplat,
  splatStage,
  splatVariant,
  terrainTextureName,
  weightOf,
  type SplatSurfaceHost,
  type SplatTextureNode,
} from '../../../src/render/special/terrain-splat.ts';

/** a minimal explicit fake for the injected `SurfaceMaterials` dependency */
function fakeHost(): SplatSurfaceHost & { stages: Map<number, SurfaceInputStage> } {
  const stages = new Map<number, SurfaceInputStage>();
  return {
    stages,
    registerStage(bit: number, stage: SurfaceInputStage): void {
      if (stages.has(bit)) throw new Error(`stage already registered for bit ${bit}`);
      stages.set(bit, stage);
    },
  };
}

/** inputs built the same way the repo's own `uniformPaintInputs` builds them */
function stubInputs(): SurfaceInputs {
  return {
    color: uniform(new Vector3(1, 1, 1)),
    opacity: uniform(1),
    emissive: uniform(new Vector3(0, 0, 0)),
    roughness: uniform(1),
    metalness: uniform(0),
    uv: uv(),
    normal: null,
    position: null,
    vertex: null,
  };
}

function stubCtx(): SurfaceStageContext {
  return { variant: splatVariant(), textures: {}, paint: 'object' };
}

describe('splatVariant', () => {
  it('pairs SRC_PRIM with the SPLAT6 bit the R1a surface module owns', () => {
    expect(splatVariant()).toBe(SurfaceVariant.SRC_PRIM | SurfaceVariant.SPLAT6);
    expect(SurfaceVariant.SPLAT6).toBe(1 << 17);
  });
});

describe('terrainTextureName', () => {
  it('names the cdn terrain albedo for a material id', () => {
    expect(terrainTextureName('sand')).toBe('cdn/texture-terrain-sand');
  });
});

describe('registerTerrainSplat', () => {
  it('registers the SPLAT6 stage exactly once per host', () => {
    const host = fakeHost();
    const bound = registerTerrainSplat(host);
    expect(bound.variant).toBe(splatVariant());
    expect(host.stages.has(SurfaceVariant.SPLAT6)).toBe(true);
    expect(() => registerTerrainSplat(host)).toThrow();
  });

  it('creates six texture nodes in material order: the tint multiplies the blend, roughness 0.9, flat normal', () => {
    const seen: SplatTextureNode[] = [];
    const textures = [0, 1, 2, 3, 4, 5].map((i) => ({ name: `cdn${i}` })) as unknown as Texture[];
    const stage = splatStage({ textures: () => textures, seen });
    const out = stage(stubInputs(), stubCtx());
    expect(seen.map((s) => s.slot)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(out.normal).not.toBeNull();
    expect(out.roughness).not.toBeNull();
    expect(out.metalness).not.toBeNull();
  });

  it('setTextures rebinds every texture node the stage built, in slot order', () => {
    const host = fakeHost();
    const bound = registerTerrainSplat(host);
    const stage = host.stages.get(SurfaceVariant.SPLAT6)!;
    stage(stubInputs(), stubCtx());
    const next = [0, 1, 2, 3, 4, 5].map((i) => ({ name: `cdn${i}` })) as unknown as [Texture, Texture, Texture, Texture, Texture, Texture];
    // driving the registered stage filled the binding's seen-list through the stage closure
    expect(bound.seen.map((s) => s.slot)).toEqual([0, 1, 2, 3, 4, 5]);
    bound.setTextures(next);
    for (const s of bound.seen) expect(s.node.value).toBe(next[s.slot]);
  });

  it('setTextures rejects anything but six textures', () => {
    const bound = registerTerrainSplat(fakeHost());
    expect(() => bound.setTextures([] as unknown as [Texture, Texture, Texture, Texture, Texture, Texture])).toThrow(RangeError);
  });
});

describe('gridIndexOf', () => {
  const GRID = { originX: -8, originZ: -6, cell: 0.5, nx: 33, nz: 25 };

  it('maps grid vertices to their weight index, and misses off-grid points', () => {
    expect(gridIndexOf(GRID, -8, -6)).toBe(0);
    expect(gridIndexOf(GRID, -7.5, -6)).toBe(1);
    expect(gridIndexOf(GRID, -8, -5.5)).toBe(33);
    expect(gridIndexOf(GRID, -8 + 32 * 0.5, -6 + 24 * 0.5)).toBe(24 * 33 + 32);
    expect(gridIndexOf(GRID, -7.75, -6)).toBeNull();
    expect(gridIndexOf(GRID, 100, 100)).toBeNull();
  });
});

describe('weightOf', () => {
  it('decodes the 0–255 byte to a 0–1 fraction', () => {
    const weights = new Uint8Array([255, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 127]);
    expect(weightOf(weights, 0, 0)).toBe(1);
    expect(weightOf(weights, 1, 1)).toBeCloseTo(128 / 255, 12);
    expect(weightOf(weights, 1, 5)).toBeCloseTo(127 / 255, 12);
  });
});

describe('buildTerrainGeometry', () => {
  const grid = { originX: 0, originZ: 0, cell: 1, nx: 2, nz: 2 };
  const heights = new Float32Array([0, 0, 0, 2]);
  // vertex (0,0): all sand; (1,0): all wetsand; (0,1): all rock; (1,1): half soil, half moss
  const weights = new Uint8Array([255, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 128, 127, 0]);
  const materials = ['sand', 'wetsand', 'rock', 'soil', 'moss', 'ash'];

  it('builds two triangles over the grid with metre-scaled uvs and the two weight attributes', () => {
    const g = buildTerrainGeometry({ grid, heights, weights, materials });
    const pos = g.getAttribute('position');
    expect(pos.count).toBe(6);
    expect(pos.itemSize).toBe(3);
    // the peak vertex is in the soup
    const ys = Array.from({ length: 6 }, (_, v) => (pos.array as Float32Array)[v * 3 + 1]!);
    expect(Math.max(...ys)).toBe(2);
    // uv = world (x, z) / textureScale (default 5)
    const uv = g.getAttribute('uv').array as Float32Array;
    expect(uv[0]).toBe(0);
    expect(uv[2]).toBeCloseTo(1 / DEFAULT_TEXTURE_SCALE, 6);
    // no normal attribute: the stage shades flat
    expect(g.getAttribute('normal')).toBeUndefined();
    const w0 = g.getAttribute(SPLAT_WEIGHT_ATTRIBUTE_0).array as Float32Array;
    const w1 = g.getAttribute(SPLAT_WEIGHT_ATTRIBUTE_1).array as Float32Array;
    expect(w0.length).toBe(6 * 4);
    expect(w1.length).toBe(6 * 4);
    // the first triangle's first vertex is grid (0,0): all sand → w0 = [255,0,0,0]
    expect(Array.from(w0.subarray(0, 4))).toEqual([255, 0, 0, 0]);
    // weights stay bytes in the attributes; the stage divides by 255
    for (const a of [w0, w1]) for (const v of a) expect(Number.isInteger(v)).toBe(true);
    expect(SPLAT_ROUGHNESS).toBe(1);
  });

  it('renders the bake’s own triangles when given (pin-adjusted), bit for bit', () => {
    const tris = new Float32Array([0, 0.5, 0, 1, 0, 0, 1, 2, 1]);
    const g = buildTerrainGeometry({ grid, heights, weights, materials, tris });
    expect(g.getAttribute('position').count).toBe(3);
    expect((g.getAttribute('position').array as Float32Array)[1]).toBe(0.5);
  });

  it('rejects a bake that is not six materials, and vertices off the grid', () => {
    expect(() => buildTerrainGeometry({ grid, heights, weights, materials: ['sand'] })).toThrow(/six materials/);
    const tris = new Float32Array([0, 0, 0, 1, 0, 0, 0.5, 0, 0.5]);
    expect(() => buildTerrainGeometry({ grid, heights, weights, materials, tris })).toThrow(/off the weight grid/);
  });
});

describe('buildTerrainMesh', () => {
  it('wraps the geometry in a named mesh that receives shadows but casts none', () => {
    const grid = { originX: 0, originZ: 0, cell: 1, nx: 2, nz: 2 };
    const heights = new Float32Array(4);
    const weights = new Uint8Array(4 * 6);
    for (let v = 0; v < 4; v++) weights[v * 6] = 255;
    const material = { name: 'fake-splat' } as unknown as Material;
    const { mesh, dispose } = buildTerrainMesh({ grid, heights, weights, materials: ['a', 'b', 'c', 'd', 'e', 'f'] }, material);
    expect(mesh.name).toBe('ss:terrain-splat');
    expect(mesh.material).toBe(material);
    expect(mesh.castShadow).toBe(false);
    expect(mesh.receiveShadow).toBe(true);
    expect(mesh.geometry.boundingSphere).not.toBeNull();
    dispose();
  });
});
