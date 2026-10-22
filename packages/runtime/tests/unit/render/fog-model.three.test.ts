// K14: the fog type is chosen once per world (`atmosphere.fogModel`). Linear fog is three's `Fog` with near/far; the default is
// PP's `FogExp2`, which this file pins as the negative control. three keys a material's program on the fog node's cache key, so
// the key is read from three's own NodeManager (no renderer, no GPU).
import { Fog, FogExp2, MeshBasicNodeMaterial } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error three ships no declaration for its internal NodeManager
import NodeManager from '../../../../../node_modules/three/src/renderers/common/nodes/NodeManager.js';
import { createAtmosphere } from '../../../src/render/atmosphere/atmosphere.ts';
import { createSceneRoot } from '../../../src/render/scene/scene-root.ts';
import { finishScriptedMaterial, setScriptedMaterialFog } from '../../../src/render/surface/scripted-material.ts';
import { cssToLinear } from '../../../src/render/color/color.ts';

type FogScene = { fog: unknown };
type FogNodes = { getFogNode(s: unknown): { getCacheKey(): string; factor?: unknown } };
const nodesFor = (): FogNodes => new (NodeManager as unknown as new (r: unknown, b: unknown) => FogNodes)({ info: { calls: 1 } }, {});
/** the fog node's cache key as three folds it into a program key (node ids make two managers' keys differ: compare within one) */
const fogKey = (scene: FogScene, nodes: FogNodes = nodesFor()): string => String(nodes.getFogNode(scene).getCacheKey());

describe('K14 linear fog model', () => {
  it('control: the default root is PP\'s FogExp2 and has no linear fog', () => {
    const root = createSceneRoot();
    expect(root.fogModel).toBe('exp2');
    expect(root.linearFog).toBeNull();
    expect(root.scene.fog).toBeInstanceOf(FogExp2);
    expect(root.scene.fog).toBe(root.fog);
    expect(createSceneRoot({}).scene.fog).toBeInstanceOf(FogExp2);
  });

  it('the program key differs only when linear is chosen; the exp2 key never moves with the fog values (PP path unchanged)', () => {
    const nodes = nodesFor();
    const a = createSceneRoot({ fogModel: 'exp2' });
    const b = createSceneRoot({ fogModel: 'linear' });
    const exp2 = fogKey(a.scene, nodes);
    const linear = fogKey(b.scene, nodes);
    expect(linear).not.toBe(exp2);
    // control: the default root and an explicit exp2 root build the same kind of node, and mutating density keeps the key
    a.fog.density = 0.02;
    expect(fogKey(a.scene, nodes)).toBe(exp2);
    b.linearFog!.far = 99;
    expect(fogKey(b.scene, nodes)).toBe(linear);
    const def = createSceneRoot();
    expect(def.scene.fog).toBeInstanceOf(FogExp2);
    expect(String(nodes.getFogNode(def.scene).constructor.name)).toBe(String(nodes.getFogNode(a.scene).constructor.name));
  });

  it('a linear root fogs with a Fog that is never replaced; loads and writes only mutate it', () => {
    const root = createSceneRoot({ fogModel: 'linear' });
    const fog = root.linearFog!;
    expect(root.scene.fog).toBe(fog);
    expect(fog).toBeInstanceOf(Fog);
    const nodes = nodesFor();
    const key = fogKey(root.scene, nodes);
    const atm = createAtmosphere({ root });
    atm.load({ fog: { kind: 'linear', near: 60, far: 260, color: '#336699' }, ambient: { light: { intensity: 1 } } });
    const c = cssToLinear('#336699')!;
    expect([fog.near, fog.far]).toEqual([60, 260]);
    expect([fog.color.r, fog.color.g, fog.color.b].map((v, i) => Math.abs(v - c[i]!) < 1e-9)).toEqual([true, true, true]);
    expect(atm.state.fog).toMatchObject({ near: 60, far: 260, density: 0 });
    atm.onWrite('fog', { kind: 'linear', near: 140, far: 650 });
    atm.update({ now: 0, dt: 0.016 });
    expect([fog.near, fog.far]).toEqual([140, 650]);
    expect(root.scene.fog).toBe(fog);
    expect(fogKey(root.scene, nodes)).toBe(key);
  });

  it('three smoothstep ramp at near 60 far 260: nothing at depth 0, 0.104 at 100, full at 260 (the Pip row 25 percent is not smoothstep)', () => {
    const root = createSceneRoot({ fogModel: 'linear' });
    createAtmosphere({ root }).load({ fog: { kind: 'linear', near: 60, far: 260 } });
    const f = root.linearFog!;
    const smooth = (z: number): number => {
      const t = Math.min(1, Math.max(0, (z - f.near) / (f.far - f.near)));
      return t * t * (3 - 2 * t);
    };
    expect(smooth(0)).toBe(0);
    // three's rangeFogFactor is smoothstep(near, far, viewZ): 40/200 -> 0.104; the doc's "25 %" is the linear ramp
    expect(smooth(100)).toBeCloseTo(0.104, 3);
    expect(smooth(260)).toBe(1);
  });

  it('a world without a fog def fogs nothing, and a def without near/far too', () => {
    const root = createSceneRoot({ fogModel: 'linear' });
    const atm = createAtmosphere({ root });
    atm.load({});
    expect(root.linearFog!.near).toBeGreaterThan(1e6);
    atm.load({ fog: { kind: 'linear' } });
    expect(root.linearFog!.near).toBeGreaterThan(1e6);
  });

  it('exp2 in a linear world, and linear in an exp2 world, are refused with one warning and the fog stays', () => {
    const warn = vi.fn();
    const lin = createSceneRoot({ fogModel: 'linear' });
    const a = createAtmosphere({ root: lin, warn });
    a.load({ fog: { kind: 'linear', near: 10, far: 50 } });
    a.onWrite('fog', { kind: 'exp2', density: 0.01 });
    a.update({ now: 0, dt: 0.016 });
    expect(warn.mock.calls.filter((c) => /fog kind/.test(String(c[0])))).toHaveLength(1);
    expect([lin.linearFog!.near, lin.linearFog!.far]).toEqual([10, 50]);

    const warn2 = vi.fn();
    const exp = createSceneRoot();
    const b = createAtmosphere({ root: exp, warn: warn2 });
    b.load({ fog: { kind: 'exp2', density: 0.01 } });
    b.onWrite('fog', { kind: 'linear', near: 1, far: 2 });
    b.update({ now: 0, dt: 0.016 });
    expect(warn2.mock.calls.filter((c) => /fog kind/.test(String(c[0])))).toHaveLength(1);
    expect(exp.fog.density).toBe(0.01);
    expect(b.state.fog.near).toBeUndefined();
  });

  it('an additive material under fade reads near/far in a linear world and density in PP\'s', () => {
    const mat = (fog: Parameters<typeof setScriptedMaterialFog>[0]): MeshBasicNodeMaterial => {
      const m = new MeshBasicNodeMaterial();
      m.blending = 2; // AdditiveBlending
      setScriptedMaterialFog(fog);
      try {
        return finishScriptedMaterial(m, { additiveFog: 'fade' }) as MeshBasicNodeMaterial;
      } finally {
        setScriptedMaterialFog(null);
      }
    };
    const exp = mat(createSceneRoot().fog);
    const lin = mat(createSceneRoot({ fogModel: 'linear' }).linearFog);
    expect(exp.outputNode).toBeTruthy();
    expect(lin.outputNode).toBeTruthy();
    expect(lin.outputNode!.getCacheKey()).not.toBe(exp.outputNode!.getCacheKey());
  });
});
