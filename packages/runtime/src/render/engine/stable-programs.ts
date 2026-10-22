// Stable program text (docs/design/rendering.md §7.2, the warm-up; WP R6).
//
// three looks a GL program up by its shader text, so a program is shared exactly when two node builds write the same text.
// [M, r186 `GLSLNodeBuilder.getUniformFromNode`, tests/e2e M3 map smoke fingerprints] The WebGL2 builder names a uniform
// buffer block after the id of its node: `uniform NodeBuffer_<id> { mat4 buffer<id>[n]; }`. The bone matrices of a skinned
// mesh and the instance matrices of an InstancedMesh (when they fit a uniform block) are such buffers, and their nodes are
// made anew by every node build. So every build of a skinned or an instanced object wrote a vertex shader no other build
// wrote, and linked a program of its own. Builds are per render-object cache key: for a skinned mesh per material instance,
// render context and environment, for an instanced mesh per object (three puts `object.uuid` in the key). No warm-up proxy
// could stand for them: a primitive bucket made at PREP, a bucket that grew, the viewmodel drawn in the frame's scene pass
// after the warm-up drew its proxy in `compileAsync`'s context, a body with a texture binding no proxy had, each linked a
// program at its first draw, after the LOADING gate had released.
//
// `installStablePrograms` hooks three's `renderer.debug.onNodeBuilderCreated` (run for every node builder, before it builds)
// and makes the text a function of the structure only:
//
//   instanced  `getUniformBufferLimit()` is 0 for an InstancedMesh's builder: three then reads the instance matrix as four
//              instanced vertex attributes (its own path for counts above the block limit), so the text names no node and
//              no capacity. A bucket of 16 and one of 64 instances, and the warm-up's proxy of one, are one program.
//   buffers    a buffer node made during this build (an id above the builder's own first node, `builder.stack`) is named by
//              its order in the build: `NodeBuffer_pp<k>` / `ss_buffer<k>`. The WebGL backend binds a block by name
//              (`getUniformBlockIndex`), and the binding object takes the same name, so a second build with the same
//              structure binds into the program the first one linked. A buffer node older than the build (a material's own
//              `uniformArray`) keeps three's id name: it is the same node in every build of that material, its text is
//              already stable, and renaming a node another build may be generating (`compileAsync` builds yield) would race.
//   labels     except a buffer node its maker labelled (`labelStableBuffer(node, label)`): it is named `NodeBuffer_ppl_<label>` /
//              `ppl_<label>` in every build. The id name is stable only while the node lives; a node made again with the
//              same structure (the bloom composite's tint `uniformArray`, made anew by every post-graph rebuild: a tier
//              switch, a place's look) got a new id and so a new program text and a new program after the LOADING
//              release (R14b). The label is a function of the node alone, so concurrent builds write the same name. A label
//              must be unique among the buffers of one program.
//
// Nothing else of three's naming carries a node id (uniforms, varyings and textures are numbered per build). The text of a
// skinned mesh still holds its bone-count class and that of every object its material's structure, its geometry's attribute
// set and its render context's outputs: what the warm-up enumerates (src/render/models/shader-variants.ts).
import type { WebGPURenderer } from 'three/webgpu';

interface UniformLike {
  name: string;
}

interface BufferNodeLike {
  id: number;
  name: string;
}

/** what the hook touches of three's `NodeBuilder` (r186) */
export interface StableBuilder {
  object?: { isInstancedMesh?: boolean } | null;
  /** the builder constructor's `StackNode`: the last node made before this build */
  stack?: { id?: unknown } | null;
  globalCache?: unknown;
  getUniformBufferLimit(): number;
  getUniformFromNode(node: BufferNodeLike, type: string, shaderStage: string, name?: string | null): UniformLike;
  getDataFromNode(node: unknown, shaderStage?: string, cache?: unknown): { uniformGPU?: UniformLike };
}

interface DebugHooks {
  onNodeBuilderCreated: ((builder: unknown, owner: unknown) => void) | null;
}

/** marks a builder already made stable (a hook installed twice must not wrap twice) */
const STABLE = Symbol.for('ss.stablePrograms');
/** a buffer node's stable label (`labelStableBuffer`) */
const LABEL = Symbol.for('ss.stableBufferLabel');

const LABEL_RE = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * Gives a buffer node (a `uniformArray`, a `buffer`) made outside the builds that use it a name that survives its being made
 * again: `NodeBuffer_ppl_<label>`. `label` is an identifier of letters and digits. Returns the node.
 */
export function labelStableBuffer<T extends object>(node: T, label: string): T {
  if (!LABEL_RE.test(label)) throw new RangeError(`labelStableBuffer: the label must be letters and digits, got ${JSON.stringify(label)}`);
  (node as { [LABEL]?: string })[LABEL] = label;
  return node;
}

/**
 * Makes one node builder's text depend on structure only (see the header). `names`: rename the build's own buffer blocks,
 * for the WebGL2 backend, which binds them by name.
 */
export function stabilizeNodeBuilder(builder: StableBuilder, names: boolean): void {
  const b = builder as StableBuilder & { [STABLE]?: true };
  if (b[STABLE] === true) return;
  b[STABLE] = true;
  if (builder.object?.isInstancedMesh === true) builder.getUniformBufferLimit = () => 0;
  if (!names) return;
  const first = builder.stack?.id;
  if (typeof first !== 'number') return;
  const order = new Map<BufferNodeLike, number>();
  const getUniformFromNode = builder.getUniformFromNode;
  builder.getUniformFromNode = function (this: StableBuilder, node: BufferNodeLike, type: string, shaderStage: string, name: string | null = null): UniformLike {
    const uniform = getUniformFromNode.call(this, node, type, shaderStage, name);
    const label = type === 'buffer' ? (node as { [LABEL]?: string })[LABEL] : undefined;
    if (label !== undefined) {
      uniform.name = `ppl_${label}`;
      node.name = `NodeBuffer_ppl_${label}`;
      const binding = this.getDataFromNode(node, shaderStage, this.globalCache).uniformGPU;
      if (binding !== undefined) binding.name = node.name;
    } else if (type === 'buffer' && typeof node.id === 'number' && node.id > first) {
      let k = order.get(node);
      if (k === undefined) {
        k = order.size;
        order.set(node, k);
      }
      uniform.name = `ss_buffer${k}`;
      node.name = `NodeBuffer_pp${k}`;
      const binding = this.getDataFromNode(node, shaderStage, this.globalCache).uniformGPU;
      if (binding !== undefined) binding.name = node.name;
    }
    return uniform;
  };
}

/** Installs the stable-text hook on a renderer (after `init()`: the backend is known then). Returns its removal. */
export function installStablePrograms(renderer: WebGPURenderer): () => void {
  const r = renderer as unknown as { debug?: DebugHooks; backend?: { isWebGLBackend?: boolean } };
  const debug = r.debug;
  if (debug === undefined || debug === null) return () => undefined;
  const names = r.backend?.isWebGLBackend === true;
  const previous = debug.onNodeBuilderCreated;
  const hook = (builder: unknown, owner: unknown): void => {
    previous?.(builder, owner);
    // render objects only: a compute node's builder has no instanced object and no bound blocks to rename
    if ((owner as { isRenderObject?: boolean } | null)?.isRenderObject === true) stabilizeNodeBuilder(builder as StableBuilder, names);
  };
  debug.onNodeBuilderCreated = hook;
  return () => {
    if (debug.onNodeBuilderCreated === hook) debug.onNodeBuilderCreated = previous;
  };
}
