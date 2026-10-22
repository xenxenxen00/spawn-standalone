// Scripted materials on primitive rows (opt-in): the sky-dome shape of Pip Skybloom's `mat-skybloom-sky.js`
// (`ctx.param('alt')` into a MeshBasicNodeMaterial colour node) on a `plane` row, through the real render bridge.
import { MeshBasicNodeMaterial, Mesh } from 'three/webgpu';
import { float, vec3 } from 'three/tsl';
import { describe, expect, it } from 'vitest';
import { createScriptedPrimitiveExtension } from '../../../src/render/special/scripted-primitive.ts';
import { materialParamsOf } from '../../../src/render/surface/material-params.ts';
import { rig, TestRow } from './bridge-fakes.ts';

const sky = {
  material: (ctx: { param(n: string, d?: number): { mul(x: number): unknown } }) => {
    const m = new MeshBasicNodeMaterial();
    const alt = ctx.param('alt', 0);
    m.colorNode = vec3(float(0.2).add(alt as never), 0.1, 0.3);
    m.depthWrite = false;
    return m;
  },
};
const load = async (path: string): Promise<Record<string, unknown>> => {
  if (path === 'scripts/mat-sky.js') return sky;
  throw new Error(`unknown ${path}`);
};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const skyRow = (alt: number) => new TestRow('sky', { pos: [0, 0, -160], props: { primitive: { kind: 'plane', width: 520, height: 320 }, material: { kind: 'scripted', script: 'scripts/mat-sky.js', params: { alt } } } });
const meshOf = (r: ReturnType<typeof rig>): Mesh | undefined => r.bridge.node('sky')?.object?.children.find((c): c is Mesh => (c as Mesh).isMesh === true);

describe('scripted material on a primitive row (opt-in)', () => {
  it('on: draws the plane as its own mesh with the script material, no bucket instance; params move the uniform', async () => {
    const logs: string[] = [];
    const r = rig({ extensions: { scriptedMaterial: createScriptedPrimitiveExtension({ load, dev: true, log: (m) => logs.push(m) }) } });
    const row = skyRow(0);
    r.spawn(row);
    await tick();
    await tick();
    const mesh = meshOf(r)!;
    expect(mesh).toBeDefined();
    expect((mesh.material as MeshBasicNodeMaterial).colorNode).not.toBeNull();
    expect(Array.from(mesh.scale)).toEqual([520, 320, 1]);
    expect(r.instances()).toBe(0);
    const store = materialParamsOf(mesh.material as MeshBasicNodeMaterial)!;
    expect(store.names()).toEqual(['alt']);
    const uniformNode = (): number => {
      let v = Number.NaN;
      (mesh.material as MeshBasicNodeMaterial).colorNode!.traverse((x) => {
        const n = x as unknown as { isUniformNode?: boolean; value?: unknown };
        if (n.isUniformNode === true && typeof n.value === 'number') v = n.value;
      });
      return v;
    };
    expect(uniformNode()).toBe(0);
    row.set('material', { kind: 'scripted', script: 'scripts/mat-sky.js', params: { alt: 412 } });
    r.feed.change(row, 'material');
    r.frame(1);
    expect(meshOf(r)).toBe(mesh);
    expect(uniformNode()).toBe(412);
    expect(logs).toEqual([]);
    // back to a standard material: the mesh goes, the bucket draws
    row.set('material', { color: '#ff0000' });
    r.feed.change(row, 'material');
    r.frame(1);
    expect(meshOf(r)).toBeUndefined();
    expect(r.instances()).toBe(1);
  });

  it('removing the row disposes the mesh', async () => {
    const r = rig({ extensions: { scriptedMaterial: createScriptedPrimitiveExtension({ load, dev: true }) } });
    r.spawn(skyRow(0));
    await tick();
    await tick();
    const obj = r.bridge.node('sky')!.object!;
    expect(obj.children.length).toBe(1);
    r.feed.remove('sky');
    r.frame(1);
    expect(obj.children.length).toBe(0);
  });

  it('off (no extension, the default): PP behaviour, logged as not drawn and the bucket draws the plain primitive (negative control)', async () => {
    const r = rig();
    r.spawn(skyRow(0));
    await tick();
    expect(meshOf(r)).toBeUndefined();
    expect(r.instances()).toBe(1);
    expect(r.logs.some((l) => l.includes('not drawn'))).toBe(true);
  });
});
