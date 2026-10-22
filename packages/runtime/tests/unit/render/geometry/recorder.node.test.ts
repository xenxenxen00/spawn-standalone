// recorder.ts: the isomorphic GeometryContext emulation (render §6.2, §18.1 "geometry recorder").
import { describe, expect, it } from 'vitest';
import type { GeneratorModule, GeometryContext, ScriptedSpec } from '../../../../src/render/geometry/generator-types.ts';
import {
  createDiagnostics,
  InvalidColliderReturn,
  runCollider,
  runGeometry,
  UnsupportedGeometryReturn,
  DEFAULT_PAINT,
} from '../../../../src/render/geometry/recorder.ts';
import { generatorRandom } from '../../../../src/render/geometry/rng.ts';

const spec = (params: unknown = {}, seed?: number): ScriptedSpec =>
  seed === undefined ? { kind: 'scripted', script: 'scripts/gen/test.js', params } : { kind: 'scripted', script: 'scripts/gen/test.js', params, seed };

const mod = (geometry: (ctx: GeometryContext) => unknown, collider?: (ctx: GeometryContext) => unknown): GeneratorModule =>
  collider ? { geometry, collider } : { geometry };

/** A stand-in for `scripts/gen/poly.js` `polyfy`: replaces methods on the ctx and calls the originals with `.call(ctx, …)`. */
function fakePolyfy(ctx: GeometryContext): void {
  const C = ctx.color;
  const R = ctx.roughness;
  ctx.color = (c, a) => {
    if (a !== undefined) C.call(ctx, c, a);
    else C.call(ctx, c);
  };
  ctx.smooth = () => {};
  ctx.roughness = (r) => R.call(ctx, Math.max(0.65, (r as number | undefined) ?? 0.85));
  ctx['__poly'] = true;
}

describe('GeometryContext', () => {
  it('is a plain extensible object with own-property methods that work unbound', () => {
    let seen: GeometryContext | undefined;
    const rec = runGeometry(
      mod((ctx) => {
        seen = ctx;
        expect(Object.isExtensible(ctx)).toBe(true);
        expect(Object.isFrozen(ctx)).toBe(false);
        for (const m of ['tri', 'quad', 'flat', 'smooth', 'color', 'emissive', 'roughness', 'metalness', 'albedo', 'random', 'noise2d', 'noise3d']) {
          expect(Object.prototype.hasOwnProperty.call(ctx, m), m).toBe(true);
          expect(typeof ctx[m], m).toBe('function');
        }
        ctx['__col'] = 'scratch';
        ctx['__zones'] = { a: 1 };
        const { tri } = ctx;
        tri(0, 0, 0, 1, 0, 0, 0, 1, 0);
        ctx.tri.bind(ctx)(0, 0, 1, 1, 0, 1, 0, 1, 1);
        ctx.quad.call(undefined, 0, 0, 2, 1, 0, 2, 1, 1, 2, 0, 1, 2);
      }),
      spec(),
      1,
    );
    expect(seen?.['__col']).toBe('scratch');
    expect(rec.tris).toBe(4);
  });

  it('copies params for every run and exposes seed and lod', () => {
    const params = { kind: 'crate', nested: { n: 1 }, list: [1, 2] };
    const seenLods: number[] = [];
    const m = mod(
      (ctx) => {
        expect(ctx.params).toEqual(params);
        expect(ctx.params).not.toBe(params);
        expect(ctx.params['nested']).not.toBe(params.nested);
        (ctx.params['nested'] as { n: number }).n = 99;
        (ctx.params['list'] as number[]).push(3);
        expect(ctx.seed).toBe(7);
        seenLods.push(ctx.lod);
        ctx.tri(0, 0, 0, 1, 0, 0, 0, 1, 0);
      },
      (ctx) => {
        expect(ctx.lod).toBe(1);
        expect(ctx.params).toEqual(params);
      },
    );
    for (const lod of [1, 3, 5] as const) runGeometry(m, spec(params, 7), lod);
    runCollider(m, spec(params, 7));
    expect(seenLods).toEqual([1, 3, 5]);
    expect(params.nested.n).toBe(1);
    expect(params.list).toEqual([1, 2]);
    runGeometry(mod((ctx) => expect(ctx.params).toEqual({})), { script: 'scripts/gen/x.js' }, 1);
    runGeometry(mod((ctx) => expect(ctx.seed).toBe(0)), { script: 'scripts/gen/x.js' }, 1);
  });

  it('restarts ctx.random for every LOD run and for the collider run', () => {
    const seqs: number[][] = [];
    const draw = (ctx: GeometryContext): void => {
      seqs.push([ctx.random(), ctx.random(), ctx.random()]);
    };
    const m = mod(draw, draw);
    runGeometry(m, spec({}, 5), 1);
    runGeometry(m, spec({}, 5), 3);
    runCollider(m, spec({}, 5));
    const ref = generatorRandom(5);
    const expected = [ref(), ref(), ref()];
    expect(seqs).toEqual([expected, expected, expected]);
  });

  it('records triangles with the stateful paint, splitting quads on the 0-2 diagonal', () => {
    const rec = runGeometry(
      mod((ctx) => {
        ctx.tri(0, 0, 0, 1, 0, 0, 0, 1, 0);
        ctx.color('oklch(0.5 0.1 30)');
        ctx.roughness(0.4);
        ctx.quad(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0);
        ctx.color('oklch(0.5 0.1 30)');
        ctx.roughness(0.4);
        ctx.tri(5, 5, 5, 6, 5, 5, 5, 6, 5);
      }),
      spec(),
      2,
    );
    expect(rec.lod).toBe(2);
    expect(rec.tris).toBe(4);
    expect(Array.from(rec.positions.subarray(9, 27))).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]);
    expect(Array.from(rec.triPaint)).toEqual([0, 1, 1, 1]);
    expect(Array.from(rec.triShape)).toEqual([0, 1, 2, 0]);
    expect(rec.emitted).toBe(3 + 4 + 3);
    expect(rec.paints).toHaveLength(2);
    expect(rec.paints[0]).toEqual(DEFAULT_PAINT);
    expect(rec.paints[1]).toMatchObject({ color: 'oklch(0.5 0.1 30)', roughness: 0.4, metalness: 0, emissive: null, albedo: null, smooth: false });
  });

  it('defaults to white, alpha 1, roughness 0.85, metalness 0, no emissive, no albedo, flat', () => {
    expect(DEFAULT_PAINT).toEqual({ color: 'oklch(1 0 0)', alpha: undefined, emissive: null, roughness: 0.85, metalness: 0, albedo: null, smooth: false });
  });

  it('captures alpha, emissive forms and albedo', () => {
    const rec = runGeometry(
      mod((ctx) => {
        const t = (): void => ctx.tri(0, 0, 0, 1, 0, 0, 0, 1, 0);
        ctx.color('oklch(0.2 0.03 230)', 0.45);
        t();
        ctx.color('oklch(0.9 0 0)');
        ctx.emissive(2.4, 1.4, 0.45);
        t();
        ctx.emissive([3, 1, 0.2]);
        t();
        ctx.emissive('oklch(0.6 0.25 25)');
        t();
        ctx.emissive(null);
        ctx.albedo('cdn/texture-x.png');
        t();
        ctx.albedo(null);
        ctx.metalness(0.7);
        t();
      }),
      spec(),
      1,
    );
    expect(rec.paints.map((p) => [p.alpha, p.emissive, p.albedo, p.metalness])).toEqual([
      [0.45, null, null, 0],
      [undefined, [2.4, 1.4, 0.45], null, 0],
      [undefined, [3, 1, 0.2], null, 0],
      [undefined, 'oklch(0.6 0.25 25)', null, 0],
      [undefined, null, 'cdn/texture-x.png', 0],
      [undefined, null, null, 0.7],
    ]);
  });

  it('works with a polyfy-style wrapper that replaces methods and calls the originals with .call', () => {
    const rec = runGeometry(
      mod((ctx) => {
        fakePolyfy(ctx);
        ctx.color('oklch(0.3 0.05 40)', 0.5);
        ctx.roughness(0.2);
        ctx.smooth();
        ctx.tri(0, 0, 0, 1, 0, 0, 0, 1, 0);
      }),
      spec(),
      1,
    );
    expect(rec.paints[0]).toMatchObject({ color: 'oklch(0.3 0.05 40)', alpha: 0.5, roughness: 0.65, smooth: false });
  });

  it('numbers smoothing runs: a run continues across smooth() calls until flat()', () => {
    const rec = runGeometry(
      mod((ctx) => {
        const t = (): void => ctx.tri(0, 0, 0, 1, 0, 0, 0, 1, 0);
        t(); // flat
        ctx.smooth();
        t(); // run 1
        ctx.smooth();
        t(); // still run 1
        ctx.flat();
        t(); // flat
        ctx.smooth();
        t(); // run 2
      }),
      spec(),
      1,
    );
    expect(rec.triRun && Array.from(rec.triRun)).toEqual([0, 1, 1, 0, 2]);
    expect(rec.paints.map((p) => p.smooth)).toEqual([false, true]);
    const flatOnly = runGeometry(mod((ctx) => ctx.tri(0, 0, 0, 1, 0, 0, 0, 1, 0)), spec(), 1);
    expect(flatOnly.triRun).toBeNull();
  });

  it('gives noise2d/noise3d in [-1, 1]', () => {
    runGeometry(
      mod((ctx) => {
        const a = ctx.noise3d(1.3, 2.7, -4.1);
        const b = ctx.noise2d(0.4, 9.9);
        expect(Math.abs(a)).toBeLessThanOrEqual(1);
        expect(Math.abs(b)).toBeLessThanOrEqual(1);
      }),
      spec(),
      1,
    );
  });
});

describe('geometry() return values', () => {
  it('accepts void, null and {uvs} with two floats per emitted vertex', () => {
    expect(runGeometry(mod(() => undefined), spec(), 1).uvs).toBeNull();
    expect(runGeometry(mod(() => null), spec(), 1).uvs).toBeNull();
    const rec = runGeometry(
      mod((ctx) => {
        ctx.tri(0, 0, 0, 1, 0, 0, 0, 1, 0);
        ctx.quad(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0);
        return { uvs: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1] };
      }),
      spec(),
      1,
    );
    expect(rec.uvs && Array.from(rec.uvs)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]);
    expect(rec.uvProjection).toBe('triplanar');
    expect(runGeometry(mod(() => ({ uvProjection: 'planar' })), spec(), 1).uvProjection).toBe('planar');
  });

  it('throws UnsupportedGeometryReturn in strict mode and ignores the return otherwise', () => {
    const bad = [
      (ctx: GeometryContext) => {
        ctx.tri(0, 0, 0, 1, 0, 0, 0, 1, 0);
        return { uvs: [0, 0] };
      },
      () => ({ normals: [0, 1, 0] }),
      () => ({ colors: [] }),
      () => ({ joints: [], weights: [] }),
      () => 42,
      () => Promise.resolve(),
      () => ({ uvProjection: 'cubic' }),
    ];
    for (const g of bad) {
      expect(() => runGeometry(mod(g), spec(), 1, { strict: true })).toThrow(UnsupportedGeometryReturn);
      const diag = createDiagnostics();
      const rec = runGeometry(mod(g), spec(), 1, { strict: false, diag });
      expect(rec.uvs).toBeNull();
      expect(diag.counts['invalidReturn']).toBe(1);
    }
  });

  it('propagates generator exceptions', () => {
    expect(() =>
      runGeometry(
        mod(() => {
          throw new Error('boom');
        }),
        spec(),
        1,
      ),
    ).toThrow('boom');
  });

  it('keeps malformed emit arguments countable instead of crashing', () => {
    const diag = createDiagnostics();
    const rec = runGeometry(
      mod((ctx) => {
        (ctx.tri as unknown as (...a: unknown[]) => void)([0, 0, 0], [1, 0, 0], [0, 1, 0]);
        ctx.tri(0, 0, 0, 1, 0);
      }),
      spec(),
      1,
      { diag },
    );
    expect(rec.tris).toBe(2);
    expect(Array.from(rec.positions.subarray(0, 9))).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Number.isNaN(rec.positions[17])).toBe(true);
    expect(diag.counts['emitArgs']).toBe(2);
  });
});

describe('collider()', () => {
  const soup = (ctx: GeometryContext): void => {
    ctx.quad(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0);
  };

  it('records an emitted soup, a box, a sphere, null and an empty run', () => {
    const tris = runCollider(mod(() => {}, soup), spec());
    expect(tris.kind).toBe('tris');
    if (tris.kind === 'tris') {
      expect(tris.source).toBe('collider');
      expect(tris.positions.length).toBe(18);
    }
    expect(runCollider(mod(() => {}, () => ({ kind: 'box', width: 0.3, height: 0.6, depth: 0.1 })), spec())).toEqual({ kind: 'box', size: [0.3, 0.6, 0.1] });
    expect(runCollider(mod(() => {}, () => ({ kind: 'sphere', radius: 0.4 })), spec())).toEqual({ kind: 'sphere', radius: 0.4 });
    expect(runCollider(mod(() => {}, () => null), spec())).toEqual({ kind: 'none' });
    expect(runCollider(mod(() => {}, () => undefined), spec())).toEqual({ kind: 'none' });
  });

  it('uses the LOD 1 visual triangles when the module has no collider export', () => {
    const lods: number[] = [];
    const rec = runCollider(
      mod((ctx) => {
        lods.push(ctx.lod);
        soup(ctx);
      }),
      spec(),
    );
    expect(lods).toEqual([1]);
    expect(rec.kind).toBe('tris');
    if (rec.kind === 'tris') expect(rec.source).toBe('visual');
  });

  it('rejects malformed shapes in strict mode', () => {
    for (const c of [() => ({ kind: 'box', width: 1 }), () => ({ kind: 'capsule', radius: 1 }), () => 'box', () => ({ kind: 'sphere', radius: Number.NaN })]) {
      expect(() => runCollider(mod(() => {}, c), spec(), { strict: true })).toThrow(InvalidColliderReturn);
      const diag = createDiagnostics();
      expect(runCollider(mod(() => {}, c), spec(), { strict: false, diag })).toEqual({ kind: 'none' });
      expect(diag.counts['invalidCollider']).toBe(1);
    }
  });
});
