// src/render/engine/stable-programs.ts on three r186's real GLSL node builder (`GLSLNodeBuilder.getUniformFromNode` and
// `getUniforms`, no renderer, no GPU). A program is looked up by its text: two builds of the same structure must declare
// the same blocks, and the binding object must carry the name the block has in the text (the WebGL backend binds by name).
import { Color } from 'three';
import { buffer, uniformArray } from 'three/tsl';
import { BufferGeometry, GLSLNodeBuilder, InstancedMesh, Mesh, MeshBasicNodeMaterial, SkinnedMesh } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { installStablePrograms, labelStableBuffer, stabilizeNodeBuilder, type StableBuilder } from '../../../src/render/engine/stable-programs.ts';

const LIMIT = 65_536;
const renderer = { debug: { diagnostics: { keywords: false } }, backend: { capabilities: { getUniformBufferLimit: () => LIMIT } } };

/** the members of r186's `GLSLNodeBuilder` these tests call (three's typings declare only part of the class) */
interface Builder {
  getUniformFromNode(node: unknown, type: string, shaderStage: string, name?: string | null): { name: string };
  getDataFromNode(node: unknown, shaderStage?: string, cache?: unknown): unknown;
  getUniforms(shaderStage: string): string;
  getUniformBufferLimit(): number;
}
const builderFor = (object: unknown): Builder => new GLSLNodeBuilder(object as never, renderer as never) as unknown as Builder;
const asStable = (b: Builder): StableBuilder => b as unknown as StableBuilder;

/** what one build of a skinned body declares in its vertex stage: its own bone-matrix buffer, made during the build */
function boneBlocks(stable: boolean): { text: string; binding: string | undefined } {
  const b = builderFor(new SkinnedMesh(new BufferGeometry(), new MeshBasicNodeMaterial()));
  if (stable) stabilizeNodeBuilder(asStable(b), true);
  const bones = buffer(new Float32Array(64 * 16), 'mat4', 64);
  b.getUniformFromNode(bones as never, 'buffer', 'vertex');
  const data = b.getDataFromNode(bones as never, 'vertex', (b as unknown as { globalCache: unknown }).globalCache as never) as { uniformGPU?: { name: string } };
  return { text: b.getUniforms('vertex'), binding: data.uniformGPU?.name };
}

describe('stable program text (stable-programs.ts)', () => {
  it('control: three alone names a build-made buffer block after its node id, so two equal builds differ', () => {
    const a = boneBlocks(false);
    const b = boneBlocks(false);
    expect(a.text).toMatch(/NodeBuffer_\d+/);
    expect(a.text).not.toBe(b.text);
  });

  it('two builds of the same structure declare the same block, and the binding takes the block name', () => {
    const a = boneBlocks(true);
    const b = boneBlocks(true);
    expect(a.text).toBe(b.text);
    expect(a.text).toContain('uniform NodeBuffer_pp0 {');
    expect(a.text).toContain('mat4 ss_buffer0[64];');
    expect(a.text).not.toMatch(/NodeBuffer_\d/);
    expect(a.binding).toBe('NodeBuffer_pp0');
  });

  it('numbers the build-made buffers in their order, one name per node across the stages', () => {
    const b = builderFor(new SkinnedMesh(new BufferGeometry(), new MeshBasicNodeMaterial()));
    stabilizeNodeBuilder(asStable(b), true);
    const first = buffer(new Float32Array(16 * 16), 'mat4', 16);
    const second = buffer(new Float32Array(8 * 4), 'vec4', 8);
    const u1 = b.getUniformFromNode(first as never, 'buffer', 'vertex');
    const u2 = b.getUniformFromNode(second as never, 'buffer', 'vertex');
    const u1f = b.getUniformFromNode(first as never, 'buffer', 'fragment');
    expect([u1.name, u2.name, u1f.name]).toEqual(['ss_buffer0', 'ss_buffer1', 'ss_buffer0']);
    expect(b.getUniforms('fragment')).toContain('uniform NodeBuffer_pp0 {');
  });

  it('keeps three’s id name for a buffer node older than the build (a material’s own array: already stable, maybe shared)', () => {
    const shared = buffer(new Float32Array(4 * 4), 'vec4', 4);
    const b = builderFor(new Mesh(new BufferGeometry(), new MeshBasicNodeMaterial()));
    stabilizeNodeBuilder(asStable(b), true);
    b.getUniformFromNode(shared as never, 'buffer', 'vertex');
    expect(b.getUniforms('vertex')).toContain(`uniform NodeBuffer_${shared.id} {`);
  });

  it('a labelled buffer older than the build (the bloom tint array, R14b) keeps one name when it is made again', () => {
    /** one build of the composite: its tint array made before the build, as the bloom's setup() makes it */
    const composite = (): { text: string; binding: string | undefined; id: number } => {
      const tint = labelStableBuffer(uniformArray([new Color(1, 1, 1), new Color(1, 1, 1)]), 'bloomTint');
      const b = builderFor(new Mesh(new BufferGeometry(), new MeshBasicNodeMaterial()));
      stabilizeNodeBuilder(asStable(b), true);
      b.getUniformFromNode(tint as never, 'buffer', 'fragment');
      const data = b.getDataFromNode(tint as never, 'fragment', (b as unknown as { globalCache: unknown }).globalCache as never) as { uniformGPU?: { name: string } };
      return { text: b.getUniforms('fragment'), binding: data.uniformGPU?.name, id: (tint as unknown as { id: number }).id };
    };
    const first = composite();
    const rebuilt = composite();
    expect(rebuilt.id).not.toBe(first.id); // a new node
    expect(rebuilt.text).toBe(first.text); // the same text: the same program
    expect(first.text).toContain('uniform NodeBuffer_ppl_bloomTint {');
    expect(first.text).toContain('ppl_bloomTint[');
    expect(first.text).not.toMatch(/NodeBuffer_\d/);
    expect(first.binding).toBe('NodeBuffer_ppl_bloomTint');
  });

  it('control: without the label a buffer made again before each build changes the text', () => {
    const once = (): string => {
      const tint = uniformArray([new Color(1, 1, 1), new Color(1, 1, 1)]);
      const b = builderFor(new Mesh(new BufferGeometry(), new MeshBasicNodeMaterial()));
      stabilizeNodeBuilder(asStable(b), true);
      b.getUniformFromNode(tint as never, 'buffer', 'fragment');
      return b.getUniforms('fragment');
    };
    expect(once()).not.toBe(once());
  });

  it('labelStableBuffer takes identifiers only', () => {
    expect(() => labelStableBuffer({}, 'bloom tint')).toThrow(RangeError);
    expect(() => labelStableBuffer({}, '')).toThrow(RangeError);
  });

  it('puts an InstancedMesh on the instanced-attribute path (no block, no capacity in the text); other objects keep the limit', () => {
    const inst = builderFor(new InstancedMesh(new BufferGeometry(), new MeshBasicNodeMaterial(), 16));
    const mesh = builderFor(new Mesh(new BufferGeometry(), new MeshBasicNodeMaterial()));
    stabilizeNodeBuilder(asStable(inst), true);
    stabilizeNodeBuilder(asStable(mesh), true);
    expect(inst.getUniformBufferLimit()).toBe(0);
    expect(mesh.getUniformBufferLimit()).toBe(LIMIT);
  });

  it('does not rename on a backend that binds by index (WebGPU), and never wraps a builder twice', () => {
    const b = builderFor(new SkinnedMesh(new BufferGeometry(), new MeshBasicNodeMaterial()));
    stabilizeNodeBuilder(asStable(b), false);
    const own = buffer(new Float32Array(16), 'mat4', 1);
    b.getUniformFromNode(own as never, 'buffer', 'vertex');
    expect(b.getUniforms('vertex')).toContain(`NodeBuffer_${own.id}`);
    const c = builderFor(new SkinnedMesh(new BufferGeometry(), new MeshBasicNodeMaterial()));
    stabilizeNodeBuilder(asStable(c), true);
    const wrapped = c.getUniformFromNode;
    stabilizeNodeBuilder(asStable(c), true);
    expect(c.getUniformFromNode).toBe(wrapped);
  });

  it('installs on renderer.debug.onNodeBuilderCreated: chains the previous hook, render objects only, removable', () => {
    const seen: unknown[] = [];
    const previous = (builder: unknown): void => void seen.push(builder);
    const r = { debug: { onNodeBuilderCreated: previous as ((b: unknown, o: unknown) => void) | null }, backend: { isWebGLBackend: true } };
    const off = installStablePrograms(r as never);
    const hook = r.debug.onNodeBuilderCreated!;
    const forRender = builderFor(new InstancedMesh(new BufferGeometry(), new MeshBasicNodeMaterial(), 4));
    const forCompute = builderFor(new InstancedMesh(new BufferGeometry(), new MeshBasicNodeMaterial(), 4));
    hook(forRender, { isRenderObject: true });
    hook(forCompute, { isComputeNode: true });
    expect(seen).toEqual([forRender, forCompute]);
    expect(forRender.getUniformBufferLimit()).toBe(0);
    expect(forCompute.getUniformBufferLimit()).toBe(LIMIT);
    off();
    expect(r.debug.onNodeBuilderCreated).toBe(previous);
  });
});
