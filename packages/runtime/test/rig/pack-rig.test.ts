// H2 (INTEGRATION.md): packing a rigged recording keys vertices by bone (no vertex shared, no normal smoothed, across two
// bones), writes one bone per vertex (`PackedLod.skinIndex`) and transfers it; the skin attributes are joint 0 = that bone at
// weight 1.0. A recording without a rig packs exactly as before.
import { describe, expect, it } from 'vitest';
import type { GeneratorModule } from '../../src/render/geometry/generator-types.ts';
import { packMesh, packedKeyTransfers, type PackedKey } from '../../src/render/geometry/pack.ts';
import { runGeometry } from '../../src/render/geometry/recorder.ts';
import { moduleRig, packedSkinAttributes } from '../../src/render/rig/index.ts';
import { BEAN } from './bean.ts';

const spec = { kind: 'scripted', script: 'scripts/gen/bean.js', params: { hue: 190 } };
const { rig } = moduleRig(spec.script, BEAN)!;

/** two quads meeting at a 90° edge (x = 1), the first on `body`, the second on `armR`; smooth or flat */
const hinge = (smooth: boolean): GeneratorModule => ({
  skeleton: BEAN.skeleton,
  geometry(c) {
    if (smooth) c.smooth();
    c.bone!('body');
    c.quad(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0);
    c.bone!('armR');
    c.quad(1, 0, 0, 1, 0, -1, 1, 1, -1, 1, 1, 0);
  },
});

describe('H2 pack: a bone per vertex', () => {
  it('vertices are not shared across bones: the hinge edge is cut into two', () => {
    const plain: GeneratorModule = {
      geometry(c) {
        c.quad(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0);
        c.quad(1, 0, 0, 1, 0, -1, 1, 1, -1, 1, 1, 0);
      },
    };
    const unrigged = packMesh(runGeometry(plain, spec, 1));
    expect(unrigged.vertices).toBe(6);
    expect(unrigged.skinIndex).toBeUndefined();
    const lod = packMesh(runGeometry(hinge(false), spec, 1, { rig }));
    expect(lod.vertices).toBe(8);
    expect(lod.skinIndex!.length).toBe(8);
    expect([...lod.skinIndex!].filter((b) => b === rig.index('body')).length).toBe(4);
    expect([...lod.skinIndex!].filter((b) => b === rig.index('armR')).length).toBe(4);
  });

  it('smooth normals are not averaged across bones', () => {
    const lod = packMesh(runGeometry(hinge(true), spec, 1, { rig }));
    const n = lod.normals!;
    for (let v = 0; v < lod.vertices; v++) {
      const nx = n[v * 4]!, nz = n[v * 4 + 2]!;
      // body quad faces +Z, armR quad faces +X: each keeps its own face normal, no 45° blend on the edge
      if (lod.skinIndex![v] === rig.index('body')) expect([Math.abs(nx), Math.abs(nz)]).toEqual([0, 127]);
      else expect([Math.abs(nx), Math.abs(nz)]).toEqual([127, 0]);
    }
  });

  it('every triangle of the packed bean is rigid (its three vertices share one bone) and all six parts survive', () => {
    for (const lod of [1, 3, 5] as const) {
      const packed = packMesh(runGeometry(BEAN, spec, lod, { rig }));
      const si = packed.skinIndex!;
      expect(si.length).toBe(packed.vertices);
      for (let i = 0; i < packed.idx.length; i += 3) {
        const b = si[packed.idx[i]!]!;
        expect(si[packed.idx[i + 1]!]).toBe(b);
        expect(si[packed.idx[i + 2]!]).toBe(b);
      }
      expect(new Set([...si].map((b) => rig.bones[b]))).toEqual(new Set(['legL', 'legR', 'body', 'armL', 'armR', 'eyes']));
    }
  });

  it('skinIndex is transferred with the key, and expands to joint 0 at weight 1.0', () => {
    const lod = packMesh(runGeometry(BEAN, spec, 2, { rig }));
    const key: PackedKey = { key: 'k', script: spec.script, lods: [lod], ms: 0 };
    expect(packedKeyTransfers(key)).toContain(lod.skinIndex!.buffer);
    const { skinIndex, skinWeight } = packedSkinAttributes(lod.skinIndex!);
    expect(skinIndex.length).toBe(lod.vertices * 4);
    for (let v = 0; v < lod.vertices; v++) {
      expect(skinIndex[v * 4]).toBe(lod.skinIndex![v]);
      expect([skinIndex[v * 4 + 1], skinIndex[v * 4 + 2], skinIndex[v * 4 + 3]]).toEqual([0, 0, 0]);
      expect([...skinWeight.subarray(v * 4, v * 4 + 4)]).toEqual([1, 0, 0, 0]);
    }
  });
});
