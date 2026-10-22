// Clips embedded in a model GLB (docs/design/motion-physics-nav.md §3.3.4): the viewmodels' own `idle / fire / reload_tac / …`
// and the clips of legacy bodies. Extraction turns the animations of a loaded container into `CompiledClip{kind:'absolute',
// id:'<modelId>#<name>'}`, keeping STEP interpolation and scale tracks; `ModelClips` is the registry's `ModelClipSource`
// (undefined while a model's container is not loaded, so `ClipRegistry.resolve` answers 'pending', motion §3.5.6).
//
// three-free and Node-free: the input is plain animation data (`ModelAnimation`). The render domain converts what its loader
// produced; tools and tests read it from the GLB container with `parseGlb` + `animationsFromGltf`. Track bone names use the
// canonical aliasing of `rig.ts`, so they bind to the model's own RigDef by name.
import type { ModelClipSource } from './clip-registry.ts';
import { resolveModelClipName } from './clip-registry.ts';
import { type CompiledClip, type Track, type TrackProp, makeTrack } from './clip.ts';
import { canonicalBoneName } from './rig.ts';

// ── plain animation data ────────────────────────────────────────────────────────────────────────────────────────────────────

export type GltfInterpolation = 'LINEAR' | 'STEP' | 'CUBICSPLINE';
export type GltfTargetPath = 'translation' | 'rotation' | 'scale' | 'weights';

export interface ModelAnimChannel {
  /** the target node's name as loaded */
  readonly node: string;
  readonly path: GltfTargetPath;
  readonly interpolation: GltfInterpolation;
  /** key times in seconds */
  readonly times: ArrayLike<number>;
  /** 3 per key (translation, scale) or 4 per key (rotation x, y, z, w) */
  readonly values: ArrayLike<number>;
}

export interface ModelAnimation {
  readonly name: string;
  readonly channels: readonly ModelAnimChannel[];
}

const PROP_OF: Record<Exclude<GltfTargetPath, 'weights'>, TrackProp> = { translation: 'position', rotation: 'rotation', scale: 'scale' };

export const modelClipId = (modelId: string, name: string): string => `${modelId}#${name}`;

/**
 * One embedded animation as a CompiledClip. Tracks keep the channel order and the source keys (no resampling); morph-weight
 * channels are left out (no live model animates morph targets). CUBICSPLINE is refused: none exists in the live content and
 * sampling its in/out tangents as keys would be wrong.
 */
export function compileModelClip(modelId: string, anim: ModelAnimation): CompiledClip {
  const id = modelClipId(modelId, anim.name);
  const tracks: Track[] = [];
  let duration = 0;
  for (const ch of anim.channels) {
    if (ch.path === 'weights') continue;
    const prop = PROP_OF[ch.path];
    if (prop === undefined) throw new Error(`model clip ${id}: channel on ${ch.node} has an unknown path ${String(ch.path)}`);
    if (ch.interpolation === 'CUBICSPLINE') throw new Error(`model clip ${id}: ${ch.node}.${ch.path} uses CUBICSPLINE, which is not supported`);
    if (ch.interpolation !== 'LINEAR' && ch.interpolation !== 'STEP') throw new Error(`model clip ${id}: ${ch.node}.${ch.path} has an unknown interpolation ${String(ch.interpolation)}`);
    const bone = canonicalBoneName(ch.node);
    let track: Track;
    try {
      track = makeTrack(bone, prop, ch.interpolation === 'STEP' ? 'step' : 'linear', ch.times, ch.values);
    } catch (e) {
      throw new Error(`model clip ${id}: ${(e as Error).message}`);
    }
    if (prop === 'rotation') normaliseKeys(track.values);
    tracks.push(track);
    duration = Math.max(duration, track.times[track.times.length - 1]!);
  }
  return { id, kind: 'absolute', duration, units: 'm', tracks };
}

/** Unit length per key (glTF allows normalised-integer storage, which decodes to slightly non-unit quaternions). */
function normaliseKeys(values: Float32Array): void {
  for (let k = 0; k < values.length; k += 4) {
    const l = Math.hypot(values[k]!, values[k + 1]!, values[k + 2]!, values[k + 3]!);
    if (l < 1e-12) {
      values[k] = values[k + 1] = values[k + 2] = 0;
      values[k + 3] = 1;
    } else if (Math.abs(l - 1) > 1e-7) {
      for (let c = 0; c < 4; c++) values[k + c] = values[k + c]! / l;
    }
  }
}

/** Every embedded animation of a model, in file order. A repeated name keeps its first clip (the id must be unique). */
export function compileModelClips(modelId: string, anims: readonly ModelAnimation[]): CompiledClip[] {
  const seen = new Set<string>();
  const out: CompiledClip[] = [];
  for (const a of anims) {
    if (seen.has(a.name)) continue;
    seen.add(a.name);
    out.push(compileModelClip(modelId, a));
  }
  return out;
}

// ── glTF container reader ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The part of a glTF document the animation reader touches. */
export interface GltfAnimJson {
  nodes?: ReadonlyArray<{ name?: string; children?: readonly number[]; translation?: readonly number[]; rotation?: readonly number[]; scale?: readonly number[]; matrix?: readonly number[] }>;
  skins?: ReadonlyArray<{ joints: readonly number[] }>;
  animations?: ReadonlyArray<{
    name?: string;
    channels: ReadonlyArray<{ sampler: number; target: { node?: number; path: string } }>;
    samplers: ReadonlyArray<{ input: number; output: number; interpolation?: string }>;
  }>;
  accessors?: ReadonlyArray<{
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    normalized?: boolean;
    count: number;
    type: string;
    sparse?: unknown;
  }>;
  bufferViews?: ReadonlyArray<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; extensions?: Record<string, unknown> }>;
  buffers?: ReadonlyArray<{ byteLength: number; uri?: string }>;
  [key: string]: unknown;
}

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Splits a GLB container into its JSON document and its binary chunk (null when it has none). */
export function parseGlb(bytes: Uint8Array): { json: GltfAnimJson; bin: Uint8Array | null } {
  if (bytes.byteLength < 20) throw new Error('not a GLB: shorter than the header');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a GLB: bad magic');
  if (dv.getUint32(4, true) !== 2) throw new Error('not a GLB: version is not 2');
  const total = Math.min(dv.getUint32(8, true), bytes.byteLength);
  let json: GltfAnimJson | undefined;
  let bin: Uint8Array | null = null;
  for (let o = 12; o + 8 <= total; ) {
    const len = dv.getUint32(o, true);
    const type = dv.getUint32(o + 4, true);
    if (o + 8 + len > bytes.byteLength) throw new Error('not a GLB: truncated chunk');
    const data = bytes.subarray(o + 8, o + 8 + len);
    if (type === CHUNK_JSON && !json) json = JSON.parse(new TextDecoder().decode(data)) as GltfAnimJson;
    else if (type === CHUNK_BIN && !bin) bin = data;
    o += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('not a GLB: no JSON chunk');
  return { json, bin };
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/**
 * An accessor of the binary chunk as floats (FLOAT, or normalised BYTE / UNSIGNED_BYTE / SHORT / UNSIGNED_SHORT as glTF allows
 * for animation outputs). Sparse accessors, external buffers and compressed buffer views are refused.
 */
export function readAccessorFloats(json: GltfAnimJson, bin: Uint8Array | null, index: number): Float32Array {
  const a = json.accessors?.[index];
  if (!a) throw new Error(`gltf: no accessor ${index}`);
  if (a.sparse !== undefined) throw new Error(`gltf: accessor ${index} is sparse, which is not supported`);
  const comps = COMPONENTS[a.type];
  if (comps === undefined) throw new Error(`gltf: accessor ${index} has type ${a.type}`);
  const out = new Float32Array(a.count * comps);
  if (a.bufferView === undefined) return out;
  const bv = json.bufferViews?.[a.bufferView];
  if (!bv) throw new Error(`gltf: accessor ${index} names a missing buffer view`);
  if (bv.extensions && Object.keys(bv.extensions).length > 0) throw new Error(`gltf: buffer view ${a.bufferView} is compressed (${Object.keys(bv.extensions).join(', ')})`);
  if (bv.buffer !== 0 || !bin || json.buffers?.[0]?.uri !== undefined) throw new Error(`gltf: accessor ${index} is not in the GLB binary chunk`);
  const size = a.componentType === 5126 ? 4 : a.componentType === 5122 || a.componentType === 5123 ? 2 : a.componentType === 5120 || a.componentType === 5121 ? 1 : 0;
  if (size === 0) throw new Error(`gltf: accessor ${index} has component type ${a.componentType}`);
  if (size !== 4 && a.normalized !== true) throw new Error(`gltf: accessor ${index} stores integers that are not normalised`);
  const stride = bv.byteStride ?? comps * size;
  const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  if (a.count > 0 && start + (a.count - 1) * stride + comps * size > bin.byteLength) throw new Error(`gltf: accessor ${index} runs past the binary chunk`);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  for (let i = 0; i < a.count; i++) {
    for (let c = 0; c < comps; c++) {
      const o = start + i * stride + c * size;
      let v: number;
      switch (a.componentType) {
        case 5126:
          v = dv.getFloat32(o, true);
          break;
        case 5120:
          v = Math.max(dv.getInt8(o) / 127, -1);
          break;
        case 5121:
          v = dv.getUint8(o) / 255;
          break;
        case 5122:
          v = Math.max(dv.getInt16(o, true) / 32767, -1);
          break;
        default:
          v = dv.getUint16(o, true) / 65535;
      }
      out[i * comps + c] = v;
    }
  }
  return out;
}

/** The animations of a glTF document as plain data (channels without a target node are dropped, as glTF prescribes). */
export function animationsFromGltf(json: GltfAnimJson, bin: Uint8Array | null): ModelAnimation[] {
  const nodes = json.nodes ?? [];
  const cache = new Map<number, Float32Array>();
  const read = (i: number): Float32Array => {
    let v = cache.get(i);
    if (!v) cache.set(i, (v = readAccessorFloats(json, bin, i)));
    return v;
  };
  return (json.animations ?? []).map((a, ai): ModelAnimation => {
    const name = a.name ?? `animation${ai}`;
    const channels: ModelAnimChannel[] = [];
    for (const ch of a.channels) {
      const node = ch.target.node;
      if (node === undefined) continue;
      const s = a.samplers[ch.sampler];
      if (!s) throw new Error(`gltf: animation ${name} names a missing sampler ${ch.sampler}`);
      const interpolation = (s.interpolation ?? 'LINEAR') as GltfInterpolation;
      channels.push({ node: nodes[node]?.name ?? `node${node}`, path: ch.target.path as GltfTargetPath, interpolation, times: read(s.input), values: read(s.output) });
    }
    return { name, channels };
  });
}

// ── registry source ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The embedded clips of the loaded models: the registry's `ModelClipSource`. */
export class ModelClips implements ModelClipSource {
  private readonly byModel = new Map<string, readonly CompiledClip[]>();

  /** Registers a loaded model's clips (an empty list for a model without animations: loaded, nothing to play). */
  set(modelId: string, clips: readonly CompiledClip[]): readonly CompiledClip[] {
    this.byModel.set(modelId, clips);
    return clips;
  }

  /** Compiles and registers the animations a loaded container carries. */
  setAnimations(modelId: string, anims: readonly ModelAnimation[]): readonly CompiledClip[] {
    return this.set(modelId, compileModelClips(modelId, anims));
  }

  /** Compiles and registers the animations of a glTF document. */
  setFromGltf(modelId: string, json: GltfAnimJson, bin: Uint8Array | null): readonly CompiledClip[] {
    return this.setAnimations(modelId, animationsFromGltf(json, bin));
  }

  /** Forgets a model (its container was released): its clip names are pending again. */
  delete(modelId: string): void {
    this.byModel.delete(modelId);
  }

  clips(modelId: string): readonly CompiledClip[] | undefined {
    return this.byModel.get(modelId);
  }

  /** The model's clip names in file order; undefined while the model is not loaded. */
  names(modelId: string): string[] | undefined {
    return this.byModel.get(modelId)?.map((c) => c.id.slice(modelId.length + 1));
  }

  /** Fuzzy name resolution of §3.3.4 on a loaded model; undefined while it is not loaded or when it has no clips. */
  find(modelId: string, want: string): CompiledClip | undefined {
    const clips = this.byModel.get(modelId);
    const names = this.names(modelId);
    if (!clips || !names) return undefined;
    const name = resolveModelClipName(names, want);
    return name === null ? undefined : clips[names.indexOf(name)];
  }
}
