// surface/paint-table.ts (render §6.6; WP R3): the record table (dedupe, 3 RGBA32F texels per paint), the block index, partial
// uploads through a staging texture and `copyTextureToTexture`, and the SRC_PACKED input stage. Node + three, no renderer.
import { Box2, FloatType, Mesh, NearestFilter, Object3D, RGBAFormat, RedFormat, Vector2 } from 'three/webgpu';
import type { Node, Texture } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { PAINT_FLOATS } from '../../../../src/render/geometry/pack.ts';
import {
  MapPaint, MAX_PAINTS, PAINT_TABLE_WIDTH, PAINT_TEXELS, PaintIndex, PaintRecords, paintBaseOf, registerPackedSurface, setPaintBase, type PaintUploader,
} from '../../../../src/render/surface/paint-table.ts';
import type { LightingScript } from '../../../../src/render/surface/script-types.ts';
import { SurfaceMaterials, SurfaceVariant as V, setSurfacePaint } from '../../../../src/render/surface/surface-material.ts';

/** a 12-float record: albedo rgb, alpha, emissive rgb, roughness, metalness, flags, texId, pad */
const rec = (r: number, g = 0.5, alpha = 1, rough = 0.7): number[] => [r, g, 0.25, alpha, 0, 0, 0, rough, 0.1, alpha < 1 ? 2 : 0, 0, 0];
const records = (...list: number[][]): Float32Array => Float32Array.from(list.flat());

interface Copy {
  src: Texture;
  dst: Texture;
  rows: Float32Array;
  region: Box2;
  position: Vector2;
}
function uploader(): PaintUploader & { copies: Copy[] } {
  const copies: Copy[] = [];
  return {
    copies,
    copyTextureToTexture(src, dst, region, position) {
      const image = src.image as { data: Float32Array };
      copies.push({ src, dst, rows: image.data.slice(), region: region!.clone(), position: position!.clone() });
    },
  };
}

describe('PaintRecords', () => {
  it('is an RGBA32F nearest texture, 4,096 wide, sized to its capacity', () => {
    const t = new PaintRecords({ capacity: 3000 });
    expect(PAINT_FLOATS).toBe(12);
    expect(PAINT_TEXELS).toBe(3);
    expect(t.texture.format).toBe(RGBAFormat);
    expect(t.texture.type).toBe(FloatType);
    expect(t.texture.minFilter).toBe(NearestFilter);
    expect(t.texture.magFilter).toBe(NearestFilter);
    expect(t.texture.generateMipmaps).toBe(false);
    expect(t.texture.flipY).toBe(false);
    // 3,000 paints × 3 texels = 9,000 texels → 3 rows of 4,096
    expect([t.texture.image.width, t.texture.image.height]).toEqual([PAINT_TABLE_WIDTH, 3]);
    expect(t.data.byteLength).toBe(4096 * 3 * 16);
    // the default capacity is the D5 id space: 65,535 paints in 48 rows (3.1 MB)
    const full = new PaintRecords();
    expect(full.capacity).toBe(MAX_PAINTS);
    expect(full.texture.image.height).toBe(48);
    expect(full.data.byteLength).toBe(4096 * 48 * 16);
  });

  it('deduplicates records by their float bits and stores each as three texels in record order', () => {
    const t = new PaintRecords({ capacity: 16 });
    const a = t.intern(rec(0.1));
    const b = t.intern(rec(0.2, 0.5, 0.4));
    expect([a, b]).toEqual([0, 1]);
    expect(t.intern(rec(0.1))).toBe(0);
    expect(t.intern(records(rec(0.9), rec(0.2, 0.5, 0.4)), PAINT_FLOATS)).toBe(1);
    expect(t.intern(rec(0.1 + 1e-7))).toBe(2); // a different float32 is a different paint
    // +0 and −0 differ in bits: no accidental merge of records that are not byte-equal
    expect(t.intern([...rec(0.1).slice(0, 4), -0, 0, 0, ...rec(0.1).slice(7)])).toBe(3);
    expect(t.count).toBe(4);
    // texel k of paint id is floats [id·12 + 4k, id·12 + 4k + 4): albedo + alpha, emissive + roughness, metalness / flags / texId / pad
    const p = t.record(1);
    expect(Array.from(p.subarray(0, 4))).toEqual([Math.fround(0.2), 0.5, 0.25, Math.fround(0.4)]);
    expect(p[7]).toBeCloseTo(0.7, 6);
    expect(p[9]).toBe(2);
    expect(Array.from(t.data.subarray(12, 24))).toEqual(Array.from(p));
    expect(() => t.record(4)).toThrow(RangeError);
  });

  it('refuses a paint beyond its capacity and starts again after clear()', () => {
    const t = new PaintRecords({ capacity: 2 });
    t.intern(rec(0.1));
    t.intern(rec(0.2));
    expect(() => t.intern(rec(0.3))).toThrow(/more than 2 distinct paints/);
    expect(t.intern(rec(0.2))).toBe(1);
    t.clear();
    expect(t.count).toBe(0);
    expect(t.intern(rec(0.3))).toBe(0);
  });

  it('holds 65,535 distinct paints', () => {
    const t = new PaintRecords();
    const r = rec(0);
    for (let i = 0; i < MAX_PAINTS; i++) {
      r[7] = i;
      expect(t.intern(r)).toBe(i);
    }
    r[7] = 12345;
    expect(t.intern(r)).toBe(12345);
    r[7] = -1;
    expect(() => t.intern(r)).toThrow(RangeError);
    // a record id is a float in the index, not the vertex's int16: a larger table is allowed (a block still holds ≤ 65,535)
    const big = new PaintRecords({ capacity: 70000 });
    expect(big.capacity).toBe(70000);
    expect(big.texture.image.height).toBe(Math.ceil((70000 * 3) / 4096));
  });
});

describe('MapPaint', () => {
  it('appends each paint list as one contiguous block of record ids and deduplicates the records across blocks', () => {
    const paint = new MapPaint({ paints: 64, entries: 64 });
    expect(paint.index.texture.format).toBe(RedFormat);
    expect(paint.index.texture.type).toBe(FloatType);
    const chunkA = paint.addBlock(records(rec(0.1), rec(0.2), rec(0.3)));
    const chunkB = paint.addBlock(records(rec(0.3), rec(0.4), rec(0.1)));
    const empty = paint.addBlock(new Float32Array(0));
    expect([chunkA, chunkB, empty]).toEqual([0, 3, 6]);
    // 6 index entries, 4 distinct records: the second chunk's ids point at the first chunk's records
    expect(paint.index.count).toBe(6);
    expect(paint.records.count).toBe(4);
    expect(Array.from(paint.index.data.subarray(0, 6))).toEqual([0, 1, 2, 2, 3, 0]);
    expect(paint.recordOf(chunkB, 2)[0]).toBeCloseTo(0.1, 6);
    expect(paint.recordOf(chunkB, 1)[0]).toBeCloseTo(0.4, 6);
    expect(() => paint.addBlock(new Float32Array(13))).toThrow(RangeError);
    // 4 of the 64 records are used (the index has a whole 4,096-entry row)
    expect(paint.fits(60)).toBe(true);
    expect(paint.fits(61)).toBe(false);
    expect(paint.bytes).toBe(paint.records.data.byteLength + paint.index.data.byteLength);
  });

  it('uploads the tables whole once, then only the appended texel rows through the staging texture', () => {
    // a narrow table so a few records span rows: width 8 → 2 paints and 2/3 per record row, 8 entries per index row
    const paint = new MapPaint({ paints: 40, entries: 40, width: 8 });
    paint.addBlock(records(rec(0.1), rec(0.2), rec(0.3)));
    const up = uploader();
    const v0 = [paint.records.texture.version, paint.index.texture.version];
    expect(paint.flush(up)).toEqual({ records: 'full', index: 'full' });
    expect([paint.records.texture.version, paint.index.texture.version]).toEqual([v0[0]! + 1, v0[1]! + 1]);
    expect(up.copies).toHaveLength(0);
    expect(paint.flush(up)).toEqual({ records: 'none', index: 'none' });

    // a runtime append: 9 more paints (ids 3..11 → floats 36..144 → record rows 1..4 of 32 floats), 9 index entries (rows 0..1)
    const before = [paint.records.texture.version, paint.index.texture.version];
    paint.addBlock(records(...[4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => rec(i / 20 + 0.011))));
    expect(paint.flush(up)).toEqual({ records: 'rows', index: 'rows' });
    // the tables themselves were not marked for a whole upload
    expect([paint.records.texture.version, paint.index.texture.version]).toEqual(before);
    const rc = up.copies.filter((c) => c.dst === paint.records.texture);
    const ic = up.copies.filter((c) => c.dst === paint.index.texture);
    expect(rc).toHaveLength(1);
    expect(rc[0]!.src).not.toBe(paint.records.texture);
    expect([rc[0]!.region.min.x, rc[0]!.region.min.y, rc[0]!.region.max.x, rc[0]!.region.max.y]).toEqual([0, 0, 8, 4]);
    expect([rc[0]!.position.x, rc[0]!.position.y]).toEqual([0, 1]);
    // the staging rows are exactly the table's rows 1..4
    expect(Array.from(rc[0]!.rows.subarray(0, 4 * 32))).toEqual(Array.from(paint.records.data.subarray(32, 5 * 32)));
    expect(ic).toHaveLength(1);
    expect([ic[0]!.position.y, ic[0]!.region.max.y]).toEqual([0, 2]);
    expect(Array.from(ic[0]!.rows.subarray(0, 12))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    // more rows than the staging texture holds go in several copies
    up.copies.length = 0;
    paint.addBlock(records(...Array.from({ length: 20 }, (_, i) => rec(0.5 + i / 100))));
    paint.flush(up);
    const again = up.copies.filter((c) => c.dst === paint.records.texture);
    expect(again.map((c) => c.position.y)).toEqual([4, 8]);
    expect(again.map((c) => c.region.max.y)).toEqual([4, 4]);

    // after a device loss the next flush sends everything again; with no uploader a dirty table is sent whole
    paint.markLost();
    expect(paint.flush(up)).toEqual({ records: 'full', index: 'full' });
    paint.addBlock(records(rec(0.99)));
    expect(paint.flush()).toEqual({ records: 'full', index: 'full' });
  });
});

describe('PaintIndex', () => {
  it('is full when its rows are used up', () => {
    const index = new PaintIndex({ capacity: 10, width: 4 });
    expect(index.capacityFloats).toBe(12);
    expect(index.allocate(10)).toBe(0);
    expect(index.free).toBe(2);
    expect(() => index.allocate(3)).toThrow(/full/);
  });
});

describe('the SRC_PACKED stage', () => {
  const script: LightingScript = { lighting: (_s, l) => l.ambient };
  interface UniformLike {
    value: unknown;
    update?: (frame: { object: Object3D | null }) => unknown;
    isUniformNode?: boolean;
  }
  const nodesOf = (root: Node | null): Node[] => {
    const out: Node[] = [];
    root?.traverse((n) => {
      if (!out.includes(n)) out.push(n);
    });
    return out;
  };

  it('feeds colour, opacity, emissive, roughness and metalness from the tables, with the block start as a per-object uniform', () => {
    const paint = new MapPaint({ paints: 16, entries: 16 });
    const materials = new SurfaceMaterials({ script });
    const source = registerPackedSurface(materials, paint);
    const opaque = materials.get({ variant: V.SRC_PACKED | V.SIDE_DOUBLE });
    const glass = materials.get({ variant: V.SRC_PACKED | V.SIDE_DOUBLE | V.TRANSPARENT });
    expect(opaque).not.toBe(glass);
    expect((opaque as unknown as { flatShading: boolean }).flatShading).toBe(true);
    expect(opaque.colorNode).not.toBeNull();
    expect(opaque.opacityNode).toBeNull();
    expect(glass.opacityNode).not.toBeNull();
    expect(glass.transparent).toBe(true);
    // the graph reads both tables and the aliased packed attribute
    const nodes = nodesOf(opaque.colorNode);
    const textures = nodes.filter((n) => (n as unknown as { isTextureNode?: boolean }).isTextureNode === true).map((n) => (n as unknown as { value: Texture }).value);
    expect(textures).toContain(paint.records.texture);
    expect(textures).toContain(paint.index.texture);
    expect(nodes.some((n) => (n as unknown as { _attributeName?: string })._attributeName === 'ssPacked')).toBe(true);
    // paintBase: one uniform, updated per object from what setPaintBase wrote; no material per chunk
    const uniforms = nodes.map((n) => n as unknown as UniformLike & { isTextureNode?: boolean }).filter((u) => u.isUniformNode === true && u.isTextureNode !== true && typeof u.update === 'function');
    expect(uniforms).toHaveLength(1);
    const a = new Mesh();
    const b = new Mesh();
    setPaintBase(a, 300);
    setPaintBase(b, 4096);
    // what three does before a draw of an object: run the hook; the node takes the returned value
    const baseFor = (object: Object3D): unknown => {
      const returned = uniforms[0]!.update!({ object });
      if (returned !== undefined) uniforms[0]!.value = returned;
      return uniforms[0]!.value;
    };
    expect(baseFor(a)).toBe(300);
    expect(baseFor(b)).toBe(4096);
    expect(baseFor(new Mesh())).toBe(0);
    expect(paintBaseOf(a)).toBe(300);
    expect(materials.size).toBe(2);

    // another place: the same materials read the new tables (a bound texture is not part of a program)
    const next = new MapPaint({ paints: 16, entries: 16 });
    source.setTables(next);
    const rebound = nodesOf(opaque.colorNode).filter((n) => (n as unknown as { isTextureNode?: boolean }).isTextureNode === true).map((n) => (n as unknown as { value: Texture }).value);
    expect(rebound).toContain(next.records.texture);
    expect(rebound).toContain(next.index.texture);
    expect(rebound).not.toContain(paint.records.texture);
  });

  it('leaves a row-painted packed variant on the object paint (render §7.4)', () => {
    const materials = new SurfaceMaterials({ script });
    registerPackedSurface(materials, new MapPaint({ paints: 4, entries: 4 }));
    const row = materials.get({ variant: V.SRC_PACKED | V.ROW_PAINT | V.SIDE_DOUBLE });
    const nodes = nodesOf(row.colorNode);
    expect(nodes.some((n) => (n as unknown as { isTextureNode?: boolean }).isTextureNode === true)).toBe(false);
    const mesh = new Mesh();
    setSurfacePaint(mesh, { color: [0.2, 0.4, 0.6] });
    const u = nodes.map((n) => n as unknown as UniformLike).find((x) => x.isUniformNode === true && typeof x.update === 'function')!;
    u.update!({ object: mesh });
    expect((u.value as { x: number; y: number; z: number }).y).toBeCloseTo(0.4, 6);
  });
});
