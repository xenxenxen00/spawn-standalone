// The animation mixer of one row (docs/design/motion-physics-nav.md §3.5; D-MPN-07; docs/architecture.md X-13, X-20, X-40):
// named channels, the write rules that decide restart / hold / keep, sim clocks, linear weight ramps, per-bone normalisation
// and the read views game code sees. Engine-free and three-free: it runs in plain Node for the soak and the live suite.
//
// WRITE RULES (§3.5.2, read top-down; every channel write goes through `write`, equal or not, X-13):
//   value null                 the channel leaves the table at once and fades out over its blendOut (default 0.1 s), its clock
//                              still running; a null for a channel that is not playing does nothing
//   another clip               restart: clip time = `time` ?? 0, start tick = the write tick; the previous clip moves to the
//                              fading list and ramps from its current effective weight to 0 over the new blendIn while the new
//                              one ramps 0 → weight. With `startTick` (and no `time`) the clip continues instead from
//                              (tick − startTick)/30 · speed: a corpse resumes the death clip its enemy started (X-20).
//   same clip, speed 0         hold: the clock stays where it is (or seeks to `time`), whatever the loop mode
//   same clip, loop 'once'     restart as above (a repeated `fire` on the viewmodel replays, authored module)
//   same clip, loop/pingpong   the clock is kept; a changed weight ramps from the current effective weight to the new one over
//                              the write's blendIn; speed, loop mode and mask apply from now. Nothing changed = no-op.
// A write is the whole statement of a channel: fields it leaves out take the defaults (MIXER_DEFAULTS), fields it does not
// know (`elapsed`, `duration`, … of an `Object.assign({}, anim.walk, {weight})`) are ignored, a write without a usable `clip`
// is ignored altogether. The live quirk of a frozen spawn-time clock (authored module) is not reproduced.
//
// CLOCKS (§3.5.3). `advanceTick(dt)` once per sim tick (step H): clip time += dt·speed, ramps += dt, pending clips are retried.
// `evaluate(pose, alpha)` samples at clip time + alpha·dt·speed and moves the ramps by the same alpha·dt: a pure function of
// the sim state, so a paused sim is a frozen animation. `elapsed` is sim seconds since the channel's (re)start, whatever the
// speed (authored module multiplies it by the speed itself).
//
// COMPOSITION (§3.5.4, AGENTS.md:137). Per bone, the contributors are the playing clips (channels and fading ones) that NAME
// the bone with an effective weight > 0; none → the bone is not written and keeps its last local transform. Each contributor
// gives an absolute local TRS (`delta`: R = bindR·q, T = bindT + offset·(hips rest height for `units: 'hips'`), S = bindS·s;
// `absolute`: the sampled TRS, bind where the clip has no track); weights are normalised among the contributors whatever they
// sum to; rotations add with hemisphere alignment to the heaviest contributor and are normalised.
//
// NOT LOADED YET (§3.5.6). A write before the rig exists, or of a clip the registry cannot hand out yet, is kept with its clock
// running; `setRig` and every tick retry. `detach()` / `setRig(other)` keep the clocks and rebind (model swaps).
//
// RELEASE (X-40, §3.8.2, §3.10). `release({ keepFinalPose: true })` frees channels and tracks and keeps a FrozenPose: the
// model-space matrices of the pose last evaluated. After it, writes, ticks and evaluations do nothing.
import { type BoundClip, type ClipRef, type CompiledClip, type LoopMode, clipTime as mapClipTime } from './clip.ts';
import { bakeClipFunction, identityOfClipFunction } from './clip-function.ts';
import { ClipRegistry } from './clip-registry.ts';
import { MIXER_DEFAULTS, SIM_HZ } from './constants.ts';
import { SS_COMPILED, isAuthoredClipObject } from './cook-authored.ts';
import { type FrozenPose, type Pose, type PoseRig, freezePose } from './pose.ts';

export type { FrozenPose } from './pose.ts';

/** what game code assigns to a channel (contract §16.1) */
export interface ChannelWrite {
  clip: ClipRef;
  loop?: LoopMode;
  speed?: number;
  weight?: number;
  /** seconds */
  blendIn?: number;
  /** seconds */
  blendOut?: number;
  /** clip seconds to start (or hold) at */
  time?: number;
  /** the sim tick the clip started at: the clip continues from there (spawn-time `mixer` of a corpse) */
  startTick?: number;
  /** restricts the channel to a bone and its descendants */
  mask?: { from: string };
}

/** what a read of a channel returns: a fresh snapshot each time (§3.5.5) */
export interface ChannelView extends Readonly<ChannelWrite> {
  /** as written for a string; the identity string of a clip object or function (`anim/<arch>.yml#<clip>`, `inline#<name>`) */
  readonly clip: string;
  readonly loop: LoopMode;
  readonly speed: number;
  readonly weight: number;
  readonly blendIn: number;
  readonly blendOut: number;
  /** the sim tick of the channel's (re)start: the tick of the write that started its clip */
  readonly startTick: number;
  /** sim seconds since the (re)start */
  readonly elapsed: number;
  /** clip seconds at speed 1; 0 while the clip is not resolved */
  readonly duration: number;
  /** place inside the clip, 0..1 */
  readonly progress: number;
  /** `once` and the clip time has reached the duration */
  readonly finished: boolean;
}

/** a clip that is fading out (debug and tests) */
export interface FadingInfo {
  readonly channel: string;
  readonly clip: string;
  /** effective weight now */
  readonly weight: number;
  readonly clipTime: number;
}

/** Binds a clip to a rig: bone indices per track and the bones it names; null when it cannot be bound (yet). */
export type ClipBinder = (clip: CompiledClip, rig: PoseRig) => BoundClip | null;

export interface MixerOptions {
  /** where clip references resolve (motion §3.2 order); default: a registry that knows clip objects and clip functions only */
  registry?: ClipRegistry;
  /** default: `defaultBinder` (bone names; `retarget.ts` supplies the one that retargets library clips) */
  bind?: ClipBinder;
  /** the sim clock, for `elapsed`; default: the mixer counts the ticks it is advanced by */
  clock?: { readonly tick: number };
}

/** A clip bound to a rig by bone name: `boneIdx[i]` is the rig bone of track i (−1 when the rig lacks it). */
export function bindByName(clip: CompiledClip, rig: PoseRig): BoundClip {
  const boneIdx = new Int16Array(clip.tracks.length);
  const names = new Uint8Array(rig.bones.length);
  for (let i = 0; i < clip.tracks.length; i++) {
    const b = rig.index(clip.tracks[i]!.bone);
    boneIdx[i] = b;
    if (b >= 0) names[b] = 1;
  }
  return { clip, rigId: rig.id, boneIdx, names, kind: clip.kind };
}

const BOUND = new WeakMap<CompiledClip, WeakMap<PoseRig, BoundClip>>();

/**
 * The binder of this package: bone names, for delta clips (authored, clip functions) and for absolute clips that are
 * expressed on the rig itself (a model's own clips, a library clip whose `sourceRig` is this rig). An absolute clip of another
 * rig needs retargeting (`retarget.ts`, MA2): null, the channel waits.
 */
export const defaultBinder: ClipBinder = (clip, rig) => {
  if (clip.kind === 'absolute' && clip.sourceRig !== undefined && clip.sourceRig !== rig.id) return null;
  let per = BOUND.get(clip);
  if (!per) {
    per = new WeakMap();
    BOUND.set(clip, per);
  }
  let b = per.get(rig);
  if (!b) {
    b = bindByName(clip, rig);
    per.set(rig, b);
  }
  return b;
};

const MASKS = new WeakMap<PoseRig, Map<string, Uint8Array>>();

/** per rig bone: 1 for `from` and its descendants; all 0 when the rig has no such bone */
function maskOf(rig: PoseRig, from: string): Uint8Array {
  let per = MASKS.get(rig);
  if (!per) {
    per = new Map();
    MASKS.set(rig, per);
  }
  let m = per.get(from);
  if (!m) {
    const n = rig.bones.length;
    m = new Uint8Array(n);
    const root = rig.index(from);
    if (root >= 0) {
      for (let b = 0; b < n; b++) {
        let a = b;
        for (let guard = 0; a >= 0 && a !== root && guard <= n; guard++) a = rig.parent[a]!;
        if (a === root) m[b] = 1;
      }
    }
    per.set(from, m);
  }
  return m;
}

let fallbackRegistry: ClipRegistry | null = null;
function defaultRegistry(): ClipRegistry {
  if (!fallbackRegistry) {
    fallbackRegistry = new ClipRegistry();
    fallbackRegistry.setFunctionBaker(bakeClipFunction);
  }
  return fallbackRegistry;
}

/** float slack for "the ramp is over" and "the clip has reached its end" (ticks add 1/30 up to a rounding error) */
const EPS = 1e-9;

const LOOPS: readonly unknown[] = ['once', 'loop', 'pingpong'];
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function isClipRef(v: unknown): v is ClipRef {
  return (typeof v === 'string' && v !== '') || typeof v === 'function' || isAuthoredClipObject(v);
}

/**
 * What makes two written clips the same clip: the string; for a clip object from `builtin/anim.clips()` and for a registered
 * clip function their identity string (so the object and its string copy are one clip); any other object or function itself.
 */
function clipKey(ref: ClipRef): unknown {
  if (typeof ref === 'string') return ref;
  if (typeof ref === 'function') return identityOfClipFunction(ref) ?? ref;
  const compiled = (ref as { [SS_COMPILED]?: CompiledClip })[SS_COMPILED];
  return compiled !== undefined ? compiled.id : ref;
}

/** one playing clip: a channel's current clip, or one that is fading out */
class Layer {
  channel = '';
  ref: ClipRef = '';
  key: unknown = '';
  /** what `clip` reads back as */
  name = '';
  clip: CompiledClip | null = null;
  bound: BoundClip | null = null;
  status: 'ready' | 'pending' | 'missing' = 'missing';
  loop: LoopMode = 'loop';
  speed = 1;
  clipTime = 0;
  maskFrom: string | null = null;
  mask: Uint8Array | null = null;
  /** effective weight at the last tick */
  w = 0;
  rampFrom = 0;
  rampTo = 0;
  rampT = 0;
  rampDur = 0;
  /** effective weight of the evaluation in progress */
  wNow = 0;
}

interface Chan {
  readonly name: string;
  layer: Layer;
  weight: number;
  blendIn: number;
  blendOut: number;
  time: number | undefined;
  startTick: number;
}

interface Normalised {
  ref: ClipRef;
  loop: LoopMode;
  speed: number;
  weight: number;
  blendIn: number;
  blendOut: number;
  time: number | undefined;
  startTick: number | undefined;
  mask: string | null;
}

export class Mixer {
  readonly rowId: string;
  readonly #registry: ClipRegistry;
  readonly #binder: ClipBinder;
  readonly #clock: { readonly tick: number } | null;
  #rig: PoseRig | null;
  readonly #channels = new Map<string, Chan>();
  /** the channels in write order (the hot paths walk arrays, not map iterators) */
  readonly #list: Chan[] = [];
  readonly #fading: Layer[] = [];
  readonly #pool: Layer[] = [];
  readonly #contrib: Layer[] = [];
  /** ticks seen, when no clock was given */
  #tick = 0;
  #dt = 1 / SIM_HZ;
  /** seconds past the last tick the evaluation in progress presents */
  #ahead = 0;
  #released = false;
  #frozen: FrozenPose | null = null;
  #lastPose: Pose | null = null;
  // per-bone accumulators of one evaluation, sized for the rig
  #sumW = new Float64Array(0);
  #accR = new Float64Array(0);
  #accT = new Float64Array(0);
  #accS = new Float64Array(0);
  #refR = new Float64Array(0);
  // one clip's sampled local values
  #lr = new Float64Array(0);
  #lt = new Float64Array(0);
  #ls = new Float64Array(0);

  constructor(rowId: string, rig: PoseRig | null, opts: MixerOptions = {}) {
    this.rowId = rowId;
    this.#registry = opts.registry ?? defaultRegistry();
    this.#binder = opts.bind ?? defaultBinder;
    this.#clock = opts.clock ?? null;
    this.#rig = null;
    if (rig) this.setRig(rig);
  }

  get rig(): PoseRig | null {
    return this.#rig;
  }

  get released(): boolean {
    return this.#released;
  }

  /** the model (re)loaded, or another body took its place: every clip resolves and binds again, clocks untouched (§3.5.6) */
  setRig(rig: PoseRig): void {
    if (this.#released) return;
    this.#rig = rig;
    const n = rig.bones.length;
    if (this.#sumW.length !== n) {
      this.#sumW = new Float64Array(n);
      this.#accR = new Float64Array(n * 4);
      this.#accT = new Float64Array(n * 3);
      this.#accS = new Float64Array(n * 3);
      this.#refR = new Float64Array(n * 4);
      this.#lr = new Float64Array(n * 4);
      this.#lt = new Float64Array(n * 3);
      this.#ls = new Float64Array(n * 3);
    }
    this.#lastPose = null;
    this.rebind();
  }

  /**
   * Resolves and binds every clip again, clocks untouched: after `setRig`, and when the registry learnt something a waiting
   * channel may need (a clip source set after the write; a pending library group or model container is asked again every
   * tick without this).
   */
  rebind(): void {
    if (this.#released) return;
    for (const c of this.#list) this.#resolve(c.layer);
    for (const l of this.#fading) this.#resolve(l);
  }

  /** the body is gone (a model swap in progress): channels keep playing unseen until the next setRig */
  detach(): void {
    if (this.#released) return;
    this.#rig = null;
    this.#lastPose = null;
    for (const c of this.#list) {
      c.layer.bound = null;
      c.layer.mask = null;
    }
    for (const l of this.#fading) {
      l.bound = null;
      l.mask = null;
    }
  }

  /** one channel write at sim tick `tick` (see the write rules in the header) */
  write(ch: string, value: ChannelWrite | null | undefined, tick: number): void {
    if (this.#released) return;
    if (tick > this.#tick) this.#tick = tick;
    const cur = this.#channels.get(ch);
    if (value === null || value === undefined) {
      if (!cur) return;
      this.#remove(cur);
      this.#fade(cur.layer, cur.blendOut);
      return;
    }
    const n = normalise(value);
    if (n === null) return;
    const key = clipKey(n.ref);
    if (!cur || cur.layer.key !== key) {
      this.#start(ch, cur, n, key, tick);
      return;
    }
    const L = cur.layer;
    if (n.speed === 0) {
      // hold
      if (n.time !== undefined) L.clipTime = n.time;
    } else if (n.loop === 'once') {
      this.#start(ch, cur, n, key, tick);
      return;
    }
    L.speed = n.speed;
    L.loop = n.loop;
    if (n.mask !== L.maskFrom) {
      L.maskFrom = n.mask;
      L.mask = n.mask !== null && this.#rig ? maskOf(this.#rig, n.mask) : null;
    }
    if (n.weight !== L.rampTo) ramp(L, n.weight, n.blendIn);
    cur.weight = n.weight;
    cur.blendIn = n.blendIn;
    cur.blendOut = n.blendOut;
    cur.time = n.time;
  }

  /** the read view of a channel, null when it is not in the table (never written, or cleared) */
  view(ch: string): ChannelView | null {
    const c = this.#channels.get(ch);
    return c ? this.#view(c) : null;
  }

  /** the `anim` / `mixer` read: every channel's view, in the order the channels were first written */
  table(): Record<string, ChannelView> {
    const out: Record<string, ChannelView> = {};
    for (const c of this.#list) out[c.name] = this.#view(c);
    return out;
  }

  channelNames(): string[] {
    return this.#list.map((c) => c.name);
  }

  /** the channel's running clip time in seconds (before the loop mapping), null when it is not in the table */
  clipTime(ch: string): number | null {
    const c = this.#channels.get(ch);
    return c ? c.layer.clipTime : null;
  }

  /** the channel's effective weight at the last tick (its ramp applied), null when it is not in the table */
  weight(ch: string): number | null {
    const c = this.#channels.get(ch);
    return c ? c.layer.w : null;
  }

  /** the clips that are fading out */
  fading(): FadingInfo[] {
    return this.#fading.map((l) => ({ channel: l.channel, clip: l.name, weight: l.w, clipTime: l.clipTime }));
  }

  /** tick step H: clocks, ramps, clips that could not resolve or bind before */
  advanceTick(dt: number): void {
    if (this.#released) return;
    this.#dt = dt;
    this.#tick++;
    const list = this.#list;
    for (let i = 0; i < list.length; i++) {
      const L = list[i]!.layer;
      L.clipTime += dt * L.speed;
      if (L.rampT < L.rampDur) stepRamp(L, dt);
      if (L.bound === null) this.#retry(L);
    }
    const fading = this.#fading;
    for (let i = fading.length - 1; i >= 0; i--) {
      const L = fading[i]!;
      L.clipTime += dt * L.speed;
      stepRamp(L, dt);
      if (L.rampT >= L.rampDur - EPS) {
        fading[i] = fading[fading.length - 1]!;
        fading.pop();
        this.#recycle(L);
      } else if (L.bound === null) this.#retry(L);
    }
  }

  /**
   * Writes the blended local transforms into `pose` (a pose of this mixer's rig): presentation with the frame's interpolation
   * alpha, the sim pose with alpha 0. Bones no contributor names are left as they are. The caller runs IK and
   * `pose.updateModel()` afterwards.
   */
  evaluate(pose: Pose, alpha: number): void {
    const rig = this.#rig;
    if (this.#released || rig === null || pose.rig !== rig) return;
    this.#lastPose = pose;
    // kept in a field, like every other number of the hot path: a float handed to a function as an argument is boxed
    const ahead = (this.#ahead = (alpha > 0 ? (alpha < 1 ? alpha : 1) : 0) * this.#dt);
    const C = this.#contrib;
    let k = 0;
    const list = this.#list;
    const fading = this.#fading;
    const total = list.length + fading.length;
    for (let i = 0; i < total; i++) {
      const L = i < list.length ? list[i]!.layer : fading[i - list.length]!;
      if (L.bound === null) continue;
      // the effective weight `ahead` seconds after the last tick
      if (L.rampT < L.rampDur) {
        const rt = L.rampT + ahead;
        L.wNow = rt >= L.rampDur - EPS ? L.rampTo : L.rampFrom + ((L.rampTo - L.rampFrom) * rt) / L.rampDur;
      } else L.wNow = L.w;
      if (L.wNow > 0) C[k++] = L;
    }
    if (k === 0) return;
    // heaviest first (stable): the first clip to reach a bone sets the hemisphere of its rotation sum
    for (let i = 1; i < k; i++) {
      const L = C[i]!;
      let j = i - 1;
      while (j >= 0 && C[j]!.wNow < L.wNow) {
        C[j + 1] = C[j]!;
        j--;
      }
      C[j + 1] = L;
    }
    const n = pose.count;
    const sumW = this.#sumW;
    sumW.fill(0);
    for (let i = 0; i < k; i++) this.#accumulate(C[i]!, rig, n);
    const accR = this.#accR;
    const accT = this.#accT;
    const accS = this.#accS;
    const refR = this.#refR;
    const pt = pose.t;
    const pr = pose.r;
    const ps = pose.s;
    for (let b = 0; b < n; b++) {
      const sw = sumW[b]!;
      if (!(sw > 0)) continue;
      const inv = 1 / sw;
      const b3 = b * 3;
      const b4 = b * 4;
      let x = accR[b4]!;
      let y = accR[b4 + 1]!;
      let z = accR[b4 + 2]!;
      let w = accR[b4 + 3]!;
      const len = Math.sqrt(x * x + y * y + z * z + w * w);
      if (len > 1e-12) {
        const il = 1 / len;
        x *= il;
        y *= il;
        z *= il;
        w *= il;
      } else {
        // opposite rotations cancelled: the heaviest contributor's stands
        x = refR[b4]!;
        y = refR[b4 + 1]!;
        z = refR[b4 + 2]!;
        w = refR[b4 + 3]!;
      }
      // store, then compare with what was there (the store rounds to float32): a bone whose value did not change is not marked
      let changed = false;
      let old = pt[b3]!;
      pt[b3] = accT[b3]! * inv;
      if (pt[b3] !== old) changed = true;
      old = pt[b3 + 1]!;
      pt[b3 + 1] = accT[b3 + 1]! * inv;
      if (pt[b3 + 1] !== old) changed = true;
      old = pt[b3 + 2]!;
      pt[b3 + 2] = accT[b3 + 2]! * inv;
      if (pt[b3 + 2] !== old) changed = true;
      old = pr[b4]!;
      pr[b4] = x;
      if (pr[b4] !== old) changed = true;
      old = pr[b4 + 1]!;
      pr[b4 + 1] = y;
      if (pr[b4 + 1] !== old) changed = true;
      old = pr[b4 + 2]!;
      pr[b4 + 2] = z;
      if (pr[b4 + 2] !== old) changed = true;
      old = pr[b4 + 3]!;
      pr[b4 + 3] = w;
      if (pr[b4 + 3] !== old) changed = true;
      old = ps[b3]!;
      ps[b3] = accS[b3]! * inv;
      if (ps[b3] !== old) changed = true;
      old = ps[b3 + 1]!;
      ps[b3 + 1] = accS[b3 + 1]! * inv;
      if (ps[b3 + 1] !== old) changed = true;
      old = ps[b3 + 2]!;
      ps[b3 + 2] = accS[b3 + 2]! * inv;
      if (ps[b3 + 2] !== old) changed = true;
      if (changed) pose.touch(b);
    }
  }

  /**
   * Frees the channels and their tracks. With `keepFinalPose` the model-space matrices of the pose last evaluated (or of
   * `pose`, when the caller evaluates several poses of this mixer and wants a particular one) stay behind as a FrozenPose
   * (X-40: the children of a baked corpse keep riding its bones); a mixer without a rig, or one that was never evaluated, has
   * none. A plain `release()`, also after an earlier keeping one, drops the pose too.
   */
  release(opts: { keepFinalPose?: boolean; pose?: Pose } = {}): FrozenPose | null {
    const keep = opts.keepFinalPose === true;
    if (!this.#released) {
      const pose = opts.pose ?? this.#lastPose;
      this.#frozen = keep && pose !== null && this.#rig !== null && pose.rig === this.#rig ? freezePose(pose) : null;
      this.#released = true;
      this.#channels.clear();
      this.#list.length = 0;
      this.#fading.length = 0;
      this.#pool.length = 0;
      this.#contrib.length = 0;
      this.#lastPose = null;
      this.#rig = null;
      const none = new Float64Array(0);
      this.#sumW = this.#accR = this.#accT = this.#accS = this.#refR = this.#lr = this.#lt = this.#ls = none;
    } else if (!keep) {
      this.#frozen = null;
    }
    return this.#frozen;
  }

  /** the pose `release({ keepFinalPose: true })` kept, else null */
  frozen(): FrozenPose | null {
    return this.#frozen;
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  #now(): number {
    return this.#clock ? this.#clock.tick : this.#tick;
  }

  #view(c: Chan): ChannelView {
    const L = c.layer;
    const d = L.clip ? L.clip.duration : 0;
    const once = L.loop === 'once';
    const finished = once && L.clip !== null && L.clipTime >= d - EPS;
    const progress = L.clip === null ? 0 : d > 0 ? (finished ? 1 : mapClipTime(L.clipTime, d, L.loop) / d) : once ? 1 : 0;
    const v: { -readonly [K in keyof ChannelView]: ChannelView[K] } = {
      clip: L.name,
      loop: L.loop,
      speed: L.speed,
      weight: c.weight,
      blendIn: c.blendIn,
      blendOut: c.blendOut,
      startTick: c.startTick,
      elapsed: (this.#now() - c.startTick) / SIM_HZ,
      duration: d,
      progress,
      finished,
    };
    if (c.time !== undefined) v.time = c.time;
    if (L.maskFrom !== null) v.mask = { from: L.maskFrom };
    return v;
  }

  /** a new clip on a channel: a first write or a restart */
  #start(ch: string, cur: Chan | undefined, n: Normalised, key: unknown, tick: number): void {
    const L = this.#pool.pop() ?? new Layer();
    L.channel = ch;
    L.ref = n.ref;
    L.key = key;
    L.name = typeof n.ref === 'string' ? n.ref : '';
    L.loop = n.loop;
    L.speed = n.speed;
    L.clipTime = n.time !== undefined ? n.time : n.startTick !== undefined ? ((tick - n.startTick) / SIM_HZ) * n.speed : 0;
    L.maskFrom = n.mask;
    L.w = 0;
    L.rampFrom = 0;
    L.rampTo = 0;
    L.rampT = 0;
    L.rampDur = 0;
    ramp(L, n.weight, n.blendIn);
    this.#resolve(L);
    const startTick = tick;
    if (cur) {
      // the outgoing clip cross-fades over the incoming clip's blendIn
      this.#fade(cur.layer, n.blendIn);
      cur.layer = L;
      cur.weight = n.weight;
      cur.blendIn = n.blendIn;
      cur.blendOut = n.blendOut;
      cur.time = n.time;
      cur.startTick = startTick;
      return;
    }
    const c: Chan = { name: ch, layer: L, weight: n.weight, blendIn: n.blendIn, blendOut: n.blendOut, time: n.time, startTick };
    this.#channels.set(ch, c);
    this.#list.push(c);
  }

  #remove(c: Chan): void {
    this.#channels.delete(c.name);
    const i = this.#list.indexOf(c);
    if (i >= 0) this.#list.splice(i, 1);
  }

  /** the clip leaves its channel: it ramps from its current effective weight to 0 over `dur` seconds, its clock running */
  #fade(L: Layer, dur: number): void {
    if (!(dur > 0) || !(L.w > 0)) {
      this.#recycle(L);
      return;
    }
    L.rampFrom = L.w;
    L.rampTo = 0;
    L.rampT = 0;
    L.rampDur = dur;
    this.#fading.push(L);
  }

  #recycle(L: Layer): void {
    L.ref = '';
    L.key = '';
    L.clip = null;
    L.bound = null;
    L.mask = null;
    if (this.#pool.length < 8) this.#pool.push(L);
  }

  #resolve(L: Layer): void {
    const rig = this.#rig;
    const res = this.#registry.resolveRef(L.ref, rig ? { modelId: rig.id } : {});
    if (res.status === 'ready') {
      L.clip = res.clip;
      L.status = 'ready';
      if (typeof L.ref !== 'string') L.name = res.clip.id;
    } else {
      L.clip = null;
      L.status = res.status;
      if (typeof L.ref !== 'string' && L.name === '') L.name = res.ref;
    }
    this.#bind(L);
  }

  #bind(L: Layer): void {
    const rig = this.#rig;
    L.bound = rig !== null && L.clip !== null ? this.#binder(L.clip, rig) : null;
    L.mask = rig !== null && L.maskFrom !== null ? maskOf(rig, L.maskFrom) : null;
  }

  /** a clip without a binding: a pending resolution is asked again, a resolved clip is offered to the binder again */
  #retry(L: Layer): void {
    if (L.status === 'pending') this.#resolve(L);
    else if (L.clip !== null && this.#rig !== null) this.#bind(L);
  }

  /** adds one clip's local transforms, weighted, to the bones it names */
  #accumulate(L: Layer, rig: PoseRig, n: number): void {
    const bound = L.bound!;
    const clip = bound.clip;
    const tracks = clip.tracks;
    const boneIdx = bound.boneIdx;
    const names = bound.names;
    const mask = L.mask;
    const delta = bound.kind === 'delta';
    // the running clip time mapped into the clip: clip.ts `clipTime`, written out (a float argument or result is boxed)
    const d = clip.duration;
    let t = L.clipTime + this.#ahead * L.speed;
    if (!(d > 0)) t = 0;
    else if (L.loop === 'once') t = t <= 0 ? 0 : t >= d ? d : t;
    else if (L.loop === 'loop') {
      t %= d;
      if (t < 0) t += d;
    } else {
      const period = 2 * d;
      t %= period;
      if (t < 0) t += period;
      if (t > d) t = period - t;
    }
    const lr = this.#lr;
    const lt = this.#lt;
    const ls = this.#ls;
    const bindT = rig.bindT;
    const bindR = rig.bindR;
    const bindS = rig.bindS;
    // 1. the neutral value of every bone the clip names: no delta, or the bind transform
    for (let b = 0; b < n; b++) {
      if (names[b] === 0 || (mask !== null && mask[b] === 0)) continue;
      const b3 = b * 3;
      const b4 = b * 4;
      if (delta) {
        lr[b4] = 0;
        lr[b4 + 1] = 0;
        lr[b4 + 2] = 0;
        lr[b4 + 3] = 1;
        lt[b3] = 0;
        lt[b3 + 1] = 0;
        lt[b3 + 2] = 0;
        ls[b3] = 1;
        ls[b3 + 1] = 1;
        ls[b3 + 2] = 1;
      } else {
        lr[b4] = bindR[b4]!;
        lr[b4 + 1] = bindR[b4 + 1]!;
        lr[b4 + 2] = bindR[b4 + 2]!;
        lr[b4 + 3] = bindR[b4 + 3]!;
        lt[b3] = bindT[b3]!;
        lt[b3 + 1] = bindT[b3 + 1]!;
        lt[b3 + 2] = bindT[b3 + 2]!;
        ls[b3] = bindS[b3]!;
        ls[b3 + 1] = bindS[b3 + 1]!;
        ls[b3 + 2] = bindS[b3 + 2]!;
      }
    }
    // 2. the tracks at clip time t. The rule is clip.ts `sampleTrack` (held flat outside the keys, LINEAR rotations nlerp
    //    along the short arc, vectors lerp, STEP holds the earlier key), written out here so no float crosses a call
    //    (tests/unit/motion/normalise.node.test.ts holds the two together).
    for (let i = 0; i < tracks.length; i++) {
      const b = boneIdx[i]!;
      if (b < 0 || (mask !== null && mask[b] === 0)) continue;
      const tr = tracks[i]!;
      const times = tr.times;
      const values = tr.values;
      const last = times.length - 1;
      // the last key at or before t
      let key = 0;
      if (last > 0 && t > times[0]!) {
        if (t >= times[last]!) key = last;
        else {
          let hi = last;
          while (hi - key > 1) {
            const mid = (key + hi) >> 1;
            if (times[mid]! <= t) key = mid;
            else hi = mid;
          }
        }
      }
      const t0 = times[key]!;
      const flat = key === last || t <= t0 || tr.interp === 'step';
      if (tr.prop === 'rotation') {
        const o = b * 4;
        const a = key * 4;
        const ax = values[a]!;
        const ay = values[a + 1]!;
        const az = values[a + 2]!;
        const aw = values[a + 3]!;
        if (flat) {
          lr[o] = ax;
          lr[o + 1] = ay;
          lr[o + 2] = az;
          lr[o + 3] = aw;
          continue;
        }
        const t1 = times[key + 1]!;
        const u = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
        const bx = values[a + 4]!;
        const by = values[a + 5]!;
        const bz = values[a + 6]!;
        const bw = values[a + 7]!;
        const s = ax * bx + ay * by + az * bz + aw * bw < 0 ? -u : u;
        const v = 1 - u;
        const x = v * ax + s * bx;
        const y = v * ay + s * by;
        const z = v * az + s * bz;
        const w = v * aw + s * bw;
        const len = Math.sqrt(x * x + y * y + z * z + w * w);
        if (len < 1e-20) {
          lr[o] = ax;
          lr[o + 1] = ay;
          lr[o + 2] = az;
          lr[o + 3] = aw;
        } else {
          const il = 1 / len;
          lr[o] = x * il;
          lr[o + 1] = y * il;
          lr[o + 2] = z * il;
          lr[o + 3] = w * il;
        }
        continue;
      }
      const out = tr.prop === 'position' ? lt : ls;
      const o = b * 3;
      const a = key * 3;
      if (flat) {
        out[o] = values[a]!;
        out[o + 1] = values[a + 1]!;
        out[o + 2] = values[a + 2]!;
        continue;
      }
      const t1 = times[key + 1]!;
      const u = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
      out[o] = values[a]! + (values[a + 3]! - values[a]!) * u;
      out[o + 1] = values[a + 1]! + (values[a + 4]! - values[a + 1]!) * u;
      out[o + 2] = values[a + 2]! + (values[a + 5]! - values[a + 2]!) * u;
    }
    // 3. to absolute local transforms, weighted into the bone sums
    const unit = delta && clip.units === 'hips' ? rig.hipsRestHeight : 1;
    const w = L.wNow;
    const sumW = this.#sumW;
    const accR = this.#accR;
    const accT = this.#accT;
    const accS = this.#accS;
    const refR = this.#refR;
    for (let b = 0; b < n; b++) {
      if (names[b] === 0 || (mask !== null && mask[b] === 0)) continue;
      const b3 = b * 3;
      const b4 = b * 4;
      let rx = lr[b4]!;
      let ry = lr[b4 + 1]!;
      let rz = lr[b4 + 2]!;
      let rw = lr[b4 + 3]!;
      let tx = lt[b3]!;
      let ty = lt[b3 + 1]!;
      let tz = lt[b3 + 2]!;
      let sx = ls[b3]!;
      let sy = ls[b3 + 1]!;
      let sz = ls[b3 + 2]!;
      if (delta) {
        // R = bindR·q (Hamilton), T = bindT + offset, S = bindS·s
        const ax = bindR[b4]!;
        const ay = bindR[b4 + 1]!;
        const az = bindR[b4 + 2]!;
        const aw = bindR[b4 + 3]!;
        const qx = rx;
        const qy = ry;
        const qz = rz;
        const qw = rw;
        rx = aw * qx + ax * qw + ay * qz - az * qy;
        ry = aw * qy - ax * qz + ay * qw + az * qx;
        rz = aw * qz + ax * qy - ay * qx + az * qw;
        rw = aw * qw - ax * qx - ay * qy - az * qz;
        tx = bindT[b3]! + tx * unit;
        ty = bindT[b3 + 1]! + ty * unit;
        tz = bindT[b3 + 2]! + tz * unit;
        sx *= bindS[b3]!;
        sy *= bindS[b3 + 1]!;
        sz *= bindS[b3 + 2]!;
      }
      const sw = sumW[b]!;
      if (sw === 0) {
        refR[b4] = rx;
        refR[b4 + 1] = ry;
        refR[b4 + 2] = rz;
        refR[b4 + 3] = rw;
        accR[b4] = w * rx;
        accR[b4 + 1] = w * ry;
        accR[b4 + 2] = w * rz;
        accR[b4 + 3] = w * rw;
        accT[b3] = w * tx;
        accT[b3 + 1] = w * ty;
        accT[b3 + 2] = w * tz;
        accS[b3] = w * sx;
        accS[b3 + 1] = w * sy;
        accS[b3 + 2] = w * sz;
      } else {
        const s = refR[b4]! * rx + refR[b4 + 1]! * ry + refR[b4 + 2]! * rz + refR[b4 + 3]! * rw < 0 ? -w : w;
        accR[b4] = accR[b4]! + s * rx;
        accR[b4 + 1] = accR[b4 + 1]! + s * ry;
        accR[b4 + 2] = accR[b4 + 2]! + s * rz;
        accR[b4 + 3] = accR[b4 + 3]! + s * rw;
        accT[b3] = accT[b3]! + w * tx;
        accT[b3 + 1] = accT[b3 + 1]! + w * ty;
        accT[b3 + 2] = accT[b3 + 2]! + w * tz;
        accS[b3] = accS[b3]! + w * sx;
        accS[b3 + 1] = accS[b3 + 1]! + w * sy;
        accS[b3 + 2] = accS[b3 + 2]! + w * sz;
      }
      sumW[b] = sw + w;
    }
  }
}

/** a write as the rules read it: defaults filled in, bad values dropped; null when it names no usable clip */
function normalise(value: unknown): Normalised | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const ref = v['clip'];
  if (!isClipRef(ref)) return null;
  const mask = v['mask'];
  const from = typeof mask === 'object' && mask !== null ? (mask as { from?: unknown }).from : undefined;
  return {
    ref,
    loop: LOOPS.includes(v['loop']) ? (v['loop'] as LoopMode) : MIXER_DEFAULTS.loop,
    speed: finite(v['speed']) ? v['speed'] : MIXER_DEFAULTS.speed,
    weight: finite(v['weight']) ? Math.max(0, v['weight']) : MIXER_DEFAULTS.weight,
    blendIn: finite(v['blendIn']) ? Math.max(0, v['blendIn']) : MIXER_DEFAULTS.blendIn,
    blendOut: finite(v['blendOut']) ? Math.max(0, v['blendOut']) : MIXER_DEFAULTS.blendOut,
    time: finite(v['time']) ? v['time'] : undefined,
    startTick: finite(v['startTick']) ? v['startTick'] : undefined,
    mask: typeof from === 'string' && from !== '' ? from : null,
  };
}

/** starts a linear ramp from the layer's current effective weight to `to` over `dur` seconds (at once when dur is 0) */
function ramp(L: Layer, to: number, dur: number): void {
  L.rampFrom = L.w;
  L.rampTo = to;
  L.rampT = 0;
  L.rampDur = dur;
  if (!(dur > 0)) L.w = to;
}

function stepRamp(L: Layer, dt: number): void {
  L.rampT += dt;
  L.w = L.rampT >= L.rampDur - EPS ? L.rampTo : L.rampFrom + ((L.rampTo - L.rampFrom) * L.rampT) / L.rampDur;
}
