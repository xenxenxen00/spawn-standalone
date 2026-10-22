// The fx Worker's protocol (DR-53/DR-54; .cache/claude-fxworker/DESIGN.md §5): the commands and per-frame inputs the main
// thread sends, the finished bucket arrays the worker sends back, their layouts, and the pool the transferred buffers rotate
// through. Three-free: the worker's module closure (fx-worker.ts) is limited to fx/{world,sim,dsl}/**, this file, color.ts and
// calibration.ts (tools/check/source-rules.ts `fx-worker-pure`).
//
// main → worker   { t: 'init', v, init }                                             once
//                 { t: 'frame', seq, frame, programs, returned }                     at most one in flight; `returned` (the
//                                                                                    buffers of a presented result) is in the
//                                                                                    transfer list
//                 { t: 'dispose' }
// worker → main   { t: 'ready', v }
//                 { t: 'frame', seq, out, ms }                                       every bucket buffer of `out` transferred
//                 { t: 'fatal', message }                                            the main thread falls back to the
//                                                                                    in-process runtime
// There is no SharedArrayBuffer (the platform iframe is not cross-origin isolated, build §3.4): each bucket's result is one
// Float32Array carried in the transfer list; the main thread copies it into three's own arrays (never transferred: they back
// the device-loss rebuild) and hands the buffer back with its next post.
import type { FxTier, Vec3 } from './dsl/compile.ts';

export const FX_PROTOCOL_VERSION = 1;

export type FxSpace = 'world' | 'camera';
export type FxSpriteBlend = 'alpha' | 'add' | 'distort';
/** what an effect's origin follows: 0 nothing (the manual origin), 1 its row's node, 2 the camera (`follow=camera`) */
export type FxTarget = 0 | 1 | 2;

/** floats per particle of a sprite bucket's buffer: [positions 3n | scales 2n | rotations n | rgba 4n | cells n] */
export const SPRITE_FLOATS = 11;
/** floats per particle of a stretched-quad bucket's buffer: [matrices 16n | rgba 4n | cells n] */
export const STRETCHED_FLOATS = 21;
/** floats per instance of a mesh-sink bucket's buffer: [matrices 16n | albedo 4n | emissive 4n | extra 4n] */
export const MESH_FLOATS = 28;

/** an effect to start, with every value captured where the in-process runtime reads it (DESIGN §3) */
export interface FxSpawnCmd {
  readonly k: 's';
  /** the main thread's handle of the effect (the `FxEffectId` it returned) */
  readonly ticket: number;
  /** the bound row (`bind`), null for an act-emitted effect */
  readonly owner: string | null;
  /** the spec's script when it named a path (for the logs); absent when the script is the program text itself */
  readonly path?: string;
  /** the interned program text (`programs` of the frame message that first used it) */
  readonly ref: number;
  readonly params: Readonly<Record<string, unknown>>;
  readonly seed?: number;
  /** the world position of the target at the spawn, or the manual origin */
  readonly origin: Vec3;
  readonly manual: Vec3;
  readonly target: FxTarget;
  readonly tier: FxTier;
  /** the tier's fx held factor × the governor's held scale, at the spawn */
  readonly heldFactor: number;
  /** `budget.cap('particles', FX_MAX_PARTICLES)` at the spawn */
  readonly cap: number;
  /** a floor height for the whole effect (render §13.3, one down-ray at the spawn); never sent while `floor=` is inert (DR-54 3) */
  readonly floorY?: number;
}

export interface FxEndCmd {
  readonly k: 'e';
  readonly ticket: number;
}

export type FxCommand = FxSpawnCmd | FxEndCmd;

/** one fx stage's input */
export interface FxFrameIn {
  readonly dt: number;
  /** presentation time, ms */
  readonly now: number;
  /** `budget.cap('particles', FX_MAX_PARTICLES)` */
  readonly cap: number;
  /** `budget.cap('fxLights', ∞)` */
  readonly lightsCap: number;
  /** a light table is there (the light sinks are evaluated only then) */
  readonly lightsOn: boolean;
  /** `calibration.fxMeshRoughness` (the dev panel can change it) */
  readonly roughness: number;
  /** the camera's `matrixWorld` after `updateWorldMatrix(true, false)`; null without a camera */
  readonly camera: Float64Array | null;
  /** the origin of every live effect with a target this frame: tickets, and their world positions (xyz each) */
  readonly originTickets: Int32Array;
  readonly originXyz: Float64Array;
  /** in call order */
  readonly cmds: readonly FxCommand[];
}

/** what the world needs once (as the in-process runtime reads it at construction) */
export interface FxWorldInit {
  /** `max(1, budget.cap('particles'))`: the per-bucket particle capacity */
  readonly capacity: number;
  /** the tier draws the distort pass (`tierConfig(tier).distort`) */
  readonly distortEnabled: boolean;
  readonly hasCamera: boolean;
  readonly maxEffects: number;
  readonly strict: boolean;
  readonly gravity?: Vec3;
  readonly wind?: Vec3;
  readonly heldFollow?: boolean;
  readonly rangeRolls?: boolean;
  readonly alignedCards?: boolean;
  readonly lightsOnly?: boolean;
}

export interface FxSpriteOut {
  readonly key: string;
  readonly space: FxSpace;
  readonly blend: FxSpriteBlend;
  readonly count: number;
  /** SPRITE_FLOATS × count (STRETCHED_FLOATS for a stretched bucket); null when count is 0 */
  readonly buf: Float32Array | null;
}

export interface FxMeshOut {
  readonly space: FxSpace;
  /** an effect of this space was live this frame */
  readonly touched: boolean;
  readonly count: number;
  /** MESH_FLOATS × count; null when count is 0 */
  readonly buf: Float32Array | null;
}

/** the selected light sinks of the frame, in effect → population → particle order */
export interface FxLightsOut {
  /** per light: ticket, population index, particle index, held (1) or not (0) */
  readonly ints: Int32Array;
  /** per light: r, g, b, intensity, radius, x, y, z */
  readonly values: Float64Array;
  /** per light: the flash key a new handle is added with */
  readonly flashKeys: readonly string[];
}

export interface FxFrameStats {
  readonly effects: number;
  readonly particles: number;
  readonly meshParticles: number;
  readonly sprites: number;
  readonly stretched: number;
  readonly lights: number;
  /** the world's step and fills, ms */
  readonly stepMs: number;
}

export interface FxFrameOut {
  readonly sprites: readonly FxSpriteOut[];
  readonly stretched: readonly FxSpriteOut[];
  readonly meshes: readonly FxMeshOut[];
  readonly lights: FxLightsOut | null;
  /** tickets, in removal order: ends and evictions as the commands ran, then the effects that finished in the step */
  readonly removed: readonly number[];
  /** tickets whose spawn did not start (a compile error, the effect limit) */
  readonly refused: readonly number[];
  /** `[fx] …` lines for the main thread's log */
  readonly logs: readonly string[];
  readonly stats: FxFrameStats;
}

export type ToFxWorker =
  | { readonly t: 'init'; readonly v: number; readonly init: FxWorldInit }
  | { readonly t: 'frame'; readonly seq: number; readonly frame: FxFrameIn; readonly programs: ReadonlyArray<readonly [number, string]>; readonly returned: ReadonlyArray<readonly [string, ArrayBuffer]> }
  | { readonly t: 'dispose' };

export type FromFxWorker =
  | { readonly t: 'ready'; readonly v: number }
  | { readonly t: 'frame'; readonly seq: number; readonly out: FxFrameOut; readonly ms: number }
  | { readonly t: 'fatal'; readonly message: string };

/** A worker global scope, or a Node `worker_threads` port adapted to one (the tests' worker host). */
export interface WorkerScopeLike {
  postMessage(msg: unknown, transfer: ArrayBuffer[]): void;
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void;
}

/** the pool key of a bucket's buffers */
export const spritePoolKey = (key: string): string => `s:${key}`;
export const stretchedPoolKey = (key: string): string => `t:${key}`;
export const meshPoolKey = (space: FxSpace): string => `m:${space}`;

/**
 * The world's output buffers, one free list per bucket. A buffer handed back is reused when it is large enough; a new one is
 * 1.5× the request (at least 64 floats). A detached buffer (byteLength 0, transferred away) is never kept.
 */
export class FxBufferPool {
  readonly #free = new Map<string, ArrayBuffer[]>();

  take(key: string, floats: number): Float32Array {
    const list = this.#free.get(key);
    let buf: ArrayBuffer | undefined;
    while (list !== undefined && list.length > 0) {
      const b = list.pop()!;
      if (b.byteLength >= floats * 4) {
        buf = b;
        break;
      }
    }
    buf ??= new ArrayBuffer(Math.max(64, Math.ceil(floats * 1.5)) * 4);
    return new Float32Array(buf, 0, floats);
  }

  give(key: string, buf: ArrayBuffer): void {
    if (buf.byteLength === 0) return;
    let list = this.#free.get(key);
    if (list === undefined) this.#free.set(key, (list = []));
    if (list.length < 4) list.push(buf);
  }
}

/** every buffer of `out`, for the transfer list (each once) */
export function frameTransfers(out: FxFrameOut): ArrayBuffer[] {
  const list = new Set<ArrayBuffer>();
  for (const s of out.sprites) if (s.buf !== null) list.add(s.buf.buffer as ArrayBuffer);
  for (const s of out.stretched) if (s.buf !== null) list.add(s.buf.buffer as ArrayBuffer);
  for (const m of out.meshes) if (m.buf !== null) list.add(m.buf.buffer as ArrayBuffer);
  return [...list];
}

/** the buffers of a presented result, keyed for the pool they go back to */
export function returnedBuffers(out: FxFrameOut): Array<[string, ArrayBuffer]> {
  const list: Array<[string, ArrayBuffer]> = [];
  for (const s of out.sprites) if (s.buf !== null) list.push([spritePoolKey(s.key), s.buf.buffer as ArrayBuffer]);
  for (const s of out.stretched) if (s.buf !== null) list.push([stretchedPoolKey(s.key), s.buf.buffer as ArrayBuffer]);
  for (const m of out.meshes) if (m.buf !== null) list.push([meshPoolKey(m.space), m.buf.buffer as ArrayBuffer]);
  return list;
}
