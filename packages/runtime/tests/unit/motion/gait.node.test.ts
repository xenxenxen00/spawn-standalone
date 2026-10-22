// MA4: gait facts (docs/design/motion-physics-nav.md §3.9): the pace measure on rigs with a known stance speed, and the
// `ctx.world.assets[model].gait` provider (baked facts first, the runtime measure behind them). The bake over the live
// mirror is tests/unit/motion/gait-facts.node.test.ts.
import { describe, expect, it } from 'vitest';
import type { AssetFacts } from '../../../src/compat/core/types.ts';
import type { BoundClip } from '../../../src/compat/motion/clip.ts';
import { GaitFacts, clipSampler, measurePace, withGaitFacts } from '../../../src/compat/motion/gait.ts';
import { bindByName } from '../../../src/compat/motion/mixer.ts';
import type { PoseRig } from '../../../src/compat/motion/pose.ts';
import { clipOf, makeRig, quat, type TrackDef } from './fakes/rig.ts';

/** a body whose feet hang straight off the Hips, so a foot's local translation is its place under the body */
function walker(size = 1, id = 'test.walker'): PoseRig {
  return makeRig(id, [
    { name: 'Hips', parent: null, t: [0, 1 * size, 0] },
    { name: 'Spine', parent: 'Hips', t: [0, 0.4 * size, 0] },
    { name: 'LeftArm', parent: 'Spine', t: [0.2 * size, 0, 0] },
    { name: 'LeftFoot', parent: 'Hips', t: [0.1 * size, -0.95 * size, 0] },
    { name: 'LeftToeBase', parent: 'LeftFoot', t: [0, -0.05 * size, -0.12 * size] },
    { name: 'RightFoot', parent: 'Hips', t: [-0.1 * size, -0.95 * size, 0] },
    { name: 'RightToeBase', parent: 'RightFoot', t: [0, -0.05 * size, -0.12 * size] },
  ]);
}

/**
 * An in-place walk of period `T`: each foot is planted for half the cycle and slides back `stride` metres under the body at a
 * constant speed, then lifts `lift` and swings forward. Stance speed = stride / (T / 2).
 */
function walkTracks(T: number, stride: number, lift: number, size = 1): TrackDef[] {
  const y = -0.95 * size;
  const h = stride / 2;
  return [
    { bone: 'LeftFoot', prop: 'position', times: [0, T / 2, (3 * T) / 4, T], values: [0.1 * size, y, -h, 0.1 * size, y, h, 0.1 * size, y + lift, 0, 0.1 * size, y, -h] },
    { bone: 'RightFoot', prop: 'position', times: [0, T / 4, T / 2, T], values: [-0.1 * size, y, h, -0.1 * size, y + lift, 0, -0.1 * size, y, -h, -0.1 * size, y, h] },
  ];
}

const bound = (rig: PoseRig, duration: number, tracks: TrackDef[], id = 'cdn/clip-test.glb'): BoundClip => bindByName(clipOf(id, 'absolute', duration, tracks), rig);

describe('measurePace', () => {
  it('returns the stance speed of a walking rig within 1 %', () => {
    const rig = walker();
    for (const [T, stride] of [
      [1, 0.6],
      [0.7, 1.4],
      [1.1333, 0.9],
      [2, 0.5],
    ] as const) {
      const pace = measurePace(bound(rig, T, walkTracks(T, stride, 0.15)), rig)!;
      const want = stride / (T / 2);
      expect(Math.abs(pace - want) / want, `T ${T} stride ${stride}: measured ${pace}, stance speed ${want}`).toBeLessThan(0.01);
    }
  });

  it('measures relative to the root: a swaying, bobbing pelvis does not change the pace', () => {
    const rig = walker();
    const sway: TrackDef = { bone: 'Hips', prop: 'position', times: [0, 0.25, 0.5, 0.75, 1], values: [0, 1, 0, 0.05, 0.97, 0.03, 0, 1, 0, -0.05, 0.97, -0.03, 0, 1, 0] };
    const pace = measurePace(bound(rig, 1, [...walkTracks(1, 0.6, 0.15), sway]), rig)!;
    expect(Math.abs(pace - 1.2) / 1.2).toBeLessThan(0.01);
  });

  it('is at the model’s own size: a body twice as large paces twice as fast, and the normalisation scale multiplies', () => {
    const small = walker(1);
    const big = walker(2, 'test.walker.big');
    const a = measurePace(bound(small, 1, walkTracks(1, 0.6, 0.15)), small)!;
    const b = measurePace(bound(big, 1, walkTracks(1, 1.2, 0.3, 2)), big)!;
    expect(b / a).toBeCloseTo(2, 2);
    expect(measurePace(bound(small, 1, walkTracks(1, 0.6, 0.15)), small, { scale: 1.5 })! / a).toBeCloseTo(1.5, 2);
  });

  it('a clip with no cyclic stance gives 0: idle (feet still), attack (arms only), a shuffle that never lifts a foot', () => {
    const rig = walker();
    const still: TrackDef[] = [
      { bone: 'LeftFoot', prop: 'position', times: [0], values: [0.1, -0.95, 0] },
      { bone: 'RightFoot', prop: 'position', times: [0], values: [-0.1, -0.95, 0] },
    ];
    expect(measurePace(bound(rig, 2, still), rig)).toBe(0);
    const breathing: TrackDef = { bone: 'Hips', prop: 'position', times: [0, 1, 2], values: [0, 1, 0, 0, 1.01, 0, 0, 1, 0] };
    expect(measurePace(bound(rig, 2, [...still, breathing]), rig)).toBe(0);
    const attack: TrackDef = { bone: 'LeftArm', prop: 'rotation', times: [0, 0.4, 0.9], values: [...quat(0, 0, 0), ...quat(-90, 20, 0), ...quat(0, 0, 0)] };
    expect(measurePace(bound(rig, 0.9, [attack]), rig)).toBe(0);
    expect(measurePace(bound(rig, 1, walkTracks(1, 0.6, 0)), rig)).toBe(0);
    // a foot that drifts a few millimetres a second is no gait either
    expect(measurePace(bound(rig, 4, walkTracks(4, 0.05, 0.15)), rig)).toBe(0);
  });

  it('the toe base decides when the ankle never rises (the tie-break)', () => {
    const rig = walker();
    const T = 1;
    const tracks = walkTracks(T, 0.6, 0); // ankles slide at a constant height
    // the left toe lifts during the left swing (0.5..1), the right toe during the right swing (0..0.5)
    tracks.push({ bone: 'LeftToeBase', prop: 'position', times: [0, 0.5, 0.75, 1], values: [0, -0.05, -0.12, 0, -0.05, -0.12, 0, 0.1, -0.12, 0, -0.05, -0.12] });
    tracks.push({ bone: 'RightToeBase', prop: 'position', times: [0, 0.25, 0.5, 1], values: [0, -0.05, -0.12, 0, 0.1, -0.12, 0, -0.05, -0.12, 0, -0.05, -0.12] });
    const pace = measurePace(bound(rig, T, tracks), rig)!;
    expect(Math.abs(pace - 1.2) / 1.2).toBeLessThan(0.02);
  });

  it('null for a rig it cannot measure (no Hips, no feet): the key stays absent', () => {
    const noFeet = makeRig('test.nofeet', [{ name: 'Hips', parent: null, t: [0, 1, 0] }, { name: 'Spine', parent: 'Hips', t: [0, 0.4, 0] }]);
    const noHips = makeRig('test.nohips', [{ name: 'Root', parent: null, t: [0, 1, 0] }, { name: 'LeftFoot', parent: 'Root', t: [0, -1, 0] }]);
    const t: TrackDef[] = [{ bone: 'Spine', prop: 'rotation', times: [0, 1], values: [...quat(0, 0, 0), ...quat(0, 0, 30)] }];
    expect(measurePace(bound(noFeet, 1, t), noFeet)).toBe(null);
    expect(measurePace(bound(noHips, 1, t), noHips)).toBe(null);
  });

  it('is deterministic, finite and rounded to 1 mm/s', () => {
    const rig = walker();
    const b = bound(rig, 1.1333, walkTracks(1.1333, 0.9, 0.12));
    const a = measurePace(b, rig)!;
    for (let i = 0; i < 5; i++) expect(Object.is(measurePace(b, rig), a)).toBe(true);
    expect(Number.isFinite(a)).toBe(true);
    expect(Math.round(a * 1000) / 1000).toBe(a);
    // the sampler is the mixer: the pose it gives at a key time is the key
    const pose = clipSampler(b, rig)(1.1333 / 2);
    const f = rig.index('LeftFoot');
    expect(pose.t[f * 3 + 2]).toBeCloseTo(0.45, 6);
  });
});

describe('GaitFacts: baked facts, then the runtime measure', () => {
  const WALK = 'cdn/clip-walk-loop.glb';
  const RUN = 'cdn/clip-run-loop.glb';
  const MODEL = 'value.aaaa.glb';
  const rig = walker(1, MODEL);

  function world(baked: Record<string, AssetFacts>) {
    const loaded = new Set<string>();
    const binds: string[] = [];
    const clips: Record<string, BoundClip> = {
      [WALK]: bound(rig, 1, walkTracks(1, 0.6, 0.15), WALK),
      [RUN]: bound(rig, 0.7, walkTracks(0.7, 1.4, 0.3), RUN),
    };
    let haveRig = true;
    const gait = new GaitFacts({
      clips: [WALK, RUN],
      base: { get: (ref) => baked[ref] },
      rigOf: (ref) => (haveRig && ref === MODEL ? rig : null),
      bind: (clip) => {
        binds.push(clip);
        return loaded.has(clip) ? (clips[clip] ?? null) : null;
      },
    });
    return { gait, loaded, binds, setRig: (v: boolean) => (haveRig = v) };
  }

  /** scripts/bots/runtime.js:377-383 */
  const paceOf = (assets: (ref: string) => AssetFacts | undefined, model: string, clip: string, fallback: number): number => {
    const gait = assets(model)?.gait;
    const measured = gait && gait[clip];
    return typeof measured === 'number' && measured > 0 ? measured : fallback;
  };

  it('baked facts pass through untouched and win over a measure', () => {
    const facts: AssetFacts = { skinned: true, gait: { [WALK]: 1.581, [RUN]: 4.19 } };
    const w = world({ [MODEL]: facts });
    w.loaded.add(WALK).add(RUN);
    expect(w.gait.get(MODEL)).toBe(facts);
    expect(w.gait.measures).toBe(0);
    expect(w.gait.pace(MODEL, WALK)).toBe(1.581);
    expect(w.gait.get('value.unknown.glb')).toBe(undefined);
  });

  it('a clip the bake lacks is absent until it can be bound, then measured once', () => {
    const facts: AssetFacts = { skinned: true, triangles: 9850, gait: { [RUN]: 4.19 } };
    const w = world({ [MODEL]: facts });
    // the library file is not loaded: the key is absent (never 0, never NaN), the game uses its own table
    expect(w.gait.get(MODEL)).toBe(facts);
    expect(paceOf((r) => w.gait.get(r), MODEL, WALK, 1.58)).toBe(1.58);
    expect(Object.hasOwn(w.gait.get(MODEL)!.gait!, WALK)).toBe(false);
    w.loaded.add(WALK);
    const merged = w.gait.get(MODEL)!;
    expect(merged.gait![WALK]).toBeCloseTo(1.2, 2);
    expect(merged.gait![RUN]).toBe(4.19);
    expect(merged.triangles).toBe(9850);
    expect(Object.isFrozen(merged) && Object.isFrozen(merged.gait)).toBe(true);
    expect(paceOf((r) => w.gait.get(r), MODEL, WALK, 1.58)).toBeCloseTo(1.2, 2);
    // memoised: the same object, no further bind or measure
    const binds = w.binds.length;
    for (let i = 0; i < 20; i++) expect(w.gait.get(MODEL)).toBe(merged);
    expect(w.gait.measures).toBe(1);
    expect(w.binds.filter((c) => c === WALK).length).toBe(w.binds.slice(0, binds).filter((c) => c === WALK).length);
    // every other gait clip is still asked for (it may load later) and still absent
    expect([WALK, RUN].filter((c) => Object.hasOwn(merged.gait!, c)).sort()).toEqual([RUN, WALK].sort());
  });

  it('a model without baked facts gets measured ones; without a rig or a binder nothing is added', () => {
    const w = world({});
    w.loaded.add(WALK).add(RUN);
    const got = w.gait.get(MODEL)!;
    expect(got.gait![WALK]).toBeCloseTo(1.2, 2);
    expect(got.gait![RUN]).toBeCloseTo(4, 1);
    w.gait.forget(MODEL);
    w.setRig(false);
    expect(w.gait.get(MODEL)).toBe(undefined);
    const bare = new GaitFacts({ base: { get: () => ({ skinned: true }) }, rigOf: () => rig });
    expect(bare.get(MODEL)).toEqual({ skinned: true });
  });

  it('a rig that cannot be measured adds no key', () => {
    const noFeet = makeRig('value.bbbb.glb', [{ name: 'Hips', parent: null, t: [0, 1, 0] }]);
    const gait = new GaitFacts({ clips: [WALK, RUN], base: { get: () => undefined }, rigOf: () => noFeet, bind: (clip) => bindByName(clipOf(clip, 'absolute', 1, [{ bone: 'Hips', prop: 'position', times: [0], values: [0, 1, 0] }]), noFeet) });
    expect(gait.get('value.bbbb.glb')).toBe(undefined);
    expect(gait.measures).toBe([WALK, RUN].length);
    gait.get('value.bbbb.glb');
    expect(gait.measures).toBe([WALK, RUN].length);
  });

  it('withGaitFacts wraps an AssetFactsPort: get through the provider, placeBake untouched', async () => {
    const bake = { place: 'x' } as never;
    const port = withGaitFacts({ get: () => ({ skinned: true }), placeBake: () => Promise.resolve(bake) }, { clips: [WALK, RUN], rigOf: () => rig, bind: (clip) => (clip === WALK ? bound(rig, 1, walkTracks(1, 0.6, 0.15), WALK) : null) });
    expect(port.get(MODEL)!.gait![WALK]).toBeCloseTo(1.2, 2);
    expect(await port.placeBake('x')).toBe(bake);
    expect(port.gait.measures).toBe(1);
  });
});
