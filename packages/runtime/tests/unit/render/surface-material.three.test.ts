// WP R1a (render §7.2): the `SurfaceVariant` bitset, the variant cache and the per-object paint. Node + three, no renderer.
// One material per structural variant: identical keys return the same instance, anything structural (transparent, side, flat
// shading, a texture present or not) is a different one, and per-object values never create a material.
import { float, mix, positionLocal, setCurrentStack, stack, vec3, vec4 } from 'three/tsl';
import { BackSide, DataTexture, DoubleSide, FrontSide, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, Object3D, PlaneGeometry, Vector2, Vector3 } from 'three/webgpu';
import type { Node, NodeBuilder } from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { calibration, resetCalibration } from '../../../src/render/calibration.ts';
import { installSkySampler } from '../../../src/render/surface/env-term.ts';
import { ScriptLightingModel } from '../../../src/render/surface/script-lighting-model.ts';
import type { LightingScript } from '../../../src/render/surface/script-types.ts';
import {
  SURFACE_SRC_MASK,
  SURFACE_TEX_SLOTS_MASK,
  SURFACE_VARIANT_MASK,
  SurfaceMaterial,
  SurfaceMaterials,
  SurfaceVariant as V,
  UnlitSurfaceMaterial,
  defaultSurfacePaint,
  describeVariant,
  setSurfacePaint,
  surfacePaintOf,
  surfaceWet,
  texSlotCount,
  variantIsFlatShaded,
  variantPaintSource,
  variantSide,
  type SurfaceInputStage,
} from '../../../src/render/surface/surface-material.ts';

const script: LightingScript = { lighting: (_s, l) => l.ambient };
const cache = (): SurfaceMaterials => new SurfaceMaterials({ script });
const tex = (): DataTexture => new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);

/** the part of a `UniformNode` this test drives (three's own `update` is typed for a full `NodeFrame`) */
interface UniformLike {
  value: unknown;
  update?: (frame: { object: Object3D | null }) => unknown;
  isUniformNode?: boolean;
}

/** every uniform under a node that has an update hook (the per-object paint uniforms) */
function objectUniforms(root: Node | null): UniformLike[] {
  const out: UniformLike[] = [];
  root?.traverse((n) => {
    const u = n as unknown as UniformLike;
    if (u.isUniformNode === true && typeof u.update === 'function' && !out.includes(u)) out.push(u);
  });
  return out;
}

/** what three does before a draw of `object`: run the update hook of an object-scoped uniform */
function updateFor(u: UniformLike, object: Object3D): unknown {
  const returned = u.update!({ object });
  if (returned !== undefined) u.value = returned;
  return u.value;
}

afterEach(() => {
  resetCalibration();
  installSkySampler(null);
  setCurrentStack(null);
});

describe('SurfaceVariant: the bitset (render §7.2)', () => {
  it('names every bit of the design table, each a distinct bit (the slot-texture count is a 2-bit field)', () => {
    const names = Object.keys(V);
    for (const n of ['SRC_PACKED', 'SRC_GLTF', 'SRC_PRIM', 'NORMALS', 'TEX_ALBEDO', 'TEX_NORMAL', 'TEX_ORM', 'TRIPLANAR', 'UV_TILE', 'TEX_SLOTS_1', 'TEX_SLOTS_2', 'TEX_SLOTS_3', 'SLOTS', 'PARTMASK', 'TRANSPARENT', 'ALPHA_TEST', 'VIEWMODEL', 'DECAL', 'SPLAT6', 'WATER', 'UNLIT']) {
      expect(names, n).toContain(n);
    }
    const single = Object.entries(V).filter(([n]) => !n.startsWith('TEX_SLOTS_'));
    for (const [n, bit] of single) expect(bit !== 0 && (bit & (bit - 1)) === 0, `${n} is one bit`).toBe(true);
    expect(new Set(single.map(([, b]) => b)).size).toBe(single.length);
    for (const [n, bit] of single) expect(bit & SURFACE_TEX_SLOTS_MASK, n).toBe(0);
    expect([texSlotCount(V.TEX_SLOTS_1), texSlotCount(V.TEX_SLOTS_2), texSlotCount(V.TEX_SLOTS_3), texSlotCount(V.SRC_GLTF)]).toEqual([1, 2, 3, 0]);
    expect(SURFACE_SRC_MASK).toBe(V.SRC_PACKED | V.SRC_GLTF | V.SRC_PRIM);
    // fits a 32-bit integer with room to spare
    expect(SURFACE_VARIANT_MASK).toBeLessThan(2 ** 30);
  });

  it('the numbering is fixed: later packages add stages, they never renumber', () => {
    expect(V).toEqual({
      SRC_PACKED: 1,
      SRC_GLTF: 2,
      SRC_PRIM: 4,
      NORMALS: 8,
      TEX_ALBEDO: 16,
      TEX_NORMAL: 32,
      TEX_ORM: 64,
      TRIPLANAR: 128,
      UV_TILE: 256,
      TEX_SLOTS_1: 512,
      TEX_SLOTS_2: 1024,
      TEX_SLOTS_3: 1536,
      SLOTS: 2048,
      PARTMASK: 4096,
      TRANSPARENT: 8192,
      ALPHA_TEST: 16384,
      VIEWMODEL: 32768,
      DECAL: 65536,
      SPLAT6: 131072,
      WATER: 262144,
      UNLIT: 524288,
      SIDE_BACK: 1048576,
      SIDE_DOUBLE: 2097152,
      ROW_PAINT: 4194304,
    });
  });

  it('describes a variant, and derives flat shading and side from it', () => {
    expect(describeVariant(V.SRC_PRIM | V.TRANSPARENT | V.SIDE_DOUBLE)).toBe('SRC_PRIM|TRANSPARENT|SIDE_DOUBLE');
    expect(describeVariant(V.SRC_GLTF | V.TEX_SLOTS_2 | V.SLOTS)).toBe('SRC_GLTF|SLOTS|TEX_SLOTS_2');
    expect(variantIsFlatShaded(V.SRC_PACKED)).toBe(true);
    expect(variantIsFlatShaded(V.SRC_PACKED | V.NORMALS)).toBe(false);
    expect(variantIsFlatShaded(V.SRC_PRIM)).toBe(false);
    expect(variantIsFlatShaded(V.SRC_GLTF)).toBe(false);
    expect([variantSide(V.SRC_PRIM), variantSide(V.SRC_PRIM | V.SIDE_BACK), variantSide(V.SRC_PRIM | V.SIDE_DOUBLE)]).toEqual([FrontSide, BackSide, DoubleSide]);
  });

  it('refuses a variant that is not well formed', () => {
    const c = cache();
    expect(() => c.get({ variant: 0 })).toThrow(/exactly one SRC_\*/);
    expect(() => c.get({ variant: V.SRC_PRIM | V.SRC_GLTF })).toThrow(/exactly one SRC_\*/);
    expect(() => c.get({ variant: V.SRC_PRIM | V.SIDE_BACK | V.SIDE_DOUBLE })).toThrow(/exclude each other/);
    expect(() => c.get({ variant: V.SRC_PRIM | V.NORMALS })).toThrow(/NORMALS qualifies SRC_PACKED/);
    expect(() => c.get({ variant: V.SRC_PRIM | V.ROW_PAINT })).toThrow(/ROW_PAINT qualifies SRC_PACKED/);
    expect(() => c.get({ variant: V.SRC_GLTF | V.ROW_PAINT })).toThrow(/ROW_PAINT qualifies SRC_PACKED/);
    expect(() => c.get({ variant: V.SRC_PRIM | (1 << 25) })).toThrow(/unknown bits/);
    expect(() => c.get({ variant: 4.5 })).toThrow(RangeError);
    expect(c.size).toBe(0);
  });
});

describe('the variant cache', () => {
  it('an identical bitset returns the same material', () => {
    const c = cache();
    const a = c.get({ variant: V.SRC_PRIM });
    expect(c.get({ variant: V.SRC_PRIM })).toBe(a);
    expect(c.get({ variant: V.SRC_PRIM, textures: {}, state: {} })).toBe(a);
    expect(c.get({ variant: V.SRC_PRIM, state: { depthWrite: true, depthTest: true, polygonOffset: false } })).toBe(a);
    expect(c.size).toBe(1);
    // each cache owns its materials
    expect(cache().get({ variant: V.SRC_PRIM })).not.toBe(a);
  });

  it('transparent, side and flat shading are structural: a different material each', () => {
    const c = cache();
    c.registerStage(V.SRC_PACKED, (inputs) => inputs);
    const base = c.get({ variant: V.SRC_PRIM });
    const transparent = c.get({ variant: V.SRC_PRIM | V.TRANSPARENT });
    const double = c.get({ variant: V.SRC_PRIM | V.SIDE_DOUBLE });
    const back = c.get({ variant: V.SRC_PRIM | V.SIDE_BACK });
    const flat = c.get({ variant: V.SRC_PACKED });
    const smooth = c.get({ variant: V.SRC_PACKED | V.NORMALS });
    const all = [base, transparent, double, back, flat, smooth];
    expect(new Set(all).size).toBe(6);
    expect(c.size).toBe(6);
    expect(all.map((m) => m.transparent)).toEqual([false, true, false, false, false, false]);
    expect(all.map((m) => m.side)).toEqual([FrontSide, FrontSide, DoubleSide, BackSide, FrontSide, FrontSide]);
    expect(all.map((m) => (m as SurfaceMaterial).flatShading)).toEqual([false, false, false, false, true, false]);
    expect(transparent.opacityNode).not.toBeNull();
    expect(base.opacityNode).toBeNull();
    // three's own cache key separates them too (it reads the material's string properties)
    expect(new Set(all.map((m) => m.variantKey)).size).toBe(6);
    for (const m of all) expect(m.variant).toBe(all.indexOf(m) < 4 ? [V.SRC_PRIM, V.SRC_PRIM | V.TRANSPARENT, V.SRC_PRIM | V.SIDE_DOUBLE, V.SRC_PRIM | V.SIDE_BACK][all.indexOf(m)] : m === flat ? V.SRC_PACKED : V.SRC_PACKED | V.NORMALS);
  });

  it('uniform value changes create no new material: the paint lives on the object', () => {
    const c = cache();
    const material = c.get({ variant: V.SRC_PRIM });
    const a = new Mesh(new PlaneGeometry(1, 1), material);
    const b = new Mesh(new PlaneGeometry(1, 1), material);
    setSurfacePaint(a, { color: [1, 0, 0], roughness: 0.2 });
    setSurfacePaint(b, { color: [0, 0, 1], roughness: 0.9, metalness: 1, emissive: [2, 3, 4] });
    setSurfacePaint(a, { color: [0, 1, 0] });
    expect(c.get({ variant: V.SRC_PRIM })).toBe(material);
    expect(c.size).toBe(1);

    // the material's uniforms read the object that is being drawn
    const lit = material as SurfaceMaterial;
    const colour = objectUniforms(lit.colorNode)[0]!;
    expect((updateFor(colour, a) as Vector3).toArray()).toEqual([0, 1, 0]);
    expect((updateFor(colour, b) as Vector3).toArray()).toEqual([0, 0, 1]);
    const rough = objectUniforms(lit.roughnessNode)[0]!;
    expect(updateFor(rough, a)).toBe(0.2);
    expect(updateFor(rough, b)).toBe(0.9);
    const metal = objectUniforms(lit.metalnessNode)[0]!;
    expect([updateFor(metal, a), updateFor(metal, b)]).toEqual([0, 1]);
    const emissive = objectUniforms(lit.emissiveNode)[0]!;
    expect((updateFor(emissive, b) as Vector3).toArray()).toEqual([2, 3, 4]);
    expect((updateFor(emissive, a) as Vector3).toArray()).toEqual([0, 0, 0]);
    // an object without paint draws with the defaults
    expect((updateFor(colour, new Object3D()) as Vector3).toArray()).toEqual([1, 1, 1]);
    expect(updateFor(rough, new Object3D())).toBe(1);
  });

  it('setSurfacePaint merges; surfacePaintOf gives the defaults for an unpainted object', () => {
    const o = new Object3D();
    expect(surfacePaintOf(o)).toEqual(defaultSurfacePaint());
    expect(surfacePaintOf(null)).toEqual(defaultSurfacePaint());
    setSurfacePaint(o, { roughness: 0.3 });
    setSurfacePaint(o, { metalness: 0.7, opacity: 0.5 });
    expect(surfacePaintOf(o)).toEqual({ ...defaultSurfacePaint(), roughness: 0.3, metalness: 0.7, opacity: 0.5 });
    // the defaults are not shared mutable state
    const d = defaultSurfacePaint();
    d.color[0] = 0;
    expect(defaultSurfacePaint().color).toEqual([1, 1, 1]);
  });

  it('a texture present or not is a variant; which texture is bound is a material of the same variant', () => {
    const c = cache();
    const t1 = tex();
    const t2 = tex();
    const plain = c.get({ variant: V.SRC_PRIM });
    const a = c.get({ variant: V.SRC_PRIM | V.TEX_ALBEDO, textures: { albedo: t1 } });
    expect(a).not.toBe(plain);
    expect(c.get({ variant: V.SRC_PRIM | V.TEX_ALBEDO, textures: { albedo: t1 } })).toBe(a);
    const b = c.get({ variant: V.SRC_PRIM | V.TEX_ALBEDO, textures: { albedo: t2 } });
    expect(b).not.toBe(a);
    expect(b.variantKey).toBe(a.variantKey);
    expect(() => c.get({ variant: V.SRC_PRIM | V.TEX_ORM })).toThrow(/no `orm` texture/);
    expect(() => c.get({ variant: V.SRC_PRIM | V.TEX_NORMAL, textures: { albedo: t1 } })).toThrow(/no `normal` texture/);
  });

  it('the texture inputs: albedo tint, ORM on roughness and metalness, a normal node, uv tiling', () => {
    const c = cache();
    const [albedo, normal, orm] = [tex(), tex(), tex()];
    const m = c.get({ variant: V.SRC_PRIM | V.TEX_ALBEDO | V.TEX_NORMAL | V.TEX_ORM | V.UV_TILE, textures: { albedo, normal, orm } }) as SurfaceMaterial;
    const textures = (root: Node | null): unknown[] => {
      const out: unknown[] = [];
      root?.traverse((n) => {
        const v = (n as { isTextureNode?: boolean; value?: unknown }).isTextureNode === true ? (n as { value?: unknown }).value : undefined;
        if (v !== undefined && !out.includes(v)) out.push(v);
      });
      return out;
    };
    expect(textures(m.colorNode)).toEqual([albedo]);
    expect(textures(m.roughnessNode)).toEqual([orm]);
    expect(textures(m.metalnessNode)).toEqual([orm]);
    expect(textures(m.normalNode)).toEqual([normal]);
    expect(c.get({ variant: V.SRC_PRIM }).normalNode).toBeNull();

    // the object's uvScale and its ORM switches are uniforms too
    const mesh = new Mesh(new PlaneGeometry(1, 1), m);
    setSurfacePaint(mesh, { uvScale: [2, 3], ormRoughness: true, ormMetalness: false });
    const vec2s = objectUniforms(m.roughnessNode)
      .map((u) => updateFor(u, mesh))
      .filter((v): v is Vector2 => v instanceof Vector2)
      .map((v) => v.toArray());
    expect(vec2s).toContainEqual([2, 3]);
    expect(vec2s).toContainEqual([1, 0]);
  });

  it('non-program state gives a separate material instance of the same variant', () => {
    const c = cache();
    const a = c.get({ variant: V.SRC_PRIM | V.TRANSPARENT });
    const noDepth = c.get({ variant: V.SRC_PRIM | V.TRANSPARENT, state: { depthWrite: false } });
    const offset = c.get({ variant: V.SRC_PRIM | V.TRANSPARENT, state: { depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 } });
    expect(new Set([a, noDepth, offset]).size).toBe(3);
    expect(c.get({ variant: V.SRC_PRIM | V.TRANSPARENT, state: { depthWrite: false } })).toBe(noDepth);
    expect([a.depthWrite, noDepth.depthWrite, offset.polygonOffset, offset.polygonOffsetFactor, offset.polygonOffsetUnits]).toEqual([true, false, true, -2, -2]);
    expect(noDepth.variantKey).toBe(a.variantKey);
  });

  it('UNLIT is a MeshBasicNodeMaterial with the same inputs', () => {
    const c = cache();
    const unlit = c.get({ variant: V.SRC_PRIM | V.UNLIT });
    expect(unlit).toBeInstanceOf(UnlitSurfaceMaterial);
    expect(unlit).toBeInstanceOf(MeshBasicNodeMaterial);
    expect(unlit.lights).toBe(false);
    expect(unlit.fog).toBe(true);
    // albedo + emissive: both per-object uniforms are in the colour
    const mesh = new Mesh(new PlaneGeometry(1, 1), unlit);
    setSurfacePaint(mesh, { color: [0.1, 0.2, 0.3], emissive: [1, 2, 3] });
    const values = objectUniforms(unlit.colorNode).map((u) => (updateFor(u, mesh) as Vector3).toArray());
    expect(values).toContainEqual([0.1, 0.2, 0.3]);
    expect(values).toContainEqual([1, 2, 3]);
    expect(() => new SurfaceMaterial({ variant: V.SRC_PRIM | V.UNLIT, script })).toThrow(/UNLIT variants are UnlitSurfaceMaterial/);
  });

  it('without a lighting script (the production fallback) every variant is built unlit', () => {
    const c = new SurfaceMaterials({ script: null });
    const m = c.get({ variant: V.SRC_PRIM });
    expect(m).toBeInstanceOf(UnlitSurfaceMaterial);
    expect(m.variant & V.UNLIT).toBe(V.UNLIT);
    expect(c.get({ variant: V.SRC_PRIM | V.UNLIT })).toBe(m);
  });

  it('dispose() disposes every material and empties the cache', () => {
    const c = cache();
    const a = c.get({ variant: V.SRC_PRIM });
    const b = c.get({ variant: V.SRC_PRIM | V.UNLIT });
    const disposed: unknown[] = [];
    a.addEventListener('dispose', () => disposed.push(a));
    b.addEventListener('dispose', () => disposed.push(b));
    c.dispose();
    expect(disposed).toEqual([a, b]);
    expect(c.size).toBe(0);
    expect(c.get({ variant: V.SRC_PRIM })).not.toBe(a);
  });
});

describe('input stages: the seam for the bits of later packages', () => {
  it('a bit with no registered stage throws and names the bit', () => {
    const c = cache();
    for (const [bit, name] of [
      [V.SRC_PACKED, 'SRC_PACKED'],
      [V.SRC_GLTF, 'SRC_GLTF'],
      [V.SRC_PRIM | V.TRIPLANAR, 'TRIPLANAR'],
      [V.SRC_PRIM | V.SLOTS, 'SLOTS'],
      [V.SRC_PRIM | V.PARTMASK, 'PARTMASK'],
      [V.SRC_PRIM | V.ALPHA_TEST, 'ALPHA_TEST'],
      [V.SRC_PRIM | V.VIEWMODEL, 'VIEWMODEL'],
      [V.SRC_PRIM | V.DECAL, 'DECAL'],
      [V.SRC_PRIM | V.SPLAT6, 'SPLAT6'],
      [V.SRC_PRIM | V.WATER, 'WATER'],
      [V.SRC_PRIM | V.TEX_SLOTS_2, 'TEX_SLOTS_n'],
    ] as const) {
      expect(() => c.get({ variant: bit }), name).toThrow(new RegExp(`no input stage is registered for ${name}\\b`));
    }
    expect(c.size).toBe(0);
  });

  it('a registered stage receives the inputs so far and its changes reach the material', () => {
    const c = cache();
    const clip = vec4(positionLocal, 1);
    const seen: Array<{ variant: number; keys: string[] }> = [];
    const viewmodel: SurfaceInputStage = (inputs, ctx) => {
      seen.push({ variant: ctx.variant, keys: Object.keys(inputs).sort() });
      return { ...inputs, vertex: clip, roughness: mix(inputs.roughness, inputs.roughness.mul(0.5), 0.5) };
    };
    c.registerStage(V.VIEWMODEL, viewmodel);
    const m = c.get({ variant: V.SRC_PRIM | V.VIEWMODEL }) as SurfaceMaterial;
    expect(seen).toEqual([{ variant: V.SRC_PRIM | V.VIEWMODEL, keys: ['color', 'emissive', 'metalness', 'normal', 'opacity', 'position', 'roughness', 'uv', 'vertex'] }]);
    expect(m.vertexNode).toBe(clip);
    expect(c.get({ variant: V.SRC_PRIM }).vertexNode).toBeNull();
    // registering twice, or a bit that is not a stage slot, is a programming error
    expect(() => c.registerStage(V.VIEWMODEL, viewmodel)).toThrow(/already registered/);
    expect(() => c.registerStage(V.TRANSPARENT, viewmodel)).toThrow(/not a stage slot/);
  });

  it('a row texture set on packed geometry replaces the paints: the stage is told, and the inputs are the object paint (render §7.4)', () => {
    expect([variantPaintSource(V.SRC_PRIM), variantPaintSource(V.SRC_PACKED), variantPaintSource(V.SRC_PACKED | V.NORMALS), variantPaintSource(V.SRC_GLTF), variantPaintSource(V.SRC_GLTF | V.TEX_ALBEDO)]).toEqual([
      'object',
      'source',
      'source',
      'source',
      'source',
    ]);
    expect(variantPaintSource(V.SRC_PACKED | V.TEX_ALBEDO | V.TEX_NORMAL | V.TEX_ORM)).toBe('object');
    // a flat row material on packed geometry (the kit's textureless presets): the row paints, with no texture to say so
    expect([variantPaintSource(V.SRC_PACKED | V.ROW_PAINT), variantPaintSource(V.SRC_PACKED | V.NORMALS | V.ROW_PAINT | V.TRANSPARENT)]).toEqual(['object', 'object']);

    const c = cache();
    const seen: Array<{ variant: number; paint: string }> = [];
    // what R3's packed stage does: the paint-table albedo, unless the row's texture set is the look
    const tableAlbedo = vec3(0.3, 0.2, 0.1);
    c.registerStage(V.SRC_PACKED, (inputs, ctx) => {
      seen.push({ variant: ctx.variant, paint: ctx.paint });
      return ctx.paint === 'source' ? { ...inputs, color: tableAlbedo } : inputs;
    });
    const painted = c.get({ variant: V.SRC_PACKED }) as SurfaceMaterial;
    const albedo = tex();
    const textured = c.get({ variant: V.SRC_PACKED | V.TEX_ALBEDO, textures: { albedo } }) as SurfaceMaterial;
    expect(seen).toEqual([
      { variant: V.SRC_PACKED, paint: 'source' },
      { variant: V.SRC_PACKED | V.TEX_ALBEDO, paint: 'object' },
    ]);
    expect(painted.colorNode).toBe(tableAlbedo);
    // the row's tint, roughness and metalness reach the textured variant per object
    const mesh = new Mesh(new PlaneGeometry(1, 1), textured);
    setSurfacePaint(mesh, { color: [0.2, 0.5, 0.6], roughness: 0.7, metalness: 1 });
    const tint = objectUniforms(textured.colorNode)
      .map((u) => updateFor(u, mesh))
      .filter((v): v is Vector3 => v instanceof Vector3)
      .map((v) => v.toArray());
    expect(tint).toEqual([[0.2, 0.5, 0.6]]);
    expect(updateFor(objectUniforms(textured.roughnessNode)[0]!, mesh)).toBe(0.7);
    expect(updateFor(objectUniforms(textured.metalnessNode)[0]!, mesh)).toBe(1);
    let reads = false;
    textured.colorNode!.traverse((n) => {
      if (n === tableAlbedo) reads = true;
    });
    expect(reads, 'the paint-table albedo is not in the textured colour').toBe(false);
  });

  it('the source stage runs first, then the texture inputs, then the others in table order', () => {
    const c = cache();
    const order: string[] = [];
    const tag =
      (name: string): SurfaceInputStage =>
      (inputs) => {
        order.push(name);
        return inputs;
      };
    c.registerStage(V.VIEWMODEL, tag('VIEWMODEL'));
    c.registerStage(V.SLOTS, tag('SLOTS'));
    c.registerStage(V.SRC_GLTF, tag('SRC_GLTF'));
    c.registerStage(V.PARTMASK, tag('PARTMASK'));
    c.registerStage(SURFACE_TEX_SLOTS_MASK, tag('TEX_SLOTS'));
    c.get({ variant: V.SRC_GLTF | V.VIEWMODEL | V.PARTMASK | V.SLOTS | V.TEX_SLOTS_1 });
    expect(order).toEqual(['SRC_GLTF', 'TEX_SLOTS', 'SLOTS', 'PARTMASK', 'VIEWMODEL']);
  });
});

describe('calibration reaches the materials', () => {
  it('the lit material uses a ScriptLightingModel of the injected script, a new one per build', () => {
    const env = vi.fn();
    const m = new SurfaceMaterials({ script, env: env as never }).get({ variant: V.SRC_PRIM }) as SurfaceMaterial;
    expect(m).toBeInstanceOf(MeshStandardNodeMaterial);
    const a = m.setupLightingModel() as unknown;
    const b = m.setupLightingModel() as unknown;
    expect(a).toBeInstanceOf(ScriptLightingModel);
    expect(b).toBeInstanceOf(ScriptLightingModel);
    expect(a).not.toBe(b);
  });

  it('[CAL roughnessAA] is fixed when a material is built and is part of its key: both modes can coexist', () => {
    const c = cache();
    expect(calibration.roughnessAA).toBe('three');
    const three = c.get({ variant: V.SRC_PRIM }) as SurfaceMaterial;
    calibration.roughnessAA = 'raw';
    const raw = c.get({ variant: V.SRC_PRIM }) as SurfaceMaterial;
    expect(raw).not.toBe(three);
    expect([three.roughnessAA, raw.roughnessAA]).toEqual(['three', 'raw']);
    expect(three.variantKey).not.toBe(raw.variantKey);
    calibration.roughnessAA = 'three';
    expect(c.get({ variant: V.SRC_PRIM })).toBe(three);
    // the key is an own string property, which is what three's material cache key reads
    expect(Object.keys(three)).toContain('variantKey');
    expect(typeof three.variantKey).toBe('string');
  });

  it('[CAL envScale] and the sky are fixed when a material is created, and are part of its key', () => {
    const sky = { sample: vi.fn(() => vec3(0.2, 0.3, 0.4)), mean: vec3(0.1, 0.1, 0.1) };
    installSkySampler(sky);
    const c = new SurfaceMaterials({ script: { lighting: (_s, l) => (l.ambient as Node<'vec3'>).add(l.environment as Node<'vec3'>) } });
    const get = (): SurfaceMaterial => c.get({ variant: V.SRC_PRIM }) as SurfaceMaterial;
    const off = get();
    calibration.envScale = 1;
    const on = get();
    calibration.envScale = 0.5;
    const half = get();
    expect(new Set([off, on, half]).size).toBe(3);
    // another sky is another material while the term is on
    const other = { sample: vi.fn(() => vec3(0.5, 0.5, 0.5)), mean: vec3(0.5, 0.5, 0.5) };
    installSkySampler(other);
    const halfOther = get();
    expect(halfOther).not.toBe(half);
    // three's own material cache key tells them apart as well
    expect(new Set([off, on, half, halfOther].map((m) => m.variantKey)).size).toBe(4);
    resetCalibration();
    installSkySampler(null);

    // three builds a material's lighting model when it first compiles it: by then the calibration may have moved on
    const start = (m: SurfaceMaterial): void => {
      const st = stack();
      setCurrentStack(st);
      try {
        const context = {
          reflectedLight: { directDiffuse: vec3().toVar(), directSpecular: vec3().toVar(), indirectDiffuse: vec3().toVar(), indirectSpecular: vec3().toVar() },
          irradiance: vec3().toVar(),
          ambientOcclusion: float(1).toVar(),
        };
        const builder = { context, lightsNode: { getLightNodes: () => [], setupLights: () => undefined } } as unknown as NodeBuilder;
        (m.setupLightingModel() as unknown as ScriptLightingModel).start(builder);
      } finally {
        setCurrentStack(null);
      }
    };
    start(off);
    expect(sky.sample).not.toHaveBeenCalled();
    start(on);
    expect(sky.sample).toHaveBeenCalledTimes(1);
    start(half);
    expect(sky.sample).toHaveBeenCalledTimes(2);
    expect(other.sample).not.toHaveBeenCalled();
    start(halfOther);
    expect(other.sample).toHaveBeenCalledTimes(1);
  });

  it("[CAL wetModifier] 'off' builds no wet nodes; 'surface' reads the wet uniform in roughness and colour", () => {
    const readsWet = (root: Node | null): boolean => {
      let hit = false;
      root?.traverse((n) => {
        if (n === surfaceWet) hit = true;
      });
      return hit;
    };
    const c = cache();
    expect(calibration.wetModifier).toBe('off');
    const dry = c.get({ variant: V.SRC_PRIM }) as SurfaceMaterial;
    expect(readsWet(dry.colorNode) || readsWet(dry.roughnessNode)).toBe(false);
    calibration.wetModifier = 'surface';
    const wet = c.get({ variant: V.SRC_PRIM }) as SurfaceMaterial;
    expect(wet).not.toBe(dry);
    expect(readsWet(wet.colorNode)).toBe(true);
    expect(readsWet(wet.roughnessNode)).toBe(true);
    // metalness and emissive are untouched
    expect(readsWet(wet.metalnessNode) || readsWet(wet.emissiveNode)).toBe(false);
    expect(surfaceWet.value).toBe(0);
  });
});
