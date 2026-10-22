// The primitive-bucket part of the warm-up (src/render/models/shader-variants.ts `bucketProgramVariants`,
// `bucketProxyFactory`): a bucket is made by the first row of its look, which a script can spawn at any time (the
// team-glow haze cones at PREP), so every bucket program is enumerated, and a proxy is built the way a bucket is built.
import { DataTexture, InstancedMesh, Object3D } from 'three/webgpu';
import type { BufferAttribute, Material, Mesh, Node } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { createViewmodelContent } from '../../../../src/render/bridge/attach.ts';
import { BUCKET_BITS, PrimitiveBuckets, primitiveLook } from '../../../../src/render/geometry/primitives.ts';
import { bucketProgramVariants, bucketProxyFactory, enumerateVariants, modelVariantBits, programVariant, viewmodelPrimitiveVariants, type WarmUpEnv } from '../../../../src/render/models/shader-variants.ts';
import { createViewmodelProjection, registerViewmodelStage } from '../../../../src/render/models/viewmodel-renderer.ts';
import { flatNormal, whitePixel } from '../../../../src/render/surface/look-table.ts';
import type { StandardMaterialSpec } from '../../../../src/render/surface/material-spec.ts';
import type { LightingScript } from '../../../../src/render/surface/script-types.ts';
import { SurfaceVariant as V, type SurfaceSlotTextures } from '../../../../src/render/surface/surface-material.ts';
import { testEnv } from './model-fixtures.ts';

const SCRIPT = { lighting: (_s: unknown, l: { ambient: unknown }) => l.ambient } as unknown as LightingScript;
const ENV = {} as WarmUpEnv;

/** materials the carried scripts give primitive rows (team-glow, gun blood, gore, ordnance, a plain prop) */
const LOOKS: Record<string, StandardMaterialSpec> = {
  haze: { texture: 'scripts/tex-beam.js', color: 'oklch(0.97 0.03 85)', opacity: 0.07, transparent: true, depthWrite: false, side: 'double', roughness: 1, metalness: 0 },
  blood: { texture: 'gore/b1.png', color: '#600', transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: 'double' },
  hazard: { color: 'oklch(0.5 0.2 40)', opacity: 0.6 },
  glow: { color: '#ff0', transparent: true, unlit: true },
  prop: { color: '#808080', roughness: 0.8, metalness: 0 },
  inside: { color: '#202020', side: 'back' },
  tiled: { texture: 'tiles.png', repeat: [4, 2] },
};

const layout = (mesh: InstancedMesh): string[] =>
  Object.entries(mesh.geometry.attributes)
    .map(([name, a]) => `${name}:${(a as BufferAttribute).itemSize}${(a as BufferAttribute).normalized ? 'n' : ''}${(a as { isInstancedBufferAttribute?: boolean }).isInstancedBufferAttribute === true ? 'i' : ''}`)
    .sort();
const shape = (m: Material): unknown => ({ type: m.constructor.name, name: m.name, transparent: m.transparent, side: m.side, single: m.forceSinglePass, depthWrite: m.depthWrite });

describe('primitive bucket programs in the warm-up', () => {
  const variants = bucketProgramVariants();

  it('enumerates every combination of the bits a bucket builds, once each, as instanced variants that never receive or cast', () => {
    expect(variants).toHaveLength(36);
    expect(new Set(variants.map((v) => v.key)).size).toBe(36);
    for (const v of variants) {
      expect(v.kind).toBe('instanced');
      expect(v.receiveShadow).toBe(false);
      expect(v.depth).toBe(false);
      expect(v.stage).toBe('engine');
      expect(v.variant & ~BUCKET_BITS).toBe(0);
      expect(v.variant & V.SRC_PRIM).toBe(V.SRC_PRIM);
    }
    // they go through the enumeration as the engine set's `extra`
    const all = enumerateVariants({ families: [], viewmodelDecal: null, shadows: true, multiDraw: true, extra: variants });
    expect(all.map((v) => v.key).sort()).toEqual(variants.map((v) => v.key).sort());
  });

  it('covers the look of every bucket a row material can make (uv repeat without an albedo texture draws as no repeat)', () => {
    const bits = new Set(variants.map((v) => v.variant));
    for (const [name, spec] of Object.entries(LOOKS)) {
      let b = primitiveLook(spec).variant;
      if ((b & V.TEX_ALBEDO) === 0) b &= ~V.UV_TILE;
      expect(bits.has(b), `${name}: bucket bits ${b.toString(2)} are not enumerated`).toBe(true);
    }
    // every reachable combination: SRC_PRIM, any of the others, at most one side
    const optional = [V.TEX_ALBEDO, V.UV_TILE, V.TRANSPARENT, V.UNLIT, V.SIDE_BACK, V.SIDE_DOUBLE];
    for (let m = 0; m < 1 << optional.length; m++) {
      let b = V.SRC_PRIM;
      optional.forEach((bit, i) => {
        if ((m & (1 << i)) !== 0) b |= bit;
      });
      if ((b & V.SIDE_BACK) !== 0 && (b & V.SIDE_DOUBLE) !== 0) continue;
      if ((b & V.TEX_ALBEDO) === 0) b &= ~V.UV_TILE;
      expect(bits.has(b), `combination ${b.toString(2)}`).toBe(true);
    }
  });

  it('builds a proxy the way a bucket is built: the same material class and state, and the same attribute set', () => {
    const factory = bucketProxyFactory(SCRIPT);
    const buckets = new PrimitiveBuckets({ script: SCRIPT, parent: new Object3D() });
    for (const [name, spec] of Object.entries(LOOKS)) {
      const { bucket, look } = buckets.bucketFor({ kind: 'cylinder', radiusTop: 0.45, radiusBottom: 0.04, height: 7, openEnded: true }, spec);
      const v = variants.find((x) => x.variant === ((look.variant & V.TEX_ALBEDO) === 0 ? look.variant & ~V.UV_TILE : look.variant))!;
      const proxy = factory(v, ENV) as InstancedMesh;
      expect(proxy, name).toBeInstanceOf(InstancedMesh);
      expect(layout(proxy), `${name}: attribute set`).toEqual(layout(bucket.mesh));
      expect({ ...(shape(proxy.material as Material) as object), depthWrite: undefined }, `${name}: material`).toEqual({ ...(shape(bucket.material) as object), depthWrite: undefined });
    }
  });

  it('enumerates every program of a camera-attached primitive: the variant each row look gets from createViewmodelContent', () => {
    const vm = viewmodelPrimitiveVariants();
    expect(new Set(vm.map((v) => v.key)).size).toBe(vm.length);
    expect(vm.every((v) => v.kind === 'mesh' && v.layer === 1 && !v.receiveShadow && (v.variant & V.VIEWMODEL) !== 0)).toBe(true);
    const env = testEnv();
    registerViewmodelStage(env.materials, createViewmodelProjection());
    const content = createViewmodelContent({ materials: env.materials });
    const bits = new Set(vm.map((v) => v.variant));
    const looks = [...Object.values(LOOKS), { color: '#fff', unlit: true, side: 'back' } as StandardMaterialSpec, { texture: 't.png', unlit: true, transparent: true } as StandardMaterialSpec];
    for (const material of looks) {
      const mesh = content.create({ id: 'vm', props: { primitive: { kind: 'plane', width: 0.1, height: 0.1 }, material } } as never) as Mesh;
      const variant = (mesh.material as unknown as { variant: number }).variant;
      expect(bits.has(variant), `${JSON.stringify(material)}: ${variant.toString(2)}`).toBe(true);
    }
  });

  it('gives every slot texture a sampler of its own: a binding that shares texture objects declares what one with its own maps does', () => {
    const env = testEnv();
    const pixel = (): DataTexture => new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    /** the samplers three would declare: one per distinct uniform hash among the material's texture nodes */
    const samplers = (slots: SurfaceSlotTextures[]): number => {
      const m = env.materials.get({ variant: modelVariantBits(slots.length), textures: { slots } }) as unknown as Record<string, Node | null | undefined>;
      const seen = new Set<unknown>();
      const hashes = new Set<string>();
      for (const key of ['colorNode', 'roughnessNode', 'metalnessNode', 'normalNode', 'positionNode', 'opacityNode']) {
        (m[key] as { traverse?: (fn: (n: unknown) => void) => void } | null | undefined)?.traverse?.((n) => {
          if (seen.has(n)) return;
          seen.add(n);
          const t = n as { isTextureNode?: boolean; getUniformHash?: () => string };
          if (t.isTextureNode === true) hashes.add(t.getUniformHash!());
        });
      }
      return hashes.size;
    };
    // two sets without normal or ORM maps (both read the shared stand-ins) against two sets with maps of their own
    const sharing = samplers([{ albedo: pixel() }, { albedo: pixel() }]);
    const own = samplers([{ albedo: pixel(), normal: pixel(), orm: pixel() }, { albedo: pixel(), normal: pixel(), orm: pixel() }]);
    // and the warm-up's stand-in set, whose albedo and ORM are one texture object
    const standIn = samplers([{ albedo: whitePixel(), normal: flatNormal(), orm: whitePixel() }, { albedo: whitePixel(), normal: flatNormal(), orm: whitePixel() }]);
    expect(own).toBeGreaterThanOrEqual(6);
    expect(sharing).toBe(own);
    expect(standIn).toBe(own);
  });

  it('keeps one material per bits for the session (a disposed proxy material would free its programs), and builds nothing else', () => {
    const factory = bucketProxyFactory(SCRIPT);
    const v = variants.find((x) => x.variant === (V.SRC_PRIM | V.TEX_ALBEDO | V.TRANSPARENT | V.SIDE_DOUBLE))!;
    const a = factory(v, ENV) as InstancedMesh;
    const b = factory(v, ENV) as InstancedMesh;
    expect(a.material).toBe(b.material);
    expect(a.geometry).not.toBe(b.geometry);
    expect(a.count).toBe(1);
    // not a bucket: a model surface, a viewmodel primitive (a plain mesh of R8), a map row with bits a bucket drops
    expect(factory(programVariant({ variant: V.SRC_GLTF | V.SIDE_DOUBLE, kind: 'instanced', owner: 'R7', why: 'gibs' }), ENV)).toBeNull();
    expect(factory(programVariant({ variant: V.SRC_PRIM | V.TEX_ALBEDO | V.VIEWMODEL, kind: 'mesh', owner: 'R8', why: 'gun blood' }), ENV)).toBeNull();
    expect(factory(programVariant({ variant: V.SRC_PRIM | V.TEX_NORMAL, kind: 'instanced', owner: 'R3', why: 'map row' }), ENV)).toBeNull();
  });
});
