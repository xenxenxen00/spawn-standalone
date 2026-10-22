// The light table (docs/design/rendering.md §8.1, §8.2 "Storage"; D3; WP R1b): every light record of a place that is not one
// of the five permanent three.js lights, the RGBA32F light `DataTexture` the two light loops read, and the per-frame
// view-space upload.
//
// A record never becomes a three `Light`: adding or removing a three light recompiles every lit material (three's lights
// cache key holds each light's id), while a record is four texels. Lamps that flicker, die or black out, fx lights that pop
// and a tier's caps all change data only.
//
// `lightTex`, one row, four texels per light (render §8.2 [D]):
//   texel 0   view-space position (xyz), cut-off radius (w); w < 0 on a slot that is dark or empty, so the loop's range
//             test rejects it after this one fetch
//   texel 1   colour × intensity (rgb), decay exponent (a)
//   texel 2   view-space spot direction, light − target, unit (xyz); cos(angle) (w)
//   texel 3   cos(angle · (1 − penumbra)), kind (0 point, 1 spot), enabled (0 / 1), pad
// The cone cosines come from the RAW angle (FX-25: the map spots written 38 and 40 are radians, never clamped). A point
// light stores the edges (−2, −1), for which the loop's smoothstep is 1 at every angle, so the loop has no branch on the
// kind. Positions and directions are transformed to view space here, once per frame, the way three's `SpotLightDataNode`
// does for its uniforms; the texture is sent whole each frame (r186 ignores update ranges), so it is sized to the place:
// the static block grows in steps of `STATIC_BLOCK_STEP` lights and the dynamic block is the fixed `DYNAMIC_LIGHTS_MAX`.
//
// Two blocks share the texture:
//   static block    slots [0, staticSlots): lights with `mobility: 'static'`. A slot index is what the cell lists of the
//                   world grid hold (light-grid.ts), so it stays put for the light's life.
//   dynamic block   slots [dynamicBase, dynamicBase + dynamicCount): the moving and transient lights the selector chose
//                   this frame (dynamic-lights.ts), best first.
//
// Mobility: a static light whose position changes becomes `moving` (its static slot goes dark and it joins the dynamic
// list). A change of direction alone keeps a spot in the grid only if the record says `sweep: true` (the a scene fixture
// searchlights, `scripts/gen/a scene fixture/sweep.js`): the grid scored that light without its cone, so every cell its sphere
// touches lists it. Any other static spot was scored with its cone and becomes `moving` when it turns.
//
// Writers (`setIntensity`, `setColor`) are last-write-wins in arrival order: power, flicker and dying-lamp scripts overwrite
// each other within a tick and the table never combines them (render §8.2 "Write order fidelity").
//
// FlashGuard (render §8.5): `applyFlashGuard(now, dt)` runs each light's intensity through its channel after the frame's
// writes and before `upload`. The channel's base is the light's peak intensity (the authored value unless the record gives
// `peakIntensity`).
//
// Lights that share a `flashKey` are one fx light slot (system-ui.md §3.7a.7 rows 9 and 10: muzzle pops keyed per shooter
// and socket, blasts keyed per class) and share one channel, whether the fx system keeps a light per slot or adds one per
// pop and removes it when the pop is over:
//   - the channel is applied once per frame, to the strongest target of the key's lights; each light shows the channel's
//     output times its share of that target, so overlapping pops merge and a dark light of the key stays dark;
//   - while the guard is on, the last lit light of a key is not cut when it is removed: its handle dies at once, but it stays
//     in the texture and fades with the channel, until it is dark or another light of the key is lit. Without this a pop
//     that is added and removed per shot would flash at the fire rate behind the guard's back;
//   - a key with no light keeps its channel for `FLASH_KEY_IDLE_MS`, so a pop that follows within the guard's reversal time
//     is still held, and then gives it back.
// With the guard off none of this applies: a light shows what its writer wrote and is gone when it is removed.
import { DataTexture, FloatType, NearestFilter, RGBAFormat } from 'three/webgpu';
import type { PerspectiveCamera } from 'three/webgpu';
import type { Vec3 } from '../../compat/core/types.ts';
import { implicitRadius } from '../calibration.ts';
import type { Linear3 } from '../color/color.ts';
import { DYNAMIC_LIGHTS_MAX, DynamicLightSelector } from './dynamic-lights.ts';
import type { FlashChannel, FlashGuardControl } from './flash-guard.ts';

export type LightKind = 'point' | 'spot' | 'directional';
export type LightMobility = 'static' | 'moving' | 'transient';
export type LightSource = 'row' | 'fx' | 'runtime';

/** render §8.1 */
export interface LightRecord {
  kind: LightKind;
  /** linear */
  color: Linear3;
  /** raw: radiance at 1 m (three's light units) */
  intensity: number;
  /** cut-off radius; 0 or absent → `implicitRadius(peak intensity)` */
  distance: number;
  /** default 2 */
  decay: number;
  /** spot, radians, used AS RENDERED (FX-25), never clamped */
  angle?: number;
  penumbra?: number;
  /** world */
  position: Vec3;
  /** spot, world: light − target (any length); the row's `aim` resolved by the bridge */
  direction?: Vec3;
  mobility: LightMobility;
  /** kept for the record: no table light casts a shadow (the shadowCaster's three `SpotLight` is the only caster, render §8.4) */
  shadow: boolean;
  source: LightSource;
  /**
   * The largest intensity the light reaches (the volcano grows to 3.64 × its row value; an fx fire's `li`). Default: the
   * intensity it is added with. The world grid scores the light by it, so a dimmed lamp keeps its place in the cell lists;
   * the implicit radius and the FlashGuard base are taken from it.
   */
  peakIntensity?: number;
  /** a static spot whose direction changes at run time (a searchlight): the grid scores it without its cone */
  sweep?: boolean;
  /**
   * The fx light slot this light belongs to (an fx `light()` sink per owner row and program, or per blast class): lights of
   * one key share a FlashGuard channel and, under the guard, hand their glow on to each other (see the header). An fx pop
   * that is added and removed per shot must carry one, or the guard cannot see that the pops belong together. Default: a
   * channel of its own.
   */
  flashKey?: string;
}

/** stable for the light's life; later lights have larger handles */
export type LightHandle = number & { readonly __lightHandle: unique symbol };

/** render §8.1 */
export interface LightTable {
  add(rec: LightRecord): LightHandle;
  remove(h: LightHandle): void;
  setIntensity(h: LightHandle, v: number): void;
  setColor(h: LightHandle, c: Linear3): void;
  /** a static light whose pose changes becomes "moving" (see the header for the searchlight case) */
  setPose(h: LightHandle, p: Vec3, dir?: Vec3): void;
  /** once per frame: view-space texels of the lights in use */
  upload(camera: PerspectiveCamera): void;
}

/** what the world grid is built from: one static light (light-grid.ts) */
export interface GridLight {
  /** the light's slot in the static block of `lightTex`: the value the cell lists hold */
  index: number;
  /** creation order; ties in a cell's ranking go to the lower id */
  id: number;
  kind: 'point' | 'spot';
  x: number;
  y: number;
  z: number;
  /** unit, light − target; (0, 1, 0) on a point light */
  dx: number;
  dy: number;
  dz: number;
  /** cut-off radius, > 0 */
  cutoff: number;
  decay: number;
  coneCos: number;
  penumbraCos: number;
  /** the peak intensity */
  intensity: number;
  /** an fx light (a fire): subject to the tier's `fxLights` cap */
  fx: boolean;
  sweep: boolean;
}

export interface LightTableControl extends LightTable {
  /** `lightTex`. A larger static block is a new texture: read this every frame. */
  readonly texture: DataTexture;
  /** its texels */
  readonly data: Float32Array;
  /** capacity of the static block, in lights */
  readonly staticSlots: number;
  /** first slot of the dynamic block (= `staticSlots`) */
  readonly dynamicBase: number;
  /** lights the last `upload` wrote into the dynamic block */
  readonly dynamicCount: number;
  /** the tier's `DYN_CAP` */
  readonly dynamicCap: number;
  /** live lights */
  readonly size: number;
  /** live lights in the static block */
  readonly staticCount: number;
  /** bumps when a light joins the static block: the cell lists must be rebuilt before the next frame */
  readonly staticRevision: number;
  setDynamicCap(cap: number): void;
  mobility(h: LightHandle): LightMobility | null;
  /** the intensity shown (after the FlashGuard); 0 for a removed light */
  intensity(h: LightHandle): number;
  /** the light's slot in the static block, −1 when it is in the dynamic list or gone */
  staticIndex(h: LightHandle): number;
  /** the lights the last `upload` wrote into the dynamic block, in block order (best first); allocates: tools and tests */
  dynamicHandles(): LightHandle[];
  /** the static lights, for a grid build */
  gridLights(): GridLight[];
  /**
   * Frees the static slots of lights that were removed or became moving. The cell lists name slots, so this is called only
   * by a grid rebuild, which writes new lists.
   */
  releaseRetired(): void;
  /** runs every light's intensity through its FlashGuard channel; call after the frame's writes, before `upload` */
  applyFlashGuard(nowMs: number, dt: number): void;
  /** removes every light (a place change); the texture is kept */
  clear(): void;
  dispose(): void;
}

export interface LightTableOptions {
  flashGuard?: FlashGuardControl | null;
}

/** texels per light */
export const LIGHT_TEXELS = 4;
/** the static block grows by this many lights */
export const STATIC_BLOCK_STEP = 16;
/** WebGL2 guarantees a 2,048 texel row: 512 lights, of which the dynamic block takes `DYNAMIC_LIGHTS_MAX` */
export const MAX_STATIC_LIGHTS = 2048 / LIGHT_TEXELS - DYNAMIC_LIGHTS_MAX;

/**
 * A `flashKey` with no light gives its channel back after this long. Longer than the guard's reversal time and its fade, so
 * a key that starts afresh (its first value is shown at once) cannot do so more than once a second.
 */
export const FLASH_KEY_IDLE_MS = 1000;

/** the lights of one `flashKey` and their shared channel */
interface FlashSlot {
  readonly key: string;
  /** made when the guard first runs on the key */
  channel: FlashChannel | null;
  /** the largest peak intensity of the lights the key has had: the channel's base */
  base: number;
  /** internal slots of its lights, the one fading out after its removal included */
  readonly members: number[];
  /** when the key was first seen without a light, ms; −1 while it has one */
  idleSince: number;
}

/** the cone edges stored for a point light: `ssSmoothstep(−2, −1, x)` is 1 for every cosine */
const POINT_CONE_COS = -2;
const POINT_PENUMBRA_COS = -1;

const FLOATS = LIGHT_TEXELS * 4;
const KIND_POINT = 0;
const KIND_SPOT = 1;
const MOBILITY: readonly LightMobility[] = ['static', 'moving', 'transient'];

/**
 * The cone edges of a spot: `cos(angle)` and `cos(angle · (1 − penumbra))`, from the RAW angle (render §8.1; three's
 * `SpotLightNode` does the same with `light.angle`).
 */
export function spotCosines(angle: number, penumbra: number): { coneCos: number; penumbraCos: number } {
  return { coneCos: Math.cos(angle), penumbraCos: Math.cos(angle * (1 - penumbra)) };
}

/**
 * The smoothstep of the light loops (render Appendix B.3): `t² (3 − 2t)` with `t = clamp((x − e0) / (e1 − e0), 0, 1)`, the
 * WGSL definition, which holds for `e0 > e1` (the inverted live cones); `step(e0, x)` when the edges are equal. GLSL leaves
 * its builtin undefined for `e0 ≥ e1`, and Spawn rendered on WebGPU.
 */
export function ssSmoothstep(e0: number, e1: number, x: number): number {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

const finiteOr = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const lit = (v: number): number => (v > 0 && Number.isFinite(v) ? v : 0);

function newTexture(slots: number): DataTexture {
  const data = new Float32Array(slots * FLOATS);
  const texture = new DataTexture(data, slots * LIGHT_TEXELS, 1, RGBAFormat, FloatType);
  texture.name = 'ss:lightTex';
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  for (let slot = 0; slot < slots; slot++) writeDark(data, slot);
  texture.needsUpdate = true;
  return texture;
}

function writeDark(data: Float32Array, slot: number): void {
  const o = slot * FLOATS;
  data.fill(0, o, o + FLOATS);
  data[o + 3] = -1; // cut-off < 0: skipped by the range test
  data[o + 7] = 2;
  data[o + 9] = 1;
  data[o + 11] = POINT_CONE_COS;
  data[o + 12] = POINT_PENUMBRA_COS;
}

export function createLightTable(opts: LightTableOptions = {}): LightTableControl {
  const guard = opts.flashGuard ?? null;
  const selector = new DynamicLightSelector(DYNAMIC_LIGHTS_MAX);

  // ── per-light state, struct of arrays, indexed by an internal slot ─────────────────────────────────────────────────
  let capacity = 64;
  let alive = new Uint8Array(capacity);
  let kind = new Uint8Array(capacity);
  let mobility = new Uint8Array(capacity);
  let fx = new Uint8Array(capacity);
  let sweep = new Uint8Array(capacity);
  /** slot in the static block, or −1 */
  let block = new Int32Array(capacity).fill(-1);
  /** position in `dynamic`, or −1 */
  let dynAt = new Int32Array(capacity).fill(-1);
  let ids = new Float64Array(capacity);
  // position, direction, colour, target and shown intensity, peak, cut-off, decay, cone edges
  let num = new Float64Array(capacity * 16);
  /** 1 on a keyed light that was removed under the guard and is fading out: no handle, still in the texture */
  let lingering = new Uint8Array(capacity);
  /** a keyed light's share of its key's strongest target, as of the last frame the key asked for light */
  let share = new Float64Array(capacity);
  /** the private channel of a light without a `flashKey` */
  const channels: Array<FlashChannel | null> = [];
  /** the fx light slot of a light with a `flashKey` */
  const flashSlotOf: Array<FlashSlot | null> = [];
  const flashSlots = new Map<string, FlashSlot>();
  /** the values of `flashSlots`, for a walk that allocates nothing */
  const flashSlotList: FlashSlot[] = [];
  const freeSlots: number[] = [];
  let high = 0;
  const slotOf = new Map<number, number>();
  let nextId = 1;
  let live = 0;

  const PX = 0;
  const DX = 3;
  const CR = 6;
  const TARGET = 9;
  const SHOWN = 10;
  const PEAK = 11;
  const CUTOFF = 12;
  const DECAY = 13;
  const CONE = 14;
  const PENUMBRA = 15;

  function growLights(): void {
    const next = capacity * 2;
    const grow8 = (a: Uint8Array): Uint8Array<ArrayBuffer> => {
      const b = new Uint8Array(next);
      b.set(a);
      return b;
    };
    const grow32 = (a: Int32Array): Int32Array<ArrayBuffer> => {
      const b = new Int32Array(next).fill(-1);
      b.set(a);
      return b;
    };
    alive = grow8(alive);
    kind = grow8(kind);
    mobility = grow8(mobility);
    fx = grow8(fx);
    sweep = grow8(sweep);
    lingering = grow8(lingering);
    const nextShare = new Float64Array(next);
    nextShare.set(share);
    share = nextShare;
    block = grow32(block);
    dynAt = grow32(dynAt);
    const nextIds = new Float64Array(next);
    nextIds.set(ids);
    ids = nextIds;
    const nextNum = new Float64Array(next * 16);
    nextNum.set(num);
    num = nextNum;
    capacity = next;
  }

  // ── the static block ───────────────────────────────────────────────────────────────────────────────────────────────
  /** internal slot per static block slot, −1 when empty */
  const blockSlot = new Int32Array(MAX_STATIC_LIGHTS).fill(-1);
  /** block slots handed out so far */
  let blockHigh = 0;
  const freeBlocks: number[] = [];
  const retiredBlocks: number[] = [];
  let staticCount = 0;
  let staticRevision = 0;

  // ── the dynamic list ───────────────────────────────────────────────────────────────────────────────────────────────
  let dynamic = new Int32Array(64);
  let dynamicLen = 0;
  let dynamicCap = DYNAMIC_LIGHTS_MAX;
  let dynamicCount = 0;

  // ── the texture ────────────────────────────────────────────────────────────────────────────────────────────────────
  let staticSlots = STATIC_BLOCK_STEP;
  let texture = newTexture(staticSlots + DYNAMIC_LIGHTS_MAX);
  let data = texture.image.data as Float32Array;

  function ensureStaticSlots(count: number): void {
    const want = Math.max(STATIC_BLOCK_STEP, Math.ceil(count / STATIC_BLOCK_STEP) * STATIC_BLOCK_STEP);
    if (want <= staticSlots) return;
    texture.dispose();
    staticSlots = want;
    texture = newTexture(staticSlots + DYNAMIC_LIGHTS_MAX);
    data = texture.image.data as Float32Array;
  }

  function joinDynamic(s: number): void {
    if (dynamicLen === dynamic.length) {
      const next = new Int32Array(dynamic.length * 2);
      next.set(dynamic);
      dynamic = next;
    }
    dynAt[s] = dynamicLen;
    dynamic[dynamicLen++] = s;
  }

  function leaveDynamic(s: number): void {
    const at = dynAt[s]!;
    if (at < 0) return;
    const last = dynamic[--dynamicLen]!;
    dynamic[at] = last;
    dynAt[last] = at;
    dynAt[s] = -1;
  }

  function leaveStatic(s: number): void {
    const b = block[s]!;
    if (b < 0) return;
    blockSlot[b] = -1;
    block[s] = -1;
    retiredBlocks.push(b); // the cell lists still name it: dark until the next grid build
    staticCount--;
  }

  function becomeMoving(s: number): void {
    if (mobility[s] !== 0) return;
    mobility[s] = 1;
    leaveStatic(s);
    joinDynamic(s);
  }

  /** the four texels of light `s` into block slot `slot`; `e` = the camera's `matrixWorldInverse.elements` */
  function writeLight(slot: number, s: number, e: ArrayLike<number>): void {
    const n = s * 16;
    const o = slot * FLOATS;
    const shown = num[n + SHOWN]!;
    const px = num[n + PX]!;
    const py = num[n + PX + 1]!;
    const pz = num[n + PX + 2]!;
    data[o] = e[0]! * px + e[4]! * py + e[8]! * pz + e[12]!;
    data[o + 1] = e[1]! * px + e[5]! * py + e[9]! * pz + e[13]!;
    data[o + 2] = e[2]! * px + e[6]! * py + e[10]! * pz + e[14]!;
    data[o + 3] = num[n + CUTOFF]!;
    data[o + 4] = num[n + CR]! * shown;
    data[o + 5] = num[n + CR + 1]! * shown;
    data[o + 6] = num[n + CR + 2]! * shown;
    data[o + 7] = num[n + DECAY]!;
    const dx = num[n + DX]!;
    const dy = num[n + DX + 1]!;
    const dz = num[n + DX + 2]!;
    const vx = e[0]! * dx + e[4]! * dy + e[8]! * dz;
    const vy = e[1]! * dx + e[5]! * dy + e[9]! * dz;
    const vz = e[2]! * dx + e[6]! * dy + e[10]! * dz;
    const len = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
    data[o + 8] = vx / len;
    data[o + 9] = vy / len;
    data[o + 10] = vz / len;
    data[o + 11] = num[n + CONE]!;
    data[o + 12] = num[n + PENUMBRA]!;
    data[o + 13] = kind[s]!;
    data[o + 14] = 1;
    data[o + 15] = 0;
  }

  const privateKey = (id: number): string => `light#${id}`;

  /** takes light `s` out of the table for good (a light that was fading out after its removal has no handle left to drop) */
  function dropLight(s: number): void {
    if (mobility[s] === 0) leaveStatic(s);
    else leaveDynamic(s);
    const flashSlot = flashSlotOf[s] ?? null;
    if (flashSlot !== null) {
      const members = flashSlot.members;
      const at = members.indexOf(s);
      if (at >= 0) {
        members[at] = members[members.length - 1]!;
        members.pop();
      }
      flashSlotOf[s] = null;
      // a key the guard never ran on has nothing to keep
      if (members.length === 0 && flashSlot.channel === null) {
        const k = flashSlotList.indexOf(flashSlot);
        if (k >= 0) forgetFlashSlot(k);
      }
    } else if (guard !== null && channels[s] != null) {
      guard.release(privateKey(ids[s]!));
    }
    channels[s] = null;
    if (lingering[s] === 1) {
      lingering[s] = 0;
    } else {
      slotOf.delete(ids[s]!);
      live--;
    }
    alive[s] = 0;
    freeSlots.push(s);
  }

  /** forgets the key at `flashSlotList[k]` (it has no light) */
  function forgetFlashSlot(k: number): void {
    flashSlots.delete(flashSlotList[k]!.key);
    flashSlotList[k] = flashSlotList[flashSlotList.length - 1]!;
    flashSlotList.pop();
  }

  /** true when a light of the key other than `s` is lit: it carries the key's glow on */
  function litElsewhere(flashSlot: FlashSlot, s: number): boolean {
    const members = flashSlot.members;
    for (let i = 0; i < members.length; i++) {
      const m = members[i]!;
      if (m !== s && lingering[m] === 0 && num[m * 16 + TARGET]! > 0) return true;
    }
    return false;
  }

  const slot = (h: LightHandle): number => slotOf.get(h) ?? -1;

  const table: LightTableControl = {
    get texture(): DataTexture {
      return texture;
    },
    get data(): Float32Array {
      return data;
    },
    get staticSlots(): number {
      return staticSlots;
    },
    get dynamicBase(): number {
      return staticSlots;
    },
    get dynamicCount(): number {
      return dynamicCount;
    },
    get dynamicCap(): number {
      return dynamicCap;
    },
    get size(): number {
      return live;
    },
    get staticCount(): number {
      return staticCount;
    },
    get staticRevision(): number {
      return staticRevision;
    },

    add(rec: LightRecord): LightHandle {
      if (rec.kind === 'directional') {
        throw new RangeError('light table: directional rows are the scene root’s two permanent DirectionalLights (render §4.1, §8.1), not table records');
      }
      if (rec.kind !== 'point' && rec.kind !== 'spot') throw new RangeError(`light table: unknown light kind ${JSON.stringify(rec.kind)}`);
      const isStatic = rec.mobility === 'static';
      if (!isStatic && rec.mobility !== 'moving' && rec.mobility !== 'transient') throw new RangeError(`light table: unknown mobility ${JSON.stringify(rec.mobility)}`);
      let b = -1;
      if (isStatic) {
        if (freeBlocks.length > 0) b = freeBlocks.pop()!;
        else if (blockHigh < MAX_STATIC_LIGHTS) b = blockHigh++;
        else throw new RangeError(`light table: more than ${MAX_STATIC_LIGHTS} static lights (one 2,048 texel row holds 512 lights with the dynamic block)`);
        ensureStaticSlots(blockHigh);
      }

      let s: number;
      if (freeSlots.length > 0) s = freeSlots.pop()!;
      else {
        if (high === capacity) growLights();
        s = high++;
      }
      const id = nextId++;
      const n = s * 16;
      const intensity = lit(rec.intensity);
      const peak = Math.max(intensity, lit(finiteOr(rec.peakIntensity, 0)));
      alive[s] = 1;
      kind[s] = rec.kind === 'spot' ? KIND_SPOT : KIND_POINT;
      mobility[s] = isStatic ? 0 : rec.mobility === 'moving' ? 1 : 2;
      fx[s] = rec.source === 'fx' ? 1 : 0;
      sweep[s] = rec.sweep === true ? 1 : 0;
      ids[s] = id;
      num[n + PX] = rec.position.x;
      num[n + PX + 1] = rec.position.y;
      num[n + PX + 2] = rec.position.z;
      setDirection(n, rec.direction);
      num[n + CR] = rec.color[0];
      num[n + CR + 1] = rec.color[1];
      num[n + CR + 2] = rec.color[2];
      num[n + TARGET] = intensity;
      num[n + SHOWN] = intensity;
      num[n + PEAK] = peak;
      const distance = finiteOr(rec.distance, 0);
      num[n + CUTOFF] = distance > 0 ? distance : implicitRadius(peak);
      num[n + DECAY] = finiteOr(rec.decay, 2);
      if (rec.kind === 'spot') {
        const c = spotCosines(finiteOr(rec.angle, Math.PI / 3), finiteOr(rec.penumbra, 0));
        num[n + CONE] = c.coneCos;
        num[n + PENUMBRA] = c.penumbraCos;
      } else {
        num[n + CONE] = POINT_CONE_COS;
        num[n + PENUMBRA] = POINT_PENUMBRA_COS;
      }
      channels[s] = null;
      lingering[s] = 0;
      share[s] = 0;
      let flashSlot: FlashSlot | null = null;
      if (typeof rec.flashKey === 'string' && rec.flashKey !== '') {
        flashSlot = flashSlots.get(rec.flashKey) ?? null;
        if (flashSlot === null) {
          flashSlot = { key: rec.flashKey, channel: null, base: 0, members: [], idleSince: -1 };
          flashSlots.set(rec.flashKey, flashSlot);
          flashSlotList.push(flashSlot);
        }
        if (peak > flashSlot.base) {
          flashSlot.base = peak;
          // asking again for a key hands the channel its new base
          if (flashSlot.channel !== null && guard !== null) flashSlot.channel = guard.channel(flashSlot.key, peak);
        }
        flashSlot.members.push(s);
        flashSlot.idleSince = -1;
      }
      flashSlotOf[s] = flashSlot;
      block[s] = b;
      dynAt[s] = -1;
      if (isStatic) {
        blockSlot[b] = s;
        staticCount++;
        staticRevision++;
      } else {
        joinDynamic(s);
      }
      slotOf.set(id, s);
      live++;
      return id as LightHandle;
    },

    remove(h: LightHandle): void {
      const s = slot(h);
      if (s < 0) return;
      const flashSlot = flashSlotOf[s] ?? null;
      if (flashSlot !== null && flashSlot.channel !== null && guard !== null && guard.enabled && num[s * 16 + SHOWN]! > 0 && !litElsewhere(flashSlot, s)) {
        // the last lit light of its key, under the guard: the handle is gone, the glow fades with the channel
        // (`applyFlashGuard` drops the light once it is dark or another light of the key is lit)
        lingering[s] = 1;
        num[s * 16 + TARGET] = 0;
        slotOf.delete(ids[s]!);
        live--;
        return;
      }
      dropLight(s);
    },

    setIntensity(h: LightHandle, v: number): void {
      const s = slot(h);
      if (s < 0) return;
      const value = lit(v);
      num[s * 16 + TARGET] = value;
      num[s * 16 + SHOWN] = value;
    },

    setColor(h: LightHandle, c: Linear3): void {
      const s = slot(h);
      if (s < 0) return;
      const n = s * 16;
      num[n + CR] = c[0];
      num[n + CR + 1] = c[1];
      num[n + CR + 2] = c[2];
    },

    setPose(h: LightHandle, p: Vec3, dir?: Vec3): void {
      const s = slot(h);
      if (s < 0) return;
      const n = s * 16;
      const moved = num[n + PX] !== p.x || num[n + PX + 1] !== p.y || num[n + PX + 2] !== p.z;
      let turned = false;
      if (dir !== undefined && kind[s] === KIND_SPOT) {
        const ox = num[n + DX]!;
        const oy = num[n + DX + 1]!;
        const oz = num[n + DX + 2]!;
        setDirection(n, dir);
        turned = num[n + DX] !== ox || num[n + DX + 1] !== oy || num[n + DX + 2] !== oz;
      }
      if (moved) {
        num[n + PX] = p.x;
        num[n + PX + 1] = p.y;
        num[n + PX + 2] = p.z;
      }
      if (mobility[s] === 0 && (moved || (turned && sweep[s] === 0))) becomeMoving(s);
    },

    upload(camera: PerspectiveCamera): void {
      // the inverse world matrix of this frame's pose, whoever moved the camera
      camera.updateWorldMatrix(true, false);
      const e = camera.matrixWorldInverse.elements;
      for (let b = 0; b < blockHigh; b++) {
        const s = blockSlot[b]!;
        if (s >= 0 && num[s * 16 + SHOWN]! > 0) writeLight(b, s, e);
        else writeDark(data, b);
      }
      selector.setView(e, camera.projectionMatrix.elements, camera.near, camera.far);
      selector.begin(dynamicCap);
      for (let i = 0; i < dynamicLen; i++) {
        const s = dynamic[i]!;
        const n = s * 16;
        const shown = num[n + SHOWN]!;
        if (shown > 0) selector.offer(ids[s]!, s, num[n + PX]!, num[n + PX + 1]!, num[n + PX + 2]!, shown, num[n + CUTOFF]!);
      }
      const chosen = selector.end();
      for (let i = 0; i < chosen; i++) writeLight(staticSlots + i, selector.refs[i]!, e);
      // the slots the last frame used beyond this frame's count go dark, so the block never holds a stale light
      for (let i = chosen; i < dynamicCount; i++) writeDark(data, staticSlots + i);
      dynamicCount = chosen;
      texture.needsUpdate = true;
    },

    setDynamicCap(cap: number): void {
      if (!Number.isInteger(cap) || cap < 0 || cap > DYNAMIC_LIGHTS_MAX) throw new RangeError(`light table: the dynamic cap must be an integer in 0..${DYNAMIC_LIGHTS_MAX}, got ${String(cap)}`);
      dynamicCap = cap;
    },

    mobility(h: LightHandle): LightMobility | null {
      const s = slot(h);
      return s < 0 ? null : MOBILITY[mobility[s]!]!;
    },

    intensity(h: LightHandle): number {
      const s = slot(h);
      return s < 0 ? 0 : num[s * 16 + SHOWN]!;
    },

    staticIndex(h: LightHandle): number {
      const s = slot(h);
      return s < 0 ? -1 : block[s]!;
    },

    dynamicHandles(): LightHandle[] {
      return Array.from(selector.ids.subarray(0, dynamicCount)) as LightHandle[];
    },

    gridLights(): GridLight[] {
      const out: GridLight[] = [];
      for (let b = 0; b < blockHigh; b++) {
        const s = blockSlot[b]!;
        if (s < 0) continue;
        const n = s * 16;
        out.push({
          index: b,
          id: ids[s]!,
          kind: kind[s] === KIND_SPOT ? 'spot' : 'point',
          x: num[n + PX]!,
          y: num[n + PX + 1]!,
          z: num[n + PX + 2]!,
          dx: num[n + DX]!,
          dy: num[n + DX + 1]!,
          dz: num[n + DX + 2]!,
          cutoff: num[n + CUTOFF]!,
          decay: num[n + DECAY]!,
          coneCos: num[n + CONE]!,
          penumbraCos: num[n + PENUMBRA]!,
          intensity: num[n + PEAK]!,
          fx: fx[s] === 1,
          sweep: sweep[s] === 1,
        });
      }
      return out;
    },

    releaseRetired(): void {
      while (retiredBlocks.length > 0) freeBlocks.push(retiredBlocks.pop()!);
      // lowest slot first, so a place's lights stay packed at the front of the row
      freeBlocks.sort((a, b) => b - a);
    },

    applyFlashGuard(nowMs: number, dt: number): void {
      if (guard === null) return;
      const on = guard.enabled;
      // lights with a channel of their own
      for (let s = 0; s < high; s++) {
        if (alive[s] === 0 || flashSlotOf[s] != null) continue;
        const n = s * 16;
        let channel = channels[s] ?? null;
        if (channel === null) {
          // nobody needs a channel while the guard is off: the writer's value is shown as it is
          if (!on) continue;
          channel = guard.channel(privateKey(ids[s]!), num[n + PEAK]!);
          channels[s] = channel;
        }
        num[n + SHOWN] = channel.apply(num[n + TARGET]!, nowMs, dt);
      }
      // the fx light slots: one channel per key, applied once, to the strongest target of the key's lights
      // (backwards: forgetting a key moves the last one into its place)
      for (let k = flashSlotList.length - 1; k >= 0; k--) {
        const flashSlot = flashSlotList[k]!;
        const members = flashSlot.members;
        let channel = flashSlot.channel;
        if (channel === null) {
          if (!on) {
            if (members.length === 0) forgetFlashSlot(k);
            continue;
          }
          channel = guard.channel(flashSlot.key, flashSlot.base);
          flashSlot.channel = channel;
        }
        let strongest = 0;
        for (let i = 0; i < members.length; i++) {
          const target = num[members[i]! * 16 + TARGET]!;
          if (target > strongest) strongest = target;
        }
        const out = channel.apply(strongest, nowMs, dt);
        // backwards: dropping a light moves the last member into its place
        for (let i = members.length - 1; i >= 0; i--) {
          const s = members[i]!;
          const n = s * 16;
          if (!on) {
            // the identity: what the writer wrote, to the bit, and nothing fades
            if (lingering[s] === 1) dropLight(s);
            else num[n + SHOWN] = num[n + TARGET]!;
            continue;
          }
          if (strongest > 0) share[s] = num[n + TARGET]! / strongest;
          const shown = share[s]! * out;
          num[n + SHOWN] = shown > 0 ? shown : 0;
          if (lingering[s] === 1 && !(shown > 0)) dropLight(s);
        }
        if (members.length > 0) {
          flashSlot.idleSince = -1;
        } else if (flashSlot.idleSince < 0 || nowMs < flashSlot.idleSince) {
          flashSlot.idleSince = nowMs;
        } else if (nowMs - flashSlot.idleSince >= FLASH_KEY_IDLE_MS) {
          guard.release(flashSlot.key);
          forgetFlashSlot(k);
        }
      }
    },

    clear(): void {
      for (let s = 0; s < high; s++) if (alive[s] === 1) dropLight(s);
      for (const flashSlot of flashSlotList) if (flashSlot.channel !== null && guard !== null) guard.release(flashSlot.key);
      flashSlots.clear();
      flashSlotList.length = 0;
      high = 0;
      freeSlots.length = 0;
      blockSlot.fill(-1);
      for (let b = 0; b < blockHigh; b++) writeDark(data, b);
      for (let i = 0; i < DYNAMIC_LIGHTS_MAX; i++) writeDark(data, staticSlots + i);
      blockHigh = 0;
      freeBlocks.length = 0;
      retiredBlocks.length = 0;
      dynamicLen = 0;
      dynamicCount = 0;
      staticCount = 0;
      staticRevision++;
      selector.reset();
      texture.needsUpdate = true;
    },

    dispose(): void {
      table.clear();
      texture.dispose();
    },
  };

  /** stores the unit direction of a spot; (0, 1, 0) (a lamp pointing straight down) when the record gives none */
  function setDirection(n: number, dir: Vec3 | undefined): void {
    let x = 0;
    let y = 1;
    let z = 0;
    if (dir !== undefined) {
      const len = Math.hypot(dir.x, dir.y, dir.z);
      if (len > 0 && Number.isFinite(len)) {
        x = dir.x / len;
        y = dir.y / len;
        z = dir.z / len;
      }
    }
    num[n + DX] = x;
    num[n + DX + 1] = y;
    num[n + DX + 2] = z;
  }

  return table;
}
