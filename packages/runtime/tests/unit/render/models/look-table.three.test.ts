// WP R6 (render §7.6, §6.6): the look table and the model paint table as data, and their upload rule. Node + three, no renderer:
// a spy stands in for `renderer.copyTextureToTexture`. The real `texSubImage2D` count is tests/e2e/render-models.spec.ts.
import { Vector2 } from 'three/webgpu';
import type { Texture } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  ALPHA_OPAQUE,
  LOOK_MASK_TEXEL,
  LOOK_MAX_SLOTS,
  LOOK_PART_DIR_TEXEL,
  LOOK_TABLE_ROWS,
  LOOK_TABLE_WIDTH,
  LOOK_WHOLE_UPLOAD_ABOVE,
  LookTable,
  MODEL_PAINT_CAPACITY,
  MODEL_PAINT_PER_ROW,
  MODEL_PAINT_WIDTH,
  ModelPaintTable,
  NEUTRAL_MODEL_PAINT,
  StagedRowTexture,
  lookPartLookTexel,
  lookSlotTexel,
  overrideIsTransparent,
  slotOverrideFromSpec,
  type TableRenderer,
} from '../../../../src/render/surface/look-table.ts';
import { cssToLinear, oklchToLinear } from '../../../../src/render/color/color.ts';

interface Copy {
  src: Texture;
  dst: Texture;
  region: unknown;
  x: number;
  y: number;
  /** what the staging row held when the copy was issued */
  data: Float32Array;
  srcVersion: number;
}

const img = (t: Texture): { data: Float32Array; width: number; height: number } => t.image as { data: Float32Array; width: number; height: number };

function spy(): TableRenderer & { copies: Copy[] } {
  const copies: Copy[] = [];
  return {
    copies,
    copyTextureToTexture(src, dst, region, at) {
      const p = at as Vector2;
      copies.push({ src, dst, region, x: p.x, y: p.y, data: Float32Array.from(img(src).data), srcVersion: src.version });
    },
  };
}

const texel = (row: Float32Array, t: number): number[] => [...row.subarray(t * 4, t * 4 + 4)];

describe('look table layout (render §7.6)', () => {
  it('is one 128 × 512 RGBA32F texture, created once', () => {
    const table = new LookTable();
    expect(table.texture.image.width).toBe(128);
    expect(table.texture.image.height).toBe(512);
    expect(table.rows.data).toBeInstanceOf(Float32Array);
    expect(table.rows.data.byteLength).toBe(128 * 512 * 16); // 1 MiB
    expect(table.rows.rowBytes).toBe(2048);
    expect(table.capacity).toBe(511);
  });

  it('puts slot k at texels 3k..3k+2 for k < 32, and slots 32..36 past the part looks', () => {
    for (let k = 0; k < 32; k++) expect(lookSlotTexel(k)).toBe(k * 3);
    expect(lookSlotTexel(31) + 2).toBe(95);
    expect(lookSlotTexel(32)).toBe(111);
    expect(lookSlotTexel(36) + 2).toBe(125);
    expect(() => lookSlotTexel(LOOK_MAX_SLOTS)).toThrow(RangeError);
    expect([0, 1, 2, 3].map(lookPartLookTexel)).toEqual([99, 102, 105, 108]);
    expect(LOOK_MASK_TEXEL).toBe(96);
    expect(LOOK_PART_DIR_TEXEL).toBe(98);
  });

  it('writes a slot override as (albedo rgb, mode) (emissive rgb, alpha) (roughness, metalness, active, 0), unset fields as -1', () => {
    const table = new LookTable();
    const row = table.allocate();
    const base = oklchToLinear('oklch(0.65 0.12 145)')!;
    const glow = oklchToLinear('oklch(0.72 0.08 60)')!;
    // Binary-exact material scalars keep the table encoding assertions precise.
    table.setSlot(row, 5, { mode: 'replace', albedo: base, emissive: [glow[0] * 0.75, glow[1] * 0.75, glow[2] * 0.75], roughness: 0.375 });
    const data = table.rowData(row);
    const f = Math.fround;
    expect(texel(data, 15)).toEqual([f(base[0]), f(base[1]), f(base[2]), 1]);
    expect(texel(data, 16)).toEqual([f(glow[0] * 0.75), f(glow[1] * 0.75), f(glow[2] * 0.75), -1]);
    expect(texel(data, 17)).toEqual([0.375, -1, 1, 0]);
    // nothing else of the row is touched
    expect([...data.subarray(0, 15 * 4)].every((x) => x === 0)).toBe(true);
    expect([...data.subarray(18 * 4)].every((x) => x === 0)).toBe(true);
    expect(table.slotIsActive(row, 5)).toBe(true);

    // tint, alpha only, an emissive scale
    table.setSlot(row, 0, { mode: 'tint', albedo: [0.5, 0.25, 1] });
    expect(texel(data, 0)).toEqual([0.5, 0.25, 1, 0]);
    expect(texel(data, 1)).toEqual([-1, -1, -1, -1]);
    table.setSlot(row, 33, { mode: 'replace', alpha: 0.12, emissiveScale: 1.5 });
    expect(texel(data, 114)).toEqual([-1, -1, -1, 1]);
    expect(texel(data, 115)).toEqual([-2, 1.5, 0, f(0.12)]);
    expect(texel(data, 116)).toEqual([-1, -1, 1, 0]);

    // null clears the entry to zeros (active 0)
    table.setSlot(row, 5, null);
    expect([...data.subarray(15 * 4, 18 * 4)].every((x) => x === 0)).toBe(true);
    expect(table.slotIsActive(row, 5)).toBe(false);
  });

  it('stores the part mask at texel 96 (and 97) as 16-bit integers in floats', () => {
    const table = new LookTable();
    const row = table.allocate();
    const data = table.rowData(row);
    table.setPartHidden(row, 0, true);
    table.setPartHidden(row, 15, true);
    table.setPartHidden(row, 16, true);
    table.setPartHidden(row, 47, true);
    table.setPartHidden(row, 63, true);
    expect(texel(data, 96)).toEqual([0x8001, 0x0001, 0x8000, 0x8000]);
    expect(texel(data, 97)).toEqual([0, 0, 0, 0]);
    table.setPartHidden(row, 64, true);
    table.setPartHidden(row, 127, true);
    expect(texel(data, 97)).toEqual([1, 0, 0, 0x8000]);
    expect(table.partIsHidden(row, 47)).toBe(true);
    table.setPartHidden(row, 47, false);
    expect(table.partIsHidden(row, 47)).toBe(false);
    expect(texel(data, 96)).toEqual([0x8001, 0x0001, 0, 0x8000]);
    expect(() => table.setPartHidden(row, 128, true)).toThrow(RangeError);
    // every value is an integer a float32 holds exactly
    for (const x of data.subarray(96 * 4, 98 * 4)) expect(Number.isInteger(x) && x >= 0 && x <= 0xffff).toBe(true);
  });

  it('holds four part looks per row, listed in the directory texel as part id + 1', () => {
    const table = new LookTable();
    const row = table.allocate();
    const data = table.rowData(row);
    expect(table.setPartLook(row, 7, { mode: 'replace', emissive: [1, 2, 3] })).toBe(true);
    expect(table.setPartLook(row, 40, { mode: 'replace', albedo: [0.1, 0.2, 0.3], emissiveScale: 2 })).toBe(true);
    expect(texel(data, 98)).toEqual([8, 41, 0, 0]);
    expect(texel(data, 100)).toEqual([1, 2, 3, -1]);
    expect(texel(data, 102)).toEqual([Math.fround(0.1), Math.fround(0.2), Math.fround(0.3), 1]);
    // the same part again rewrites its entry
    expect(table.setPartLook(row, 7, { mode: 'replace', roughness: 0.5 })).toBe(true);
    expect(texel(data, 98)).toEqual([8, 41, 0, 0]);
    expect(texel(data, 101)).toEqual([0.5, -1, 1, 0]);
    expect(table.setPartLook(row, 1, { mode: 'replace', roughness: 0 })).toBe(true);
    expect(table.setPartLook(row, 2, { mode: 'replace', roughness: 0 })).toBe(true);
    // a fifth part does not fit
    expect(table.setPartLook(row, 3, { mode: 'replace', roughness: 0 })).toBe(false);
    // clearing one frees its entry
    expect(table.setPartLook(row, 7, null)).toBe(true);
    expect(texel(data, 98)).toEqual([0, 41, 2, 3]);
    expect([...data.subarray(99 * 4, 102 * 4)].every((x) => x === 0)).toBe(true);
    expect(table.setPartLook(row, 3, { mode: 'replace', roughness: 0 })).toBe(true);
    expect(texel(data, 98)).toEqual([4, 41, 2, 3]);
  });
});

describe('look table rows', () => {
  it('never hands out row 0, clears a row it hands out, and reuses a released row', () => {
    const table = new LookTable();
    const a = table.allocate();
    const b = table.allocate();
    expect(a).toBe(1);
    expect(b).toBe(2);
    table.setSlot(a, 0, { mode: 'replace', roughness: 0.3 });
    table.setPartHidden(a, 3, true);
    table.release(a);
    expect([...table.rowData(a)].every((x) => x === 0)).toBe(true);
    expect(table.used).toBe(1);
    expect(table.allocate()).toBe(a);
    // writes on a row that is not allocated do nothing
    expect(table.setSlot(400, 0, { mode: 'replace', roughness: 0.3 })).toBe(false);
    expect(table.setSlot(0, 0, { mode: 'replace', roughness: 0.3 })).toBe(false);
    expect([...table.rowData(0)].every((x) => x === 0)).toBe(true);
  });

  it('evicts the oldest baked corpse when it is full, and falls back to the neutral row when there is none', () => {
    const logs: string[] = [];
    const table = new LookTable({ log: (m) => logs.push(m) });
    const evicted: number[] = [];
    const corpses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const row = table.allocate('corpse', () => evicted.push(row));
      corpses.push(row);
    }
    // an instance row handed to its corpse becomes the newest corpse
    const handed = table.allocate('instance');
    table.setSlot(handed, 2, { mode: 'replace', roughness: 0.4 });
    table.retag(handed, 'corpse', () => evicted.push(handed));
    expect(table.kindOf(handed)).toBe('corpse');
    expect(table.slotIsActive(handed, 2)).toBe(true); // the overrides stay with the corpse
    while (table.used < table.capacity) table.allocate('instance');
    expect(table.used).toBe(LOOK_TABLE_ROWS - 1);

    table.setSlot(corpses[0]!, 1, { mode: 'replace', roughness: 0.9 });
    const taken = table.allocate('instance');
    expect(evicted).toEqual([corpses[0]]);
    expect(taken).toBe(corpses[0]);
    expect(table.kindOf(taken)).toBe('instance');
    expect([...table.rowData(taken)].every((x) => x === 0)).toBe(true);
    expect(table.allocate()).toBe(corpses[1]);
    expect(table.allocate()).toBe(corpses[2]);
    expect(table.allocate()).toBe(handed);
    expect(evicted).toEqual([...corpses, handed]);
    // no corpse left
    expect(table.allocate()).toBe(0);
    expect(table.allocate()).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/511 rows are in use/);
  });
});

describe('upload rule (render §6.6, §7.6)', () => {
  it('uploads the whole table once, then one 128 × 1 row per written row', () => {
    const table = new LookTable();
    const r = spy();
    const row = table.allocate();
    const other = table.allocate();
    // the first flush is the whole upload of a new texture
    const version0 = table.texture.version;
    expect(table.flush(r)).toEqual({ rows: 0, whole: true, bytes: 128 * 512 * 16 });
    expect(table.texture.version).toBe(version0 + 1);
    expect(r.copies).toHaveLength(0);
    expect(table.flush(r)).toEqual({ rows: 0, whole: false, bytes: 0 });

    // one slot write: exactly one copy of a 128 × 1 source to (0, row); the table itself is not marked for upload
    const version = table.texture.version;
    table.setSlot(row, 4, { mode: 'replace', albedo: [0.25, 0.5, 0.75], roughness: 0.25 });
    expect(table.rows.dirtyRows).toBe(1);
    expect(table.flush(r)).toEqual({ rows: 1, whole: false, bytes: 2048 });
    expect(r.copies).toHaveLength(1);
    const c = r.copies[0]!;
    expect(c.dst).toBe(table.texture);
    expect(c.region).toBeNull();
    expect([c.x, c.y]).toEqual([0, row]);
    expect(img(c.src).width).toBe(LOOK_TABLE_WIDTH);
    expect(img(c.src).height).toBe(1);
    expect(c.data.byteLength).toBe(2048);
    expect([...c.data]).toEqual([...table.rowData(row)]);
    expect(c.srcVersion).toBeGreaterThan(0); // the staging row was marked for its own (2 KiB) upload
    expect(table.texture.version).toBe(version);
    expect(table.rows.stats).toMatchObject({ rowCopies: 1, wholeUploads: 1 });

    // several writes to two rows in one frame: two copies, one staging row each, from a small pool that is reused
    table.setSlot(row, 4, null);
    table.setPartHidden(row, 9, true);
    table.setSlot(other, 0, { mode: 'tint', albedo: [1, 0, 0] });
    expect(table.flush(r)).toEqual({ rows: 2, whole: false, bytes: 4096 });
    expect(r.copies).toHaveLength(3);
    expect(r.copies.slice(1).map((x) => x.y).sort()).toEqual([row, other].sort());
    expect(r.copies[1]!.src).not.toBe(r.copies[2]!.src);
    expect(r.copies[1]!.src).toBe(c.src);
    expect(table.rows.stagingRows).toBe(2);
    expect(table.texture.version).toBe(version);
    // a write that changes nothing is not an upload
    table.setPartHidden(row, 9, true);
    expect(table.flush(r)).toEqual({ rows: 0, whole: false, bytes: 0 });
  });

  it('uploads the table whole when more than 64 rows are dirty', () => {
    const table = new LookTable();
    const r = spy();
    const rows = Array.from({ length: LOOK_WHOLE_UPLOAD_ABOVE + 1 }, () => table.allocate());
    table.flush(r);
    const version = table.texture.version;
    for (const row of rows.slice(0, LOOK_WHOLE_UPLOAD_ABOVE)) table.setPartHidden(row, 1, true);
    expect(table.flush(r)).toMatchObject({ rows: 64, whole: false });
    expect(r.copies).toHaveLength(64);
    expect(table.texture.version).toBe(version);
    for (const row of rows) table.setPartHidden(row, 2, true);
    expect(table.flush(r)).toEqual({ rows: 0, whole: true, bytes: 1024 * 1024 });
    expect(r.copies).toHaveLength(64);
    expect(table.texture.version).toBe(version + 1);
    expect(table.rows.stagingRows).toBe(64);
  });

  it('re-uploads everything after a device loss, and whole on every flush without partial uploads', () => {
    const table = new LookTable();
    const r = spy();
    const row = table.allocate();
    table.flush(r);
    table.rows.markAll();
    table.setPartHidden(row, 1, true);
    expect(table.flush(r)).toMatchObject({ whole: true });
    expect(r.copies).toHaveLength(0);

    const coarse = new StagedRowTexture({ width: 8, height: 4, name: 't', partialUploads: false });
    coarse.flush(r);
    coarse.data[0] = 1;
    coarse.markRow(0);
    expect(coarse.flush(r)).toEqual({ rows: 0, whole: true, bytes: 8 * 4 * 16 });
    expect(r.copies).toHaveLength(0);
  });
});

describe('model paint table (render §11.3 step 3)', () => {
  it('is one shared RGBA32F texture of 3 texels per paint, with paint 0 neutral', () => {
    const table = new ModelPaintTable();
    expect(table.texture.image.width).toBe(MODEL_PAINT_WIDTH);
    expect(MODEL_PAINT_WIDTH).toBe(MODEL_PAINT_PER_ROW * 3);
    expect(MODEL_PAINT_CAPACITY).toBeGreaterThanOrEqual(2825); // every material of the 593 built models at once
    expect(table.read(0)).toEqual(NEUTRAL_MODEL_PAINT);
    expect(table.freePaints).toBe(MODEL_PAINT_CAPACITY - 1);
  });

  it('allocates blocks first-fit, frees and merges them, and throws when no run fits', () => {
    const table = new ModelPaintTable();
    const a = table.allocate(25);
    const b = table.allocate(300);
    const c = table.allocate(10);
    expect([a, b, c]).toEqual([1, 26, 326]);
    table.free(a, 25);
    table.free(c, 10);
    expect(table.allocate(20)).toBe(1);
    table.free(1, 20);
    table.free(b, 300);
    // everything merged back into one run
    expect(table.freePaints).toBe(MODEL_PAINT_CAPACITY - 1);
    expect(table.allocate(MODEL_PAINT_CAPACITY - 1)).toBe(1);
    expect(() => table.allocate(1)).toThrow(/no run of 1 free paints/);
  });

  it('writes a paint at (id % 256) * 3 of row id / 256 and uploads only the rows written', () => {
    const table = new ModelPaintTable();
    const r = spy();
    table.flush(r);
    const id = 256 + 7;
    table.write(id, { albedo: [0.1, 0.2, 0.3], alpha: 0.5, emissive: [4, 5, 6], roughness: 0.7, metalness: 0.8, texSet: 2 });
    const o = (MODEL_PAINT_WIDTH + 7 * 3) * 4;
    const f = Math.fround;
    expect([...table.rows.data.subarray(o, o + 12)]).toEqual([f(0.1), f(0.2), f(0.3), 0.5, 4, 5, 6, 2, f(0.7), f(0.8), 0, 0]);
    expect(table.read(id)).toEqual({ albedo: [f(0.1), f(0.2), f(0.3)], alpha: 0.5, emissive: [4, 5, 6], roughness: f(0.7), metalness: f(0.8), texSet: 2 });
    expect(table.flush(r)).toEqual({ rows: 1, whole: false, bytes: MODEL_PAINT_WIDTH * 16 });
    expect(r.copies).toHaveLength(1);
    expect([r.copies[0]!.x, r.copies[0]!.y]).toEqual([0, 1]);
    expect(img(r.copies[0]!.src).width).toBe(MODEL_PAINT_WIDTH);
  });
});

describe('slot overrides from a material spec (`model.materials[slot]` / `model.parts[node]`)', () => {
  it('maps synthetic color, emissive and opacity overrides', () => {
    const base = cssToLinear('oklch(0.65 0.12 145)')!;
    const glow = cssToLinear('oklch(0.72 0.08 60)')!;
    const painted = slotOverrideFromSpec({ color: 'oklch(0.65 0.12 145)', emissive: 'oklch(0.72 0.08 60)', emissiveIntensity: 0.75, roughness: 0.375 })!;
    expect(painted.mode).toBe('replace');
    expect(painted.albedo).toEqual(base);
    expect(painted.emissive).toEqual([glow[0] * 0.75, glow[1] * 0.75, glow[2] * 0.75]);
    expect(painted.roughness).toBe(0.375);
    expect(painted.alpha).toBeUndefined();

    const accent = cssToLinear('oklch(0.45 0.15 300)')!;
    const opaque = slotOverrideFromSpec({ emissive: 'oklch(0.45 0.15 300)', emissiveIntensity: 0.25, transparent: false, opacity: 1 })!;
    expect(opaque.albedo).toBeUndefined();
    expect(opaque.emissive).toEqual([accent[0] * 0.25, accent[1] * 0.25, accent[2] * 0.25]);
    expect(opaque.alpha).toBe(1);
    expect(overrideIsTransparent(opaque)).toBe(false);

    const emissiveOnly = slotOverrideFromSpec({ emissive: 'oklch(0.72 0.08 60)', emissiveIntensity: 0.25 })!;
    expect(emissiveOnly).toEqual({ mode: 'replace', emissive: [glow[0] * 0.25, glow[1] * 0.25, glow[2] * 0.25] });
  });

  it('maps transparency, intensity-only emission and empty specs', () => {
    const transparent = slotOverrideFromSpec({ transparent: true, opacity: 0.3 })!;
    expect(transparent).toEqual({ mode: 'replace', alpha: 0.3 });
    expect(overrideIsTransparent(transparent)).toBe(true);
    expect(overrideIsTransparent({ mode: 'replace', alpha: ALPHA_OPAQUE })).toBe(false);
    // `transparent: false` wins over an opacity (three's rule)
    expect(slotOverrideFromSpec({ transparent: false, opacity: 0.4 })).toEqual({ mode: 'replace', alpha: 1 });
    // Intensity-only emission scales the existing model color.
    expect(slotOverrideFromSpec({ emissiveIntensity: 0.9 })).toEqual({ mode: 'replace', emissiveScale: 0.9 });
    expect(slotOverrideFromSpec({})).toBeNull();
    expect(slotOverrideFromSpec(null)).toBeNull();
    expect(slotOverrideFromSpec({ color: 'not a colour' })).toBeNull();
  });
});
