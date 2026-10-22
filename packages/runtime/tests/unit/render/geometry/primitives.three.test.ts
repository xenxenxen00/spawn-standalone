// primitives.ts (render §6.7; contract §9.2, §9.4; X-47; WP R3): unit geometries and their keys, the origin rule, material
// buckets, instanced paint attributes fed from typed arrays, explicit bucket bounds, and the haze-cone variant (an open-ended
// two-radius cylinder: transparent, double-sided, no depth write, an alpha texture). Node + three, no renderer.
import { DataTexture, DoubleSide, Frustum, FrontSide, Group, InstancedBufferAttribute, Matrix4, PerspectiveCamera, Vector3 } from 'three/webgpu';
import type { BufferGeometry, Node, Texture } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  PRIMITIVE_ALBEDO, PRIMITIVE_EMISSIVE, PRIMITIVE_EXTRA, PRIMITIVE_KINDS, PrimitiveBuckets, isColorOnlyMaterial, primitiveLook, primitiveShape, whiteTexture,
  type PrimitiveSpec,
} from '../../../../src/render/geometry/primitives.ts';
import { cssToLinear } from '../../../../src/render/color/color.ts';
import type { StandardMaterialSpec } from '../../../../src/render/surface/material-spec.ts';
import type { LightingScript } from '../../../../src/render/surface/script-types.ts';
import { SurfaceMaterial, SurfaceVariant as V, UnlitSurfaceMaterial } from '../../../../src/render/surface/surface-material.ts';

const script: LightingScript = { lighting: (_s, l) => l.ambient };
const at = (x: number, y: number, z: number): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

/** the two live haze cones of a teammate torch (sync §5.2) */
const haze = (r: number): PrimitiveSpec => ({ kind: 'cylinder', radiusTop: r, radiusBottom: 0.04, height: 7, openEnded: true, radialSegments: 24 });
const hazeMaterial = (opacity: number): StandardMaterialSpec => ({
  texture: 'scripts/tex-beam.js', color: 'oklch(0.97 0.03 85)', opacity, transparent: true, depthWrite: false, side: 'double', roughness: 1, metalness: 0,
});

function extent(g: BufferGeometry): { min: number[]; max: number[] } {
  g.computeBoundingBox();
  return { min: g.boundingBox!.min.toArray(), max: g.boundingBox!.max.toArray() };
}
const close = (a: number[], b: number[]): void => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));

describe('primitiveShape', () => {
  it('stands every solid kind on its bottom centre and scales a unit geometry to the row size', () => {
    const box = primitiveShape({ kind: 'box', width: 2, height: 3, depth: 4 });
    expect([box.geometryKey, box.scale]).toEqual(['box', [2, 3, 4]]);
    close(extent(box.create()).min, [-0.5, 0, -0.5]);
    close(extent(box.create()).max, [0.5, 1, 0.5]);
    expect(primitiveShape({ kind: 'box', size: 0.3 }).scale).toEqual([0.3, 0.3, 0.3]);
    const sphere = primitiveShape({ kind: 'sphere', radius: 0.25 });
    expect([sphere.geometryKey, sphere.scale]).toEqual(['sphere:32:16', [0.25, 0.25, 0.25]]);
    close(extent(sphere.create()).min, [-1, 0, -1]);
    const cone = primitiveShape({ kind: 'cone', radius: 2, height: 5 });
    expect([cone.geometryKey, cone.scale]).toEqual(['cone:32', [2, 5, 2]]);
    close([extent(cone.create()).min[1]!, extent(cone.create()).max[1]!], [0, 1]);
    // a capsule's shape is its half height over its radius: part of the key; the instance scale is the radius
    const capsule = primitiveShape({ kind: 'capsule', radius: 0.4, halfHeight: 0.6 });
    expect([capsule.geometryKey, capsule.scale]).toEqual(['capsule:1.5:16', [0.4, 0.4, 0.4]]);
    const c = extent(capsule.create());
    close([c.min[1]!, c.max[1]!], [0, 2 * 1.5 + 2]);
    expect(PRIMITIVE_KINDS).toContain('torus');
  });

  it('keeps flat kinds on their centre with anchor "center" and on their lowest point without', () => {
    const centred = primitiveShape({ kind: 'plane', width: 2, height: 4, anchor: 'center' });
    expect([centred.geometryKey, centred.scale]).toEqual(['plane', [2, 4, 1]]);
    close(extent(centred.create()).min, [-0.5, -0.5, 0]);
    const low = primitiveShape({ kind: 'plane', width: 2, height: 4 });
    expect(low.geometryKey).toBe('plane:low');
    close(extent(low.create()).min, [-0.5, 0, 0]);
    const torus = primitiveShape({ kind: 'torus', radius: 2, tube: 0.5, radialSegments: 8, tubularSegments: 24, anchor: 'center' });
    expect([torus.geometryKey, torus.scale]).toEqual([`torus:0.25:8:24:${Math.round(Math.PI * 2 * 1e4) / 1e4}`, [2, 2, 2]]);
    expect(primitiveShape({ kind: 'circle', radius: 3, anchor: 'center' }).scale).toEqual([3, 3, 1]);
    expect(primitiveShape({ kind: 'ring', innerRadius: 1, outerRadius: 4, anchor: 'center' }).geometryKey).toBe('ring:0.25:32');
  });

  it('keys a cylinder by the ratio of its radii, its segments and openEnded', () => {
    const plain = primitiveShape({ kind: 'cylinder', radius: 0.32, height: 5 });
    expect([plain.geometryKey, plain.scale]).toEqual(['cylinder:1:1:32', [0.32, 5, 0.32]]);
    // the same proportions at another size share the unit geometry
    expect(primitiveShape({ kind: 'cylinder', radiusTop: 2, radiusBottom: 2, height: 1 }).geometryKey).toBe('cylinder:1:1:32');
    const narrow = primitiveShape(haze(0.45));
    const wide = primitiveShape(haze(1.0));
    expect(narrow.geometryKey).toBe('cylinder:1:0.0889:24:open');
    expect(wide.geometryKey).toBe('cylinder:1:0.04:24:open');
    expect(narrow.scale).toEqual([0.45, 7, 0.45]);
    expect(wide.scale).toEqual([1, 7, 1]);
    // a bottom-heavy cylinder scales by its bottom radius
    expect(primitiveShape({ kind: 'cylinder', radiusTop: 0.5, radiusBottom: 2, height: 3 })).toMatchObject({ geometryKey: 'cylinder:0.25:1:32', scale: [2, 3, 2] });
    expect(primitiveShape({ kind: 'cylinder', radiusTop: 0.45, radiusBottom: 0.04, height: 7, radialSegments: 24 }).geometryKey).toBe('cylinder:1:0.0889:24');
  });

  it('builds the open-ended cylinder without cap triangles, with v running along the axis from the bottom', () => {
    const open = primitiveShape(haze(0.45)).create();
    const closed = primitiveShape({ ...haze(0.45), openEnded: false }).create();
    // the wall: 24 segments × 2 triangles; each cap adds 24 triangles
    expect(open.index!.count).toBe(24 * 2 * 3);
    expect(closed.index!.count).toBe(24 * 2 * 3 + 2 * 24 * 3);
    const pos = open.getAttribute('position');
    const uv = open.getAttribute('uv');
    // every vertex is on the wall: at the bottom ring (radius 0.0889) or the top ring (radius 1), none at a cap centre
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const r = Math.hypot(pos.getX(i), pos.getZ(i));
      expect(Math.min(Math.abs(y), Math.abs(y - 1))).toBeLessThan(1e-6);
      expect(r).toBeCloseTo(y < 0.5 ? 0.0889 : 1, 5);
      // RH1's beam texture: t = 0 at the lamp end = the cylinder's origin end
      expect(uv.getY(i)).toBeCloseTo(y, 6);
    }
    // every triangle of the wall has corners on both rings: no cap disc
    for (let t = 0; t < open.index!.count; t += 3) {
      const ys = [0, 1, 2].map((k) => pos.getY(open.index!.getX(t + k)));
      expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(1, 6);
    }
  });

  it('refuses a kind that is not a built-in primitive', () => {
    expect(() => primitiveShape({ kind: 'arch', width: 2, height: 3, depth: 1 })).toThrow(/not a built-in primitive/);
    expect(() => primitiveShape({ kind: 'scripted' })).toThrow(RangeError);
  });
});

describe('primitiveLook', () => {
  it('puts structure and state in the bucket key and colour, opacity and PBR values in the instance', () => {
    const red = primitiveLook({ color: 'oklch(0.6 0.2 25)', roughness: 0.4 });
    const blue = primitiveLook({ color: 'oklch(0.5 0.2 260)', roughness: 0.9, metalness: 0.3, emissive: 'oklch(0.9 0.1 90)', emissiveIntensity: 2 });
    expect(red.key).toBe(blue.key);
    expect(red.variant).toBe(V.SRC_PRIM);
    expect(blue.params.paint.metalness).toBe(0.3);
    const lin = cssToLinear('oklch(0.9 0.1 90)')!;
    expect(blue.params.paint.emissive[0]).toBeCloseTo(lin[0] * 2, 6);
    // each of these is its own variant and so its own bucket (render §6.7)
    const keys = [
      red.key,
      primitiveLook({ color: 'oklch(0.6 0.2 25)', texture: 'cdn/texture-x.png' }).key,
      primitiveLook({ color: 'oklch(0.6 0.2 25)', depthWrite: false }).key,
      primitiveLook({ color: 'oklch(0.6 0.2 25)', polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }).key,
      primitiveLook({ color: 'oklch(0.6 0.2 25)', side: 'double' }).key,
      primitiveLook({ color: 'oklch(0.6 0.2 25)', transparent: true, opacity: 0.5 }).key,
      primitiveLook({ color: 'oklch(0.6 0.2 25)', unlit: true }).key,
      primitiveLook({ color: 'oklch(0.6 0.2 25)', renderOrder: 3 }).key,
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('reads the haze-cone material: transparent, double-sided, textured, no depth write, opacity per instance', () => {
    const a = primitiveLook(hazeMaterial(0.07));
    const b = primitiveLook(hazeMaterial(0.035));
    expect(a.key).toBe(b.key);
    expect(a.variant).toBe(V.SRC_PRIM | V.TEX_ALBEDO | V.TRANSPARENT | V.SIDE_DOUBLE);
    expect(a.params.state.depthWrite).toBe(false);
    expect(a.params.textures.albedo).toBe('scripts/tex-beam.js');
    expect([a.params.paint.opacity, b.params.paint.opacity]).toEqual([0.07, 0.035]);
    expect(a.params.paint.roughness).toBe(1);
  });

  it('knows the colour-only material the live engine did not draw', () => {
    expect(isColorOnlyMaterial({ color: '#ff0000' })).toBe(true);
    expect(isColorOnlyMaterial({ color: '#ff0000', roughness: 0.5 })).toBe(false);
    expect(isColorOnlyMaterial({ color: '#ff0000', transparent: true })).toBe(false);
    expect(isColorOnlyMaterial(null)).toBe(false);
  });
});

describe('PrimitiveBuckets', () => {
  const world = (opts: Partial<ConstructorParameters<typeof PrimitiveBuckets>[0]> = {}): { buckets: PrimitiveBuckets; parent: Group; logs: string[] } => {
    const parent = new Group();
    const logs: string[] = [];
    return { buckets: new PrimitiveBuckets({ script, parent, capacity: 4, log: (m) => logs.push(m), ...opts }), parent, logs };
  };
  const mat: StandardMaterialSpec = { color: 'oklch(0.6 0.2 25)', roughness: 0.4, metalness: 0.2 };

  it('draws every primitive of one kind and variant as one instanced mesh fed from typed arrays', () => {
    const { buckets, parent } = world();
    const a = buckets.add({ kind: 'box', width: 2, height: 1, depth: 1 }, mat, at(10, 0, 0));
    const b = buckets.add({ kind: 'box', size: 0.5 }, { ...mat, color: 'oklch(0.5 0.2 260)', roughness: 0.9 }, at(-4, 2, 3));
    const c = buckets.add({ kind: 'sphere', radius: 0.5 }, mat, at(0, 0, 0));
    expect(a.bucket).toBe(b.bucket);
    expect(c.bucket).not.toBe(a.bucket);
    expect(buckets.buckets()).toHaveLength(2);
    expect(buckets.draws).toBe(2);
    expect(parent.children).toHaveLength(2);
    buckets.flush();
    const mesh = a.bucket.mesh;
    expect(mesh.isInstancedMesh).toBe(true);
    expect(mesh.count).toBe(2);
    expect(mesh.visible).toBe(true);
    // no Object3D per primitive: the bucket mesh has no children
    expect(mesh.children).toHaveLength(0);
    // instance matrix = world · scale(shape): the unit box's top-right corner lands where the row's box has it
    const m0 = new Matrix4().fromArray(mesh.instanceMatrix.array, 0);
    expect(new Vector3(0.5, 1, 0.5).applyMatrix4(m0).toArray()).toEqual([11, 1, 0.5]);
    const m1 = new Matrix4().fromArray(mesh.instanceMatrix.array, 16);
    expect(new Vector3(0.5, 1, 0.5).applyMatrix4(m1).toArray()).toEqual([-3.75, 2.5, 3.25]);
    // the paint of each instance is in the instanced attributes
    const g = mesh.geometry;
    const albedo = g.getAttribute(PRIMITIVE_ALBEDO) as InstancedBufferAttribute;
    const emissive = g.getAttribute(PRIMITIVE_EMISSIVE) as InstancedBufferAttribute;
    const extra = g.getAttribute(PRIMITIVE_EXTRA) as InstancedBufferAttribute;
    expect(albedo.isInstancedBufferAttribute).toBe(true);
    const red = cssToLinear('oklch(0.6 0.2 25)')!;
    const blue = cssToLinear('oklch(0.5 0.2 260)')!;
    expect(Array.from(albedo.array.subarray(0, 8))).toEqual([...red, 1, ...blue, 1].map(Math.fround));
    expect(emissive.array[3]).toBeCloseTo(0.4, 6);
    expect(emissive.array[7]).toBeCloseTo(0.9, 6);
    expect(extra.array[0]).toBeCloseTo(0.2, 6);
    // only the written range is uploaded
    expect(mesh.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 32 }]);
    expect(albedo.updateRanges).toEqual([{ start: 0, count: 8 }]);
    // the lit material reads those attributes
    expect(a.bucket.material).toBeInstanceOf(SurfaceMaterial);
    const names: string[] = [];
    for (const n of [a.bucket.material.colorNode, (a.bucket.material as SurfaceMaterial).roughnessNode, (a.bucket.material as SurfaceMaterial).metalnessNode, (a.bucket.material as SurfaceMaterial).emissiveNode]) {
      (n as Node).traverse((x) => {
        const name = (x as unknown as { _attributeName?: string })._attributeName;
        if (name && !names.includes(name)) names.push(name);
      });
    }
    expect(names.sort()).toEqual([PRIMITIVE_ALBEDO, PRIMITIVE_EMISSIVE, PRIMITIVE_EXTRA]);
  });

  it('frees a slot by moving the last instance into it, and writes moves and paints in place', () => {
    const { buckets } = world();
    const h = [0, 1, 2].map((i) => buckets.add({ kind: 'box', size: 1 }, mat, at(i * 10, 0, 0)));
    buckets.flush();
    buckets.remove(h[0]!);
    buckets.flush();
    const bucket = h[1]!.bucket;
    expect(bucket.count).toBe(2);
    expect(bucket.mesh.count).toBe(2);
    // slot 0 now holds instance 2 (x = 20), slot 1 instance 1 (x = 10)
    expect([bucket.matrices[12], bucket.matrices[16 + 12]]).toEqual([20, 10]);
    buckets.setMatrix(h[2]!, { kind: 'box', size: 1 }, at(-7, 0, 0));
    buckets.setMaterial(h[1]!, { ...mat, roughness: 0.05 });
    buckets.flush();
    expect(bucket.matrices[12]).toBe(-7);
    expect(bucket.emissive[4 + 3]).toBeCloseTo(0.05, 6);
    expect(bucket.mesh.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 32 }]);
    expect(() => buckets.setMaterial(h[1]!, { ...mat, transparent: true })).toThrow(/another bucket/);
    buckets.remove(h[1]!);
    buckets.remove(h[2]!);
    buckets.flush();
    expect(bucket.mesh.visible).toBe(false);
    expect(buckets.draws).toBe(0);
    expect(() => buckets.remove(h[2]!)).toThrow(/no instance/);
  });

  it('doubles a full bucket and keeps what it held', () => {
    const { buckets, parent } = world();
    const handles = Array.from({ length: 9 }, (_, i) => buckets.add({ kind: 'box', size: 1 }, mat, at(i, 0, 0)));
    const bucket = handles[0]!.bucket;
    expect(bucket.capacity).toBe(16);
    expect(bucket.count).toBe(9);
    expect(parent.children).toEqual([bucket.mesh]);
    expect(bucket.mesh.instanceMatrix.count).toBe(16);
    expect(Array.from({ length: 9 }, (_, i) => bucket.matrices[i * 16 + 12])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    buckets.flush();
    expect(bucket.mesh.count).toBe(9);
    // the bulk path: the bridge writes the arrays itself
    bucket.grow(40);
    expect(bucket.capacity).toBe(64);
    bucket.matrices.set(new Matrix4().makeTranslation(100, 0, 0).elements, 39 * 16);
    bucket.setCount(40);
    buckets.flush();
    expect(bucket.mesh.count).toBe(40);
    expect(bucket.mesh.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 640 }]);
    expect(() => bucket.setCount(65)).toThrow(RangeError);
  });

  it('assigns the bucket its own bounding sphere over the live instances, so three never keeps a stale one', () => {
    const { buckets } = world();
    const a = buckets.add({ kind: 'box', size: 2 }, mat, at(0, 0, 0));
    buckets.flush();
    const mesh = a.bucket.mesh;
    const first = mesh.boundingSphere!.clone();
    expect(first.center.y).toBeCloseTo(1, 6);
    expect(first.radius).toBeCloseTo(Math.sqrt(3), 5);
    // an instance far away, added later: the sphere grows on the flush after the count change
    buckets.add({ kind: 'box', size: 2 }, mat, at(500, 0, 0));
    buckets.flush();
    expect(mesh.boundingSphere!.center.x).toBeCloseTo(250, 3);
    expect(mesh.boundingSphere!.radius).toBeGreaterThan(250);
    const camera = new PerspectiveCamera(58.72, 16 / 9, 0.1, 2000);
    camera.position.set(500, 1, 30);
    camera.lookAt(500, 1, 0);
    camera.updateMatrixWorld(true);
    const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    expect(frustum.intersectsObject(mesh)).toBe(true);
    // a moved instance is picked up within four flushes without a count change
    buckets.setMatrix(a, { kind: 'box', size: 2 }, at(0, 0, 900));
    for (let i = 0; i < 4; i++) buckets.flush();
    expect(mesh.boundingSphere!.center.z).toBeCloseTo(450, 3);
    // a bucket that spans the map is not culled at all
    a.bucket.spansMap = true;
    buckets.flush();
    expect(mesh.frustumCulled).toBe(false);
  });

  it('gives the haze cones their own variant and buckets: one per radius ratio, white until the texture arrives', () => {
    const seen: string[] = [];
    const { buckets } = world({
      resolveTexture: (name) => {
        seen.push(name);
        return undefined;
      },
    });
    const narrow = buckets.add(haze(0.45), hazeMaterial(0.07), at(0, 1.5, 0));
    const wide = buckets.add(haze(1.0), hazeMaterial(0.035), at(0, 1.5, 0));
    const again = buckets.add(haze(0.45), hazeMaterial(0.07), at(5, 1.5, 0));
    expect(narrow.bucket).not.toBe(wide.bucket);
    expect(again.bucket).toBe(narrow.bucket);
    expect(seen).toEqual(['scripts/tex-beam.js', 'scripts/tex-beam.js']);
    for (const b of [narrow.bucket, wide.bucket]) {
      const m = b.material;
      expect(m).toBeInstanceOf(SurfaceMaterial);
      expect([m.transparent, m.depthWrite, m.side, m.forceSinglePass]).toEqual([true, false, DoubleSide, true]);
      expect(m.opacityNode).not.toBeNull();
      expect(b.texture).toBe(whiteTexture());
      expect(b.textureName).toBe('scripts/tex-beam.js');
    }
    // the opacity is the instance's, times the texture's alpha
    expect(narrow.bucket.albedo[3]).toBeCloseTo(0.07, 6);
    expect(wide.bucket.albedo[3]).toBeCloseTo(0.035, 6);
    const opacityNames: string[] = [];
    let opacityTextures = 0;
    (narrow.bucket.material.opacityNode as Node).traverse((x) => {
      const name = (x as unknown as { _attributeName?: string })._attributeName;
      if (name) opacityNames.push(name);
      if ((x as unknown as { isTextureNode?: boolean }).isTextureNode === true) opacityTextures++;
    });
    expect(opacityNames).toContain(PRIMITIVE_ALBEDO);
    expect(opacityTextures).toBeGreaterThan(0);
    // RH1 lands (or the file loads): both buckets switch, no new material
    const beam: Texture = new DataTexture(new Uint8Array(8 * 128 * 4), 8, 128);
    const materials = [narrow.bucket.material, wide.bucket.material];
    buckets.setTexture('scripts/tex-beam.js', beam);
    expect([narrow.bucket.texture, wide.bucket.texture]).toEqual([beam, beam]);
    expect([narrow.bucket.material, wide.bucket.material]).toEqual(materials);
    // ten cones with five bots (sync §5.4) are two draws
    for (let i = 0; i < 4; i++) {
      buckets.add(haze(0.45), hazeMaterial(0.07), at(i, 1.5, 9));
      buckets.add(haze(1.0), hazeMaterial(0.035), at(i, 1.5, 9));
    }
    expect(buckets.draws).toBe(2);
    // an opaque single-sided primitive needs neither flag
    const plain = buckets.add({ kind: 'cylinder', radius: 0.3, height: 2 }, mat, at(0, 0, 0)).bucket.material;
    expect([plain.transparent, plain.depthWrite, plain.side, plain.forceSinglePass]).toEqual([false, true, FrontSide, false]);
  });

  it('builds unlit buckets without a lighting script, and logs the colour-only material once', () => {
    const { buckets, logs } = world({ script: null });
    const a = buckets.add({ kind: 'box', size: 1 }, { color: '#ff0000' }, at(0, 0, 0));
    buckets.add({ kind: 'box', size: 1 }, { color: '#00ff00' }, at(1, 0, 0));
    expect(a.bucket.material).toBeInstanceOf(UnlitSurfaceMaterial);
    expect(logs.filter((l) => l.includes('only `color`'))).toHaveLength(1);
    // a normal map is not a bucket input: reported once, drawn without
    buckets.add({ kind: 'box', size: 1 }, { color: '#ff0000', roughness: 1, texture: 'a.png', normalMap: 'n.png' }, at(0, 0, 0));
    expect(logs.some((l) => l.includes('TEX_NORMAL'))).toBe(true);
    buckets.dispose();
    expect(buckets.buckets()).toEqual([]);
  });
});
