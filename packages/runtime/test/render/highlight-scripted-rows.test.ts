// `highlightScriptedRows`: an `outline` mark on a scripted (map) row hulls the row's own meshes (`HighlightHost.rowMeshes`).
import { describe, expect, it } from 'vitest';
import { BackSide, BoxGeometry, Group, Matrix4, Mesh, MeshBasicMaterial } from 'three/webgpu';
import type { RowNodeView } from '../../src/render/bridge/bridge-types.ts';
import { HIGHLIGHT_KEY, HighlightRenderer } from '../../src/render/special/highlight.ts';
import { LookTable } from '../../src/render/surface/look-table.ts';

function map() {
  const group = new Group();
  const lods = [0, 1].map((i) => {
    const m = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    m.matrixAutoUpdate = false;
    m.matrix.copy(new Matrix4().makeTranslation(3, 1, -2).scale({ x: 0.01, y: 0.01, z: 0.01 } as never));
    m.visible = i === 0;
    group.add(m);
    return m;
  });
  return { group, lods };
}

function setup(rowMeshes: boolean) {
  const look = new LookTable();
  let meshes: Mesh[] | null = null;
  const calls: string[] = [];
  const view = (id: string): RowNodeView | undefined => ({ id, object: null, model: null, world: new Float32Array(16), visible: true });
  const hl = new HighlightRenderer({
    node: view, look, outline: true, log: () => undefined,
    ...(rowMeshes ? { rowMeshes: (id: string) => (calls.push(id), meshes) } : {}),
  });
  return { hl, calls, setMeshes: (m: Mesh[] | null) => (meshes = m) };
}

describe('outline on scripted rows', () => {
  it('waits while the row has no meshes of its own (a promotion is under way), then hulls every level mesh', () => {
    const s = setup(true);
    s.hl.set('crate', { color: '#ff8000', style: 'outline', width: 3 });
    s.hl.update();
    expect(s.calls).toEqual(['crate']);
    expect(s.hl.stats()).toMatchObject({ marks: 1, drawn: 0, overlays: 0 });
    const { group, lods } = map();
    s.setMeshes(lods);
    s.hl.update();
    expect(s.hl.stats()).toMatchObject({ marks: 1, drawn: 1, overlays: 2 });
    const overlays = s.hl.overlaysOf('crate');
    overlays.forEach((o, i) => {
      expect(o.parent).toBe(group);
      expect(o.geometry).toBe(lods[i]!.geometry);
      expect(o.matrix.equals(lods[i]!.matrix)).toBe(true);
      expect(o.visible).toBe(lods[i]!.visible);
      expect((o.material as { side: number }).side).toBe(BackSide);
      expect((o.material as { name: string }).name).toBe('ss:highlight:outline:row');
      expect((o.userData[HIGHLIGHT_KEY] as { width: number }).width).toBe(3);
    });
    // an LOD switch follows
    lods[0]!.visible = false;
    lods[1]!.visible = true;
    s.hl.update();
    expect(overlays.map((o) => o.visible)).toEqual([false, true]);
    s.hl.clear('crate');
    expect(group.children).toHaveLength(2);
    s.hl.dispose();
  });
  it('warms the row hull program too', () => {
    const s = setup(true);
    expect(s.hl.warmObjects().some((o) => (o as Mesh).material === s.hl.rowOutlineMaterial)).toBe(true);
    s.hl.dispose();
  });
  it('negative (PP): without rowMeshes a scripted row stays unoutlined and no row hull is built', () => {
    const s = setup(false);
    s.hl.set('crate', { color: '#ff8000', style: 'outline' });
    s.hl.update();
    expect(s.hl.stats()).toMatchObject({ marks: 1, drawn: 0 });
    expect(s.hl.rowOutlineMaterial).toBeNull();
    s.hl.dispose();
  });
});
