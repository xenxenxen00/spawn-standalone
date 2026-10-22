// K10c: ctx.param(name, default) on scripted materials: one uniform per name, live writes, no recompile.
import { MeshBasicNodeMaterial } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { smoothstep, vec3 } from 'three/tsl';
import { describe, expect, it } from 'vitest';
import { createMaterialParamStore, materialParamsOf, setScriptedMaterialParams } from '../../../src/render/surface/material-params.ts';
import { buildScriptedMaterial } from '../../../src/render/surface/scripted-material.ts';
import type { MaterialCtx } from '../../../src/render/surface/script-types.ts';

const spec = { kind: 'scripted' as const, script: 'scripts/mat-skybloom-sky.js', params: {} as Record<string, number> };
const skyModule = {
  material(ctx: MaterialCtx) {
    const m = new MeshBasicNodeMaterial();
    const alt = ctx.param('alt', 0) as Node<'float'>;
    m.colorNode = vec3(0.1, 0.2, 0.3).mul(smoothstep(110, 220, alt));
    m.fog = false;
    return m;
  },
};

describe('MaterialCtx.param', () => {
  it('returns the same uniform for a name, seeded from material.params else the default', () => {
    const s = createMaterialParamStore({ alt: 40 });
    const a = s.param('alt', 0);
    expect(s.param('alt', 5)).toBe(a);
    expect(a.value).toBe(40);
    expect(s.param('glow', 2).value).toBe(2);
    expect(s.param('tint', [1, 0.5, 0.25]).value).toMatchObject({ x: 1, y: 0.5, z: 0.25 });
    expect(s.names()).toEqual(['alt', 'glow', 'tint']);
  });

  it('writes live values into the uniform and keeps the node, material and graph', () => {
    const material = buildScriptedMaterial(skyModule, spec, { dev: true });
    const color = material.colorNode;
    const version = material.version;
    const store = materialParamsOf(material)!;
    const alt = store.param('alt');
    for (let f = 0; f <= 100; f++) expect(setScriptedMaterialParams(material, { alt: (900 * f) / 100 })).toBe(true);
    expect(alt.value).toBe(900);
    expect(material.colorNode).toBe(color);
    expect(material.version).toBe(version); // nothing that triggers a recompile
    expect(store.param('alt')).toBe(alt);
  });

  it('ignores unknown, non-finite and wrong-width writes, and a material that declared no params', () => {
    const material = buildScriptedMaterial(skyModule, spec, { dev: true });
    const alt = materialParamsOf(material)!.param('alt');
    setScriptedMaterialParams(material, { alt: Number.NaN, other: 3 });
    setScriptedMaterialParams(material, { alt: [1, 2] });
    expect(alt.value).toBe(0);
    const plain = buildScriptedMaterial({ material: () => new MeshBasicNodeMaterial() }, spec, { dev: true });
    expect(setScriptedMaterialParams(plain, { alt: 1 })).toBe(false);
  });

  it('rejects a bad name or default', () => {
    const s = createMaterialParamStore();
    expect(() => s.param('')).toThrow(TypeError);
    expect(() => s.param('x', 'nope' as never)).toThrow(TypeError);
  });
});
