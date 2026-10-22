// H1 (INTEGRATION.md): the geometry recorder runs a rigged generator: `skeleton()` is accepted on a module, `ctx.bone` is on
// the ctx only for runs given a rig (`RecorderOptions.rig`), the mesh carries one bone per triangle, and a collider run of a
// rigged module has `ctx.bone` too. Without a rig everything is PP's path.
import { describe, expect, it } from 'vitest';
import { type GeneratorModule, isGeneratorModule } from '../../src/render/geometry/generator-types.ts';
import { createDiagnostics, runCollider, runGeometry } from '../../src/render/geometry/recorder.ts';
import { UnknownBoneError, moduleRig } from '../../src/render/rig/index.ts';
import { BEAN } from './bean.ts';

const spec = { kind: 'scripted', script: 'scripts/gen/bean.js', params: { hue: 190 } };
const { rig } = moduleRig(spec.script, BEAN)!;
const tri = (c: { tri: (...v: number[]) => void }): void => c.tri(0, 0, 0, 1, 0, 0, 0, 1, 0);

describe('H1 recorder: skeleton() and ctx.bone', () => {
  it('accepts a skeleton() export and rejects a non-function one', () => {
    expect(isGeneratorModule(BEAN)).toBe(true);
    expect(isGeneratorModule({ geometry: () => undefined, skeleton: {} })).toBe(false);
    expect(moduleRig('x.js', { geometry: () => undefined } as GeneratorModule)).toBeNull();
  });

  it('without a rig: no ctx.bone, no triBone (PP path)', () => {
    let seen: unknown = 'unset';
    const plain: GeneratorModule = {
      geometry: (c) => {
        seen = c.bone;
        tri(c);
      },
    };
    const mesh = runGeometry(plain, spec, 1, { strict: true });
    expect(seen).toBeUndefined();
    expect(mesh.triBone).toBeUndefined();
    expect(() => runGeometry(BEAN, spec, 1, { strict: true })).toThrow(/bone is not a function/);
  });

  it('with the rig: one bone per triangle, in the order the parts were emitted', () => {
    const mesh = runGeometry(BEAN, spec, 1, { strict: true, rig });
    expect(mesh.triBone).toBeInstanceOf(Uint16Array);
    expect(mesh.triBone!.length).toBe(mesh.tris);
    const runs: string[] = [];
    for (const b of mesh.triBone!) if (runs[runs.length - 1] !== rig.bones[b]) runs.push(rig.bones[b]!);
    expect(runs).toEqual(['legL', 'legR', 'body', 'armL', 'armR', 'body', 'eyes']);
    // a foot: 4 profile bands × 16 segments × 2 triangles
    expect([...mesh.triBone!].filter((b) => b === rig.index('legL')).length).toBe(4 * 16 * 2);
    expect([...mesh.triBone!].includes(rig.index('root'))).toBe(false);
  });

  it('every LOD binds the same parts', () => {
    for (const lod of [1, 3, 5] as const) {
      const mesh = runGeometry(BEAN, spec, lod, { rig });
      expect(new Set([...mesh.triBone!].map((b) => rig.bones[b]))).toEqual(new Set(['legL', 'legR', 'body', 'armL', 'armR', 'eyes']));
    }
  });

  it('an unknown bone throws in strict runs and binds to the root (counted) otherwise', () => {
    const bad: GeneratorModule = {
      geometry: (c) => {
        c.bone!('tail');
        tri(c);
      },
    };
    expect(() => runGeometry(bad, spec, 1, { strict: true, rig })).toThrow(UnknownBoneError);
    const diag = createDiagnostics();
    const mesh = runGeometry(bad, spec, 1, { diag, rig });
    expect([...mesh.triBone!]).toEqual([rig.index('root')]);
    expect(diag.counts['unknownBone']).toBe(1);
  });

  it('runCollider: the visual fallback and a collider() export both have ctx.bone', () => {
    expect(runCollider(BEAN, spec, { strict: true, rig }).kind).toBe('tris');
    const withCollider: GeneratorModule = {
      ...BEAN,
      collider: (c) => {
        c.bone!('body');
        return { kind: 'sphere', radius: 0.45 };
      },
    };
    expect(runCollider(withCollider, spec, { strict: true, rig })).toEqual({ kind: 'sphere', radius: 0.45 });
    expect(() => runCollider(withCollider, spec, { strict: true })).toThrow(/bone is not a function/);
  });

  it('a { joints, weights } return stays unsupported (soft skinning is out of scope)', () => {
    const soft: GeneratorModule = {
      geometry: (c) => {
        tri(c);
        return { joints: [0, 0, 0], weights: [1, 1, 1] };
      },
    };
    expect(() => runGeometry(soft, spec, 1, { strict: true, rig })).toThrow(/unsupported return/);
  });
});
