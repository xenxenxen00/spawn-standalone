// WP R5b: `look-runner.ts` (render §10.4): `runLook` calls a look's `look(ctx)` once with `ctx.scene` (a TSL vec4 node) and a
// uniform-backed `ctx.param`; the param store hands out one `uniform()` per look param, set to `placeParams[name] ?? def`.
import { vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { ENGINE_BLOOM_DEFAULTS } from '../../../src/render/post/look-recorder.ts';
import { ENGINE_BLOOM, LookRunError, createLookParamStore, runLook, type TslLookCtx } from '../../../src/render/post/look-runner.ts';

const scene = (): Node => vec4(0.5, 0.25, 0.125, 1) as unknown as Node;

describe('runLook', () => {
  it('calls look(ctx) once with the scene node and the param function, and returns its node', () => {
    const input = scene();
    const store = createLookParamStore({});
    const seen: TslLookCtx[] = [];
    const out = runLook(
      {
        look(ctx) {
          seen.push(ctx);
          return (ctx.scene as Node<'vec4'>).mul(2);
        },
      },
      input,
      store.param,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.scene).toBe(input);
    expect(seen[0]!.param).toBe(store.param);
    expect(Object.keys(seen[0]!).sort()).toEqual(['param', 'scene']);
    expect((out as unknown as { isNode: boolean }).isNode).toBe(true);
    expect(out).not.toBe(input);
  });

  it('a look may return the scene untouched', () => {
    const input = scene();
    expect(runLook({ look: (ctx) => ctx.scene }, input, createLookParamStore({}).param)).toBe(input);
  });

  it('fails loudly on a module without look(), a non-node scene and a look that returns no node', () => {
    const p = createLookParamStore({}).param;
    expect(() => runLook({} as never, scene(), p)).toThrow(LookRunError);
    expect(() => runLook({} as never, scene(), p)).toThrow(/no look\(ctx\) export/);
    expect(() => runLook({ look: (ctx) => ctx.scene }, {} as never, p)).toThrow(/scene colour must be a TSL node/);
    expect(() => runLook({ look: () => 5 }, scene(), p)).toThrow(/must return a TSL node/);
    expect(() => runLook({ look: () => undefined }, scene(), p)).toThrow(/must return a TSL node/);
  });
});

describe('the look param store (render §10.4)', () => {
  it('param(name, def) returns that param’s uniform, created on first use, set to placeParams[name] ?? def', () => {
    const store = createLookParamStore({ exposure: 1.08, unused: 7 });
    const e = store.param('exposure', 1.25);
    const g = store.param('gamma', 1.22);
    expect(e.isUniformNode).toBe(true);
    expect(e.value).toBe(1.08);
    expect(g.value).toBe(1.22);
    expect(typeof (e as unknown as { mul: unknown }).mul).toBe('function'); // "use node operations such as .mul() on ctx.param values"
    expect(store.param('exposure', 9)).toBe(e); // the same uniform on a repeat call
    expect(e.value).toBe(1.08);
    expect(store.param('gamma', 1.5)).toBe(g);
    expect(g.value).toBe(1.5); // the latest default stands when the place sets nothing
    expect(store.get('exposure')).toBe(e);
    expect(store.get('nope')).toBeUndefined();
    expect(store.names().sort()).toEqual(['exposure', 'gamma']);
    expect(store.values()).toEqual({ exposure: 1.08, gamma: 1.5 });
  });

  it('vector params become vector uniforms', () => {
    const store = createLookParamStore({ c: [0.1, 0.2, 0.3] });
    const c = store.param('c', [1, 1, 1]);
    expect((c.value as { toArray(): number[] }).toArray()).toEqual([0.1, 0.2, 0.3]);
    const d = store.param('d', [1, 2]);
    expect((d.value as { toArray(): number[] }).toArray()).toEqual([1, 2]);
    expect(store.values()).toEqual({ c: [0.1, 0.2, 0.3], d: [1, 2] });
  });

  it('the bloom uniforms exist before the look runs, with the engine defaults; the look’s own param call sets them', () => {
    expect(ENGINE_BLOOM).toEqual({ ...ENGINE_BLOOM_DEFAULTS });
    const store = createLookParamStore({ bloomThreshold: 1.1 });
    const b = store.bloom();
    expect([b.strength.value, b.radius.value, b.threshold.value]).toEqual([0.15, 0.6, 1.1]); // a place value wins even unread
    expect(store.bloom().strength).toBe(b.strength);
    expect(store.param('bloomStrength', 0.55)).toBe(b.strength); // kf2-mix.js:9 discards the result and still drives the bloom
    expect(b.strength.value).toBe(0.55);
    expect(store.param('bloomThreshold', 0.85)).toBe(b.threshold);
    expect(b.threshold.value).toBe(1.1);
  });

  it('setPlaceParams is a uniform write: the same nodes, place value or the remembered default', () => {
    const store = createLookParamStore({ exposure: 1.08 });
    const e = store.param('exposure', 1.25);
    const g = store.param('gamma', 1.22);
    const v = store.param('v', [1, 2, 3]);
    const vec = v.value;
    store.setPlaceParams({ gamma: 1.16, v: [4, 5, 6] });
    expect(store.get('exposure')).toBe(e);
    expect(e.value).toBe(1.25); // the place no longer sets it: the script default
    expect(g.value).toBe(1.16);
    expect(v.value).toBe(vec); // written in place
    expect((v.value as { toArray(): number[] }).toArray()).toEqual([4, 5, 6]);
    expect(store.param('exposure', 1.25).value).toBe(1.25);
  });

  it('rejects a param that cannot be a uniform, naming it', () => {
    const store = createLookParamStore({ s: 'text', b: true, bad: [1], nan: Number.NaN });
    expect(() => store.param('s', 1)).toThrow(/look param 's'/);
    expect(() => store.param('b', 1)).toThrow(/look param 'b'/);
    expect(() => store.param('bad', [1, 2, 3])).toThrow(/look param 'bad'/);
    expect(() => store.param('nan', 1)).toThrow(/look param 'nan'/);
    expect(() => store.param('none')).toThrow(/look param 'none' has no value/);
    const typed = createLookParamStore({ x: [1, 2, 3] });
    typed.param('y', 1);
    expect(() => typed.setPlaceParams({ y: [1, 2] })).toThrow(/look param 'y'/); // a float uniform cannot become a vector
  });
});
