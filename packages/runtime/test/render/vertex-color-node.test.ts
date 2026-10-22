// K10b: `ssColor` read by the packed stage's `vertexColors` option. A geometry without the attribute reads white and does not
// make three warn; one with it is read as the attribute.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vector4 } from 'three/webgpu';
import { PACKED_COLOR_ATTRIBUTE, VertexColorNode } from '../../src/render/surface/paint-table.ts';

function builder(has: boolean) {
  const consts: Array<{ type: string; value: unknown }> = [];
  const b = {
    shaderStage: 'vertex',
    geometry: { getAttribute: () => ({}) },
    getDataFromNode: () => ({}),
    hasGeometryAttribute: () => has,
    getTypeFromAttribute: () => 'vec4',
    getAttribute: (name: string) => ({ name }),
    format: (code: string) => `fmt(${code})`,
    generateConst: (type: string, value: unknown) => (consts.push({ type, value }), 'const'),
  };
  return { b, consts };
}

afterEach(() => vi.restoreAllMocks());

describe('VertexColorNode', () => {
  it('a geometry without ssColor reads white and does not warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { b, consts } = builder(false);
    const node = new VertexColorNode(PACKED_COLOR_ATTRIBUTE, 'vec4');
    expect(node.generate(b as never)).toBe('const');
    expect(consts).toHaveLength(1);
    expect(consts[0]!.type).toBe('vec4');
    expect((consts[0]!.value as Vector4).toArray()).toEqual([1, 1, 1, 1]);
    expect(warn).not.toHaveBeenCalled();
  });
  it('negative: a geometry with ssColor reads the attribute, no default constant', () => {
    const { b, consts } = builder(true);
    const node = new VertexColorNode(PACKED_COLOR_ATTRIBUTE, 'vec4');
    expect(node.generate(b as never)).toBe(`fmt(${PACKED_COLOR_ATTRIBUTE})`);
    expect(consts).toHaveLength(0);
  });
});
