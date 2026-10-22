// Gait facts (docs/design/motion-physics-nav.md §3.9; build §5.9 stage 8b; WP MA4): `ctx.world.assets[model].gait[clip]`, the
// metres per second the feet of a model cover with no slip while a clip plays at speed 1, at the model's own size. Engine-free.
//
// The live engine measured it at runtime and published it on the asset record a frame or two after the parse; game code reads
// it and falls back to its own table when the value is not a number above 0 (authored module,
// authored module, scripts/humanoid-locomotion.js:74-83). The port bakes it at build time
// (`tools/motion/gait-facts.ts`, merged into the stage-4 facts) and keeps the same measure here as the runtime fallback for a
// (model, clip) pair the bake does not have.
//
// THE MEASURE (`measurePace`), on the clip as the mixer plays it on that rig (retargeted, in place):
//   1. sample the pose at 60 Hz over the clip, start to end;
//   2. per foot (`LeftFoot` / `RightFoot`): the foot's height is the ankle's; when the ankle never rises 2 cm (a flat-footed
//      shuffle) the toe base decides instead. Frames within 2 cm of the cycle minimum are ground frames; a clip that holds
//      several steps has one such minimum per footfall (`groundFrames`) [M: zombie-walk and the two rifle gaits are 2 to 3
//      strides of motion capture, 1.9 to 3.95 s; counting only the lowest step measured run-loop 2 % lower];
//   3. per foot: the travel of the foot relative to the root (Hips), horizontally, over its ground frames. The stance is the
//      part of them in which the foot moves along their common direction (a planted foot slides one way under the body; the
//      few ground frames of toe-off and heel-strike move the other way and are left out). Pace of the foot = stance travel /
//      stance time;
//   4. pace = the mean of both feet, × the model's normalisation scale, rounded to 1 mm/s. A foot that never leaves the ground
//      band has no cyclic stance and counts 0; a result below 0.05 m/s is 0 (idle and attack clips: the legacy facts show 0
//      for those, world.facts.yaml:311-318).
// A rig without Hips or feet cannot be measured: null, and the key stays ABSENT from the facts (never NaN, never a made-up 0
// for a walk), so the game's own fallback applies.
import type { AssetFactsPort } from '../core/ports.ts';
import type { AssetFacts } from '../core/types.ts';
import type { BoundClip } from './clip.ts';
import { ClipRegistry } from './clip-registry.ts';
import { Mixer } from './mixer.ts';
import { Pose, type PoseRig } from './pose.ts';

export interface GaitMeasureOptions {
  /** sampling rate; default 60 */
  hz?: number;
  /** a foot within this of its lowest height is on the ground; default 0.02 m */
  band?: number;
  /** the model's normalisation scale (model space → the model at its own size); default 1 */
  scale?: number;
  /** a pace below this is no gait; default 0.05 m/s */
  minPace?: number;
}

export const GAIT_DEFAULTS = { hz: 60, band: 0.02, minPace: 0.05 } as const;

/** No asset names are assumed: the host supplies its measured locomotion clips. */
export const GAIT_LIBRARY_CLIPS: readonly string[] = Object.freeze([]);

const FEET: ReadonlyArray<readonly [ankle: string, toe: string]> = [
  ['LeftFoot', 'LeftToeBase'],
  ['RightFoot', 'RightToeBase'],
];

/**
 * Samples a bound clip on its rig at clip time `t`: the mixer itself, one channel held at `t`, so the measure sees exactly
 * what plays (delta and absolute clips, units, STEP tracks).
 */
export function clipSampler(bound: BoundClip, rig: PoseRig): (t: number) => Pose {
  const registry = new ClipRegistry();
  const id = `gait#${bound.clip.id}`;
  registry.addFunctionClip(id, bound.clip);
  const mixer = new Mixer('gait', rig, { registry, bind: () => bound });
  const pose = new Pose(rig);
  return (t) => {
    mixer.write('g', { clip: id, loop: 'once', speed: 0, time: t }, 0);
    mixer.evaluate(pose, 0);
    pose.updateModel();
    return pose;
  };
}

/** The pace of a clip on a rig in m/s (see the header); null when the rig has no Hips or no foot bones. */
export function measurePace(bound: BoundClip, rig: PoseRig, opts: GaitMeasureOptions = {}): number | null {
  const hips = rig.index('Hips');
  if (hips < 0) return null;
  const feet = FEET.map(([ankle, toe]) => ({ ankle: rig.index(ankle), toe: rig.index(toe) })).filter((f) => f.ankle >= 0 || f.toe >= 0);
  if (feet.length === 0) return null;
  const duration = bound.clip.duration;
  if (!(duration > 0)) return 0;
  const hz = opts.hz ?? GAIT_DEFAULTS.hz;
  const band = opts.band ?? GAIT_DEFAULTS.band;
  const n = Math.max(8, Math.round(duration * hz));
  const dt = duration / n;
  const sample = clipSampler(bound, rig);
  // per foot: ankle height, toe height, and the foot's horizontal place relative to the root, at n + 1 times
  const ankleY = feet.map(() => new Float64Array(n + 1));
  const toeY = feet.map(() => new Float64Array(n + 1));
  const relX = feet.map(() => new Float64Array(n + 1));
  const relZ = feet.map(() => new Float64Array(n + 1));
  const ground = feet.map(() => new Uint8Array(n + 1));
  for (let i = 0; i <= n; i++) {
    const m = sample(i * dt).model;
    const hx = m[hips * 16 + 12]!, hz2 = m[hips * 16 + 14]!;
    feet.forEach((f, k) => {
      const a = f.ankle >= 0 ? f.ankle : f.toe;
      const t = f.toe >= 0 ? f.toe : f.ankle;
      ankleY[k]![i] = m[a * 16 + 13]!;
      toeY[k]![i] = m[t * 16 + 13]!;
      relX[k]![i] = m[a * 16 + 12]! - hx;
      relZ[k]![i] = m[a * 16 + 14]! - hz2;
    });
  }
  let sum = 0;
  for (let k = 0; k < feet.length; k++) {
    let h = ankleY[k]!;
    if (range(h) < band) h = toeY[k]!;
    if (range(h) < band) continue; // never off the ground: no cyclic stance, this foot counts 0
    const g = groundFrames(h, band, ground[k]!);
    const x = relX[k]!, z = relZ[k]!;
    // the common direction of the ground frames
    let dx = 0, dz = 0;
    for (let i = 0; i < n; i++) {
      if (g[i] === 0 || g[i + 1] === 0) continue;
      dx += x[i + 1]! - x[i]!;
      dz += z[i + 1]! - z[i]!;
    }
    const dl = Math.hypot(dx, dz);
    if (!(dl > 1e-9)) continue;
    dx /= dl;
    dz /= dl;
    // the stance: ground frames that move along it
    let travel = 0;
    let frames = 0;
    for (let i = 0; i < n; i++) {
      if (g[i] === 0 || g[i + 1] === 0) continue;
      const along = (x[i + 1]! - x[i]!) * dx + (z[i + 1]! - z[i]!) * dz;
      if (along > 0) {
        travel += along;
        frames++;
      }
    }
    if (frames > 0) sum += travel / (frames * dt);
  }
  const pace = (sum / FEET.length) * (opts.scale ?? 1);
  if (!Number.isFinite(pace)) return null;
  return pace < (opts.minPace ?? GAIT_DEFAULTS.minPace) ? 0 : Math.round(pace * 1000) / 1000;
}

/**
 * Marks the ground frames of a foot's height curve into `out`: around every footfall (a local minimum in the lower quarter of
 * the curve's range) the frames within `band` of THAT footfall's lowest height. A clip of one cycle has one footfall and this
 * is "within 2 cm of the cycle minimum"; a clip that holds several steps (zombie-walk, the rifle gaits: 2 to 3 strides of
 * motion capture, each bottoming out at its own height) gets every step counted, not only the lowest one.
 */
function groundFrames(h: Float64Array, band: number, out: Uint8Array): Uint8Array {
  out.fill(0);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < h.length; i++) {
    if (h[i]! < lo) lo = h[i]!;
    if (h[i]! > hi) hi = h[i]!;
  }
  const low = lo + Math.max(band, (hi - lo) * 0.25);
  let i = 0;
  while (i < h.length) {
    if (h[i]! > low) {
      i++;
      continue;
    }
    // one visit to the lower quarter: its own minimum, then the frames within the band of it
    let end = i;
    let floor = h[i]!;
    while (end + 1 < h.length && h[end + 1]! <= low) {
      end++;
      if (h[end]! < floor) floor = h[end]!;
    }
    for (let k = i; k <= end; k++) if (h[k]! <= floor + band) out[k] = 1;
    i = end + 1;
  }
  return out;
}

function range(a: Float64Array): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < lo) lo = a[i]!;
    if (a[i]! > hi) hi = a[i]!;
  }
  return hi - lo;
}

// ── the `ctx.world.assets[model].gait` provider ────────────────────────────────────────────────────────────────────────────

export interface GaitFactsOptions {
  /** the baked facts (the asset index through `AssetFactsPort.get`) */
  base: Pick<AssetFactsPort, 'get'>;
  /** the rig of a model once it is loaded (render's template rig); absent or null = only baked facts */
  rigOf?: (ref: string) => PoseRig | null | undefined;
  /** the clip as the mixer would play it on that rig (registry + retarget binder); null while it cannot be bound yet */
  bind?: (clip: string, rig: PoseRig) => BoundClip | null;
  /** the clips measured at runtime when the bake lacks them; default `GAIT_LIBRARY_CLIPS` */
  clips?: readonly string[];
  /** the model's normalisation scale; default 1 */
  scaleOf?: (ref: string) => number;
  measure?: GaitMeasureOptions;
}

interface RefCache {
  base: AssetFacts | undefined;
  /** runtime measures of this ref, by clip */
  measured: Record<string, number>;
  merged: AssetFacts | undefined;
}

/**
 * Baked gait facts with the runtime measure behind them. `get(ref)` is what `ctx.world.assets[ref]` answers: the base facts,
 * plus `gait` entries measured here for the candidate clips the bake lacks. A clip that cannot be bound yet (its library file
 * or the model is not loaded) is absent and asked again on a later read; a measure is taken once per (rig, clip).
 */
export class GaitFacts {
  readonly #opts: GaitFactsOptions;
  readonly #clips: readonly string[];
  /** `${rigId}|${clip}` → pace, or null for a rig that cannot be measured */
  readonly #memo = new Map<string, number | null>();
  readonly #refs = new Map<string, RefCache>();
  /** measures taken (tests) */
  measures = 0;

  constructor(opts: GaitFactsOptions) {
    this.#opts = opts;
    this.#clips = opts.clips ?? GAIT_LIBRARY_CLIPS;
  }

  get(ref: string): AssetFacts | undefined {
    const base = this.#opts.base.get(ref);
    const rig = this.#opts.rigOf?.(ref) ?? null;
    const bind = this.#opts.bind;
    if (rig === null || bind === undefined) return base;
    let c = this.#refs.get(ref);
    if (c === undefined || c.base !== base) {
      c = { base, measured: c?.measured ?? {}, merged: undefined };
      this.#refs.set(ref, c);
    }
    let grew = false;
    for (const clip of this.#clips) {
      if (base?.gait !== undefined && Object.hasOwn(base.gait, clip)) continue;
      if (Object.hasOwn(c.measured, clip)) continue;
      const key = `${rig.id}|${clip}`;
      let pace = this.#memo.get(key);
      if (pace === undefined) {
        const bound = bind(clip, rig);
        if (bound === null) continue; // not loaded yet: absent, asked again
        pace = measurePace(bound, rig, { ...this.#opts.measure, scale: this.#opts.scaleOf?.(ref) ?? this.#opts.measure?.scale ?? 1 });
        this.#memo.set(key, pace);
        this.measures++;
      }
      if (pace === null) continue;
      c.measured[clip] = pace;
      grew = true;
    }
    if (grew || c.merged === undefined) {
      c.merged = Object.keys(c.measured).length === 0 ? base : Object.freeze({ ...base, gait: Object.freeze({ ...c.measured, ...base?.gait }) });
    }
    return c.merged;
  }

  /** `gait[clip]` of a model, or undefined */
  pace(ref: string, clip: string): number | undefined {
    return this.get(ref)?.gait?.[clip];
  }

  /** A model was reloaded or swapped: its runtime measures are taken again. */
  forget(ref: string): void {
    const rig = this.#opts.rigOf?.(ref);
    if (rig) for (const clip of this.#clips) this.#memo.delete(`${rig.id}|${clip}`);
    this.#refs.delete(ref);
  }
}

/** The asset facts port with the gait provider in front of `get` (compose: `ports.assets = withGaitFacts(port, {…})`). */
export function withGaitFacts(port: AssetFactsPort, opts: Omit<GaitFactsOptions, 'base'>): AssetFactsPort & { readonly gait: GaitFacts } {
  const gait = new GaitFacts({ ...opts, base: port });
  return { get: (ref) => gait.get(ref), placeBake: (place) => port.placeBake(place), gait };
}
