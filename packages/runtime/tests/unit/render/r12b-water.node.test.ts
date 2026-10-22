// WP R12b (render §14.2): the WATER surface variant, its stage, and the water mesh builder.
import { describe, expect, it } from 'vitest';
import { uniform, uv } from 'three/tsl';
import { Vector3, type Material } from 'three/webgpu';
import {
  SurfaceVariant,
  type SurfaceInputs,
  type SurfaceInputStage,
  type SurfaceStageContext,
} from '../../../src/render/surface/surface-material.ts';
import {
  DEFAULT_WATER_TUNING,
  WATER_RENDER_ORDER,
  buildWaterMesh,
  registerWaterSurface,
  setWaterTime,
  waterStage,
  waterTime,
  waterVariant,
  type WaterOctave,
  type WaterSurfaceHost,
} from '../../../src/render/special/water.ts';

/** a minimal explicit fake for the injected `SurfaceMaterials` dependency */
function fakeHost(): WaterSurfaceHost & { stages: Map<number, SurfaceInputStage> } {
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
  return { variant: waterVariant(), textures: {}, paint: 'object' };
}

describe('waterVariant', () => {
  it('pairs SRC_PRIM with the WATER bit the R1a surface module owns, transparent', () => {
    expect(waterVariant()).toBe(SurfaceVariant.SRC_PRIM | SurfaceVariant.WATER | SurfaceVariant.TRANSPARENT);
    expect(SurfaceVariant.WATER).toBe(1 << 18);
  });
});

describe('registerWaterSurface', () => {
  it('registers the WATER stage exactly once per host', () => {
    const host = fakeHost();
    const bound = registerWaterSurface(host);
    expect(bound.variant).toBe(waterVariant());
    expect(bound.setTime).toBe(setWaterTime);
    expect(host.stages.has(SurfaceVariant.WATER)).toBe(true);
    expect(() => registerWaterSurface(host)).toThrow();
  });
});

describe('waterStage', () => {
  it('fills every material slot the variant needs: color, normal, roughness, metalness, opacity', () => {
    const inputs = stubInputs();
    const out = waterStage()(inputs, stubCtx());
    for (const slot of ['color', 'normal', 'roughness', 'metalness', 'opacity'] as const) {
      expect(out[slot], slot).not.toBeNull();
      expect(typeof out[slot], slot).toBe('object');
    }
  });

  it('keeps the tinted inputs it does not own: emissive passes through', () => {
    const inputs = stubInputs();
    const out = waterStage()(inputs, stubCtx());
    expect(out.emissive).toBe(inputs.emissive);
  });

  it('builds the normal through the view transform the stage comment promises', () => {
    // the stage computes a local normal then maps it with transformNormalToView; the harness
    // structural check asserts the call, here we pin the contract: normal is replaced, not tinted
    const inputs = stubInputs();
    const out = waterStage()(inputs, stubCtx());
    expect(out.normal).not.toBe(inputs.normal);
    expect(out.normal).not.toBeNull();
  });

  it('rejects a tuning that is not exactly two octaves', () => {
    const one = [DEFAULT_WATER_TUNING.octaves[0]!] as unknown as [WaterOctave, WaterOctave];
    expect(() => waterStage({ ...DEFAULT_WATER_TUNING, octaves: one })).toThrow(RangeError);
  });
});

describe('waterTime', () => {
  it('drives the scroll clock from the presentation time in seconds', () => {
    setWaterTime(2500);
    expect(waterTime.value).toBeCloseTo(2.5, 12);
    setWaterTime(0);
    expect(waterTime.value).toBe(0);
  });
});

describe('buildWaterMesh', () => {
  it('builds an axis-aligned XZ plane with metre uvs and no normal attribute', () => {
    const { group, meshes, dispose } = buildWaterMesh({ width: 200, depth: 120, y: 0, material: { name: 'water' } as unknown as Material });
    expect(meshes.length).toBe(1);
    expect(group.children.length).toBe(1);
    const g = meshes[0]!.geometry;
    const pos = g.getAttribute('position');
    const uvAttr = g.getAttribute('uv');
    expect(pos.itemSize).toBe(3);
    expect(uvAttr.itemSize).toBe(2);
    expect(g.getAttribute('normal')).toBeUndefined();
    const uvAbs = Array.from(uvAttr.array as Float32Array, Math.abs);
    expect(Math.max(...uvAbs)).toBeCloseTo(100, 6);
    const xs = Array.from((pos.array as Float32Array).filter((_, i) => i % 3 === 0));
    expect(Math.min(...xs)).toBeCloseTo(-100, 6);
    expect(Math.max(...xs)).toBeCloseTo(100, 6);
    dispose();
    expect(group.children.length).toBe(0);
  });

  it('sits at the transparent lift: renderOrder 3 and an explicit culling sphere', () => {
    const { meshes, dispose } = buildWaterMesh({ width: 60, depth: 80, y: 2, material: { name: 'water' } as unknown as Material });
    const m = meshes[0]!;
    expect(WATER_RENDER_ORDER).toBe(3);
    expect(m.renderOrder).toBe(3);
    expect(m.geometry.boundingSphere).not.toBeNull();
    expect(m.geometry.boundingSphere!.radius).toBeCloseTo(Math.hypot(60, 80) / 2, 6);
    expect(m.position.y).toBe(2);
    dispose();
  });

  it('stacks planes 2 cm apart when the ×3 reading needs three lifts', () => {
    const { meshes, dispose } = buildWaterMesh({ width: 10, depth: 10, material: { name: 'water' } as unknown as Material, stacks: 3 });
    expect(meshes.length).toBe(3);
    expect(meshes[1]!.position.y).toBeCloseTo(0.02, 9);
    expect(meshes[2]!.position.y).toBeCloseTo(0.04, 9);
    dispose();
  });
});
