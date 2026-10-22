// Dynamic light selection (docs/design/rendering.md §8.3; docs/architecture.md X-47, DR-26; migration plan Q20; WP R1b).
//
// Each frame the moving and transient lights are scored by `intensity × window(dCam) / max(dCam², 1)`, lights whose sphere
// misses the frustum are left out, and the top `DYN_CAP` (16 / 8 / 4 / 2 per tier) go into the dynamic block of the light
// texture. This file tests the selection alone (no three, no texture) and holds the acceptance scene of the team torches:
//
//   "the team torches of X-47 (up to six always-on spots without shadow, scripts/player/team-glow.js:10,55) on top of a
//    wave's muzzle and fx lights: the ranking under each tier's DYN_CAP is stable from frame to frame (no torch pops in and
//    out while nothing moves) and which lights lose on `low` and `minimum` is recorded"
//
// The scene is a squad in a fight seen from the local player's eye: six operators with their chest torches (the player's own
// at z −0.7, the others at z −0.35 of their body, `team-glow.js:10,23`), the always-on runtime lights of a wave (the L
// shadowCaster's throw light, a boss glow, an ammo box, the two trader-gate lamps) and its bursts (three muzzle pops, an
// explosion, a telegraph swell), each with the intensity, radius and life of render §8.3 / system-ui.md §3.7a.7 rows 9-10.
// `torchReport` prints the outcome per tier; the same numbers are asserted below, so a change of the ranking rule shows up
// here as a failed test with the old and the new table side by side.
import { describe, expect, it } from 'vitest';
import {
  DYNAMIC_HYSTERESIS,
  DYNAMIC_LIGHTS_MAX,
  DynamicLightSelector,
  distanceWindow,
  dynamicLightScore,
  perspectiveFrom,
} from '../../../src/render/lighting/dynamic-lights.ts';
import { TIER_IDS, tierConfig, type TierId } from '../../../src/render/perf/budget.ts';

// ── a camera without three ──────────────────────────────────────────────────────────────────────────────────────────────

type V3 = readonly [number, number, number];

interface TestCamera {
  eye: V3;
  /** column-major world → view, as three's `matrixWorldInverse.elements` */
  view: number[];
  /** column-major, as three's `projectionMatrix.elements` (only [0] and [5] are read) */
  projection: number[];
  near: number;
  far: number;
}

/** a camera at `eye` looking at `target` (+Y up), 16:9, the game's 70° vertical field of view */
function camera(eye: V3, target: V3, vfovDeg = 70, aspect = 16 / 9): TestCamera {
  const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a: V3): V3 => {
    const l = Math.hypot(a[0], a[1], a[2]);
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = unit(sub(eye, target));
  const x = unit(cross([0, 1, 0], z));
  const y = cross(z, x);
  const view = [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
  const f = 1 / Math.tan((vfovDeg * Math.PI) / 360);
  const projection = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0];
  return { eye, view, projection, near: 0.1, far: 2000 };
}

// ── the fight ───────────────────────────────────────────────────────────────────────────────────────────────────────────

interface SceneLight {
  /** stable id: the order the lights were created in */
  id: number;
  name: string;
  kind: 'torch' | 'steady' | 'burst';
  position: V3;
  intensity: number;
  distance: number;
  /** bursts only: [start, end) in ms */
  life?: readonly [number, number];
}

const EYE: V3 = [0, 1.62, 0];
const LOOK_AT: V3 = [0, 1.5, -10];

/** where each operator stands (feet); the first is the local player */
const OPERATORS: ReadonlyArray<{ name: string; feet: V3 }> = [
  { name: 'own', feet: [0, 0, 0] },
  { name: 'bot-1', feet: [-2.4, 0, -3.1] },
  { name: 'bot-2', feet: [3.2, 0, -5.4] },
  { name: 'bot-3', feet: [-1.1, 0, -8.2] },
  { name: 'bot-4', feet: [4.3, 0, 2.6] },
  { name: 'bot-5', feet: [-9.5, 0, -14] },
];

/** `shadowCaster`: the player's L shadowCaster is on, so its throw light exists (it is independent of the torches) */
function fight(shadowCaster = true): SceneLight[] {
  const lights: SceneLight[] = [];
  let id = 0;
  const add = (l: Omit<SceneLight, 'id'>): void => void lights.push({ id: id++, ...l });
  // team-glow.js:10: spot, intensity 5, distance 13, at { x: 0.12, y: 1.35, z: isMe ? -0.7 : -0.35 } of the body
  for (const [i, op] of OPERATORS.entries()) {
    add({ name: `torch ${op.name}`, kind: 'torch', position: [op.feet[0] + 0.12, op.feet[1] + 1.35, op.feet[2] + (i === 0 ? -0.7 : -0.35)], intensity: 5, distance: 13 });
  }
  // always on while they exist (render §8.3)
  if (shadowCaster) add({ name: 'shadowCaster throw', kind: 'steady', position: [0.05, 1.5, -5], intensity: 30, distance: 9 });
  add({ name: 'boss glow', kind: 'steady', position: [1.5, 2.2, -19], intensity: 50, distance: 14 });
  add({ name: 'ammo box', kind: 'steady', position: [3.1, 0.4, -2.2], intensity: 1.6, distance: 5 });
  add({ name: 'trader gate (green)', kind: 'steady', position: [-6, 2.1, -11], intensity: 3, distance: 9 });
  add({ name: 'trader gate (amber)', kind: 'steady', position: [-6, 2.6, -11], intensity: 1.5, distance: 14 });
  // bursts: muzzle pops (rifle 34 r9 50 ms, shotgun 45 r10 80 ms, pistol 22 r7 60 ms), an explosion (160 r12 0.35 s), a
  // telegraph swell (26 r9)
  add({ name: 'muzzle own rifle', kind: 'burst', position: [0.22, 1.48, -0.95], intensity: 34, distance: 9, life: [200, 250] });
  add({ name: 'muzzle bot-2 shotgun', kind: 'burst', position: [3.2, 1.45, -6.2], intensity: 45, distance: 10, life: [300, 380] });
  add({ name: 'muzzle bot-5 pistol', kind: 'burst', position: [-9.5, 1.45, -14.8], intensity: 22, distance: 7, life: [320, 380] });
  add({ name: 'explosion', kind: 'burst', position: [2, 0.6, -12], intensity: 160, distance: 12, life: [500, 850] });
  add({ name: 'telegraph swell', kind: 'burst', position: [-4, 1.1, -9], intensity: 26, distance: 9, life: [600, 1300] });
  return lights;
}

const alive = (l: SceneLight, tMs: number): boolean => l.life === undefined || (tMs >= l.life[0] && tMs < l.life[1]);

/** runs one frame of the selection and returns the chosen ids, best first */
function selectFrame(selector: DynamicLightSelector, cam: TestCamera, lights: readonly SceneLight[], cap: number, tMs: number): number[] {
  selector.setView(cam.view, cam.projection, cam.near, cam.far);
  selector.begin(cap);
  for (const l of lights) if (alive(l, tMs)) selector.offer(l.id, l.id, l.position[0], l.position[1], l.position[2], l.intensity, l.distance);
  const n = selector.end();
  return Array.from(selector.refs.subarray(0, n));
}

const dCam = (l: SceneLight, eye: V3 = EYE): number => Math.hypot(l.position[0] - eye[0], l.position[1] - eye[1], l.position[2] - eye[2]);
const scoreOf = (l: SceneLight): number => dynamicLightScore(l.intensity, l.distance, dCam(l));

const DYN_CAP: Readonly<Record<TierId, number>> = { high: 16, medium: 8, low: 4, minimum: 2 };

// ── the score ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('dynamic light score (render §8.3)', () => {
  it('is intensity × window(dCam) / max(dCam², 1), with three’s cut-off window', () => {
    // three's getDistanceAttenuation window: saturate(1 − (d / cutoff)⁴)²
    expect(distanceWindow(0, 10)).toBe(1);
    expect(distanceWindow(5, 10)).toBeCloseTo((1 - 0.5 ** 4) ** 2, 15);
    expect(distanceWindow(10, 10)).toBe(0);
    expect(distanceWindow(25, 10)).toBe(0);
    // no cut-off: no window
    expect(distanceWindow(1000, 0)).toBe(1);
    expect(dynamicLightScore(45, 10, 0.5)).toBeCloseTo(45 * (1 - 0.05 ** 4) ** 2, 12);
    expect(dynamicLightScore(45, 10, 4)).toBeCloseTo((45 * (1 - 0.4 ** 4) ** 2) / 16, 12);
  });

  it('keeps ranking lights whose sphere the camera stands outside of: nearer and brighter first, never zero', () => {
    // a bot's muzzle flash 20 m away lights the ground it stands on; the camera sees that ground
    const far = dynamicLightScore(45, 10, 20);
    const farther = dynamicLightScore(45, 10, 30);
    expect(far).toBeGreaterThan(0);
    expect(farther).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(farther);
    expect(dynamicLightScore(90, 10, 20)).toBeGreaterThan(far);
    // and it never outranks the same light seen from inside its sphere
    expect(dynamicLightScore(45, 10, 9.99)).toBeGreaterThanOrEqual(far);
    // monotonic in the distance across the edge of the sphere
    let last = Number.POSITIVE_INFINITY;
    for (let d = 0; d <= 40; d += 0.25) {
      const s = dynamicLightScore(45, 10, d);
      expect(s).toBeLessThanOrEqual(last);
      last = s;
    }
    expect(dynamicLightScore(0, 10, 1)).toBe(0);
  });

  it('the caps are the tier table’s (16 / 8 / 4 / 2)', () => {
    for (const tier of TIER_IDS) expect(tierConfig(tier).dynamicLights).toBe(DYN_CAP[tier]);
    expect(DYNAMIC_LIGHTS_MAX).toBe(16);
    expect(Math.max(...TIER_IDS.map((t) => tierConfig(t).dynamicLights))).toBe(DYNAMIC_LIGHTS_MAX);
  });
});

// ── the frustum ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('dynamic light visibility', () => {
  const cam = camera([0, 1.6, 0], [0, 1.6, -10]);
  const visible = (p: V3, r: number): boolean => {
    const s = new DynamicLightSelector();
    s.setView(cam.view, cam.projection, cam.near, cam.far);
    s.begin(4);
    s.offer(1, 1, p[0], p[1], p[2], 10, r);
    return s.end() === 1;
  };

  it('reads the frustum from the camera’s matrices', () => {
    const p = perspectiveFrom(cam.projection);
    expect(p.tanHalfY).toBeCloseTo(Math.tan((35 * Math.PI) / 180), 12);
    expect(p.tanHalfX).toBeCloseTo((Math.tan((35 * Math.PI) / 180) * 16) / 9, 12);
  });

  it('keeps a light whose sphere reaches into the frustum and drops one whose sphere does not', () => {
    expect(visible([0, 1.6, -10], 5)).toBe(true);
    // behind the camera, but the camera stands inside its sphere
    expect(visible([0, 1.6, 4], 6)).toBe(true);
    // behind the camera and out of reach
    expect(visible([0, 1.6, 12], 6)).toBe(false);
    // far off to the side: outside, then with a radius that reaches the view
    expect(visible([60, 1.6, -10], 5)).toBe(false);
    expect(visible([60, 1.6, -10], 60)).toBe(true);
    // above the view
    expect(visible([0, 60, -10], 5)).toBe(false);
    // beyond the far plane
    expect(visible([0, 1.6, -2100], 50)).toBe(false);
    expect(visible([0, 1.6, -2030], 50)).toBe(true);
  });

  it('a light with no cut-off is always visible, and a dark one is never chosen', () => {
    expect(visible([500, 500, 500], 0)).toBe(true);
    const s = new DynamicLightSelector();
    s.setView(cam.view, cam.projection, cam.near, cam.far);
    s.begin(4);
    s.offer(1, 1, 0, 1.6, -3, 0, 9);
    s.offer(2, 2, 0, 1.6, -3, Number.NaN, 9);
    expect(s.end()).toBe(0);
  });
});

// ── the selection ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe('DynamicLightSelector', () => {
  const cam = camera(EYE, LOOK_AT);

  it('returns the top `cap` by score, best first, and never more than the cap or the offers', () => {
    const lights = fight().filter((l) => l.kind !== 'burst');
    for (const cap of [0, 1, 2, 4, 8, 16]) {
      const got = selectFrame(new DynamicLightSelector(), cam, lights, cap, 0);
      const want = [...lights]
        .sort((a, b) => scoreOf(b) - scoreOf(a) || a.id - b.id)
        .slice(0, cap)
        .map((l) => l.id);
      expect(got, `cap ${cap}`).toEqual(want);
    }
    // a cap above the selector's size is clamped to it
    const many = Array.from({ length: 40 }, (_, i): SceneLight => ({ id: i, name: `l${i}`, kind: 'steady', position: [0, 1.6, -2 - i * 0.2], intensity: 10, distance: 20 }));
    expect(selectFrame(new DynamicLightSelector(), cam, many, 64, 0)).toHaveLength(DYNAMIC_LIGHTS_MAX);
    expect(() => new DynamicLightSelector(0)).toThrow(RangeError);
  });

  it('breaks equal scores by creation order, whatever order the lights are offered in', () => {
    // four identical lights at the same distance from the eye; this camera's view matrix is the identity, so the four
    // view-space distances are the same number to the bit
    const origin = camera([0, 0, 0], [0, 0, -10]);
    expect(origin.view).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0, -0, -0, 1]);
    const ring: SceneLight[] = [
      [3, 0, 0],
      [-3, 0, 0],
      [0, 0, -3],
      [0, 3, 0],
    ].map((o, i) => ({ id: 10 + i, name: `ring ${i}`, kind: 'steady', position: [o[0]!, o[1]!, o[2]!], intensity: 8, distance: 12 }));
    for (const order of [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2]]) {
      const offered = order.map((i) => ring[i]!);
      const selector = new DynamicLightSelector();
      expect(selectFrame(selector, origin, offered, 2, 0)).toEqual([10, 11]);
      expect(selector.scores[0]).toBe(selector.scores[1]);
      // and the next frame, where both are incumbents, is the same
      expect(selectFrame(selector, origin, offered, 2, 16)).toEqual([10, 11]);
    }
  });

  it('gives the same selection for any offer order (no dependence on iteration or float summation order)', () => {
    const lights = fight();
    for (const tier of TIER_IDS) {
      const reference = selectFrame(new DynamicLightSelector(), cam, lights, DYN_CAP[tier], 610);
      let seed = 12345;
      for (let round = 0; round < 50; round++) {
        const shuffled = [...lights];
        for (let i = shuffled.length - 1; i > 0; i--) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const j = seed % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }
        expect(selectFrame(new DynamicLightSelector(), cam, shuffled, DYN_CAP[tier], 610), `${tier}, round ${round}`).toEqual(reference);
      }
    }
  });

  it('keeps an incumbent until a challenger beats it by the hysteresis margin', () => {
    expect(DYNAMIC_HYSTERESIS).toBeGreaterThan(1);
    expect(DYNAMIC_HYSTERESIS).toBeLessThanOrEqual(1.25);
    const selector = new DynamicLightSelector();
    const at = (id: number, z: number): SceneLight => ({ id, name: `l${id}`, kind: 'steady', position: [0, EYE[1], z], intensity: 10, distance: 30 });
    // frame 1: light 1 is nearer and wins the single slot
    expect(selectFrame(selector, cam, [at(1, -5), at(2, -5.2)], 1, 0)).toEqual([1]);
    // frame 2: light 2 is now slightly nearer; the incumbent stays
    expect(selectFrame(selector, cam, [at(1, -5), at(2, -4.9)], 1, 16)).toEqual([1]);
    // a selector with no history would have chosen light 2
    expect(selectFrame(new DynamicLightSelector(), cam, [at(1, -5), at(2, -4.9)], 1, 16)).toEqual([2]);
    // frame 3: light 2 is clearly nearer; it takes over, and then it is the one that stays
    expect(selectFrame(selector, cam, [at(1, -5), at(2, -4)], 1, 32)).toEqual([2]);
    expect(selectFrame(selector, cam, [at(1, -4.9), at(2, -5)], 1, 48)).toEqual([2]);
    // an incumbent that is gone, dark or out of view holds nothing
    expect(selectFrame(selector, cam, [at(1, -5)], 1, 64)).toEqual([1]);
    // `reset` forgets the history (a place change)
    selector.reset();
    expect(selectFrame(selector, cam, [at(1, -5), at(2, -4.9)], 1, 80)).toEqual([2]);
  });

  it('allocates nothing per frame', () => {
    const selector = new DynamicLightSelector();
    const refs = selector.refs;
    const lights = fight();
    for (let frame = 0; frame < 50; frame++) selectFrame(selector, cam, lights, 8, frame * 16);
    expect(selector.refs).toBe(refs);
    expect(selector.refs).toHaveLength(DYNAMIC_LIGHTS_MAX);
  });
});

// ── the team torches (X-47, DR-26, Q20) ─────────────────────────────────────────────────────────────────────────────────

interface TierOutcome {
  tier: TierId;
  cap: number;
  /** names chosen with only the always-on lights alive, best first */
  steady: string[];
  /** torches that are not chosen in that state */
  torchesLostSteady: string[];
  /** per burst: which chosen lights it pushes out while it is alive (alone, on top of the steady set) */
  bursts: Array<{ burst: string; chosen: boolean; displaces: string[] }>;
}

function torchOutcome(tier: TierId, shadowCaster = true): TierOutcome {
  const cam = camera(EYE, LOOK_AT);
  const cap = DYN_CAP[tier];
  const lights = fight(shadowCaster);
  const name = (id: number): string => lights[id]!.name;
  const steadyLights = lights.filter((l) => l.kind !== 'burst');
  const steady = selectFrame(new DynamicLightSelector(), cam, steadyLights, cap, 0);
  const torches = lights.filter((l) => l.kind === 'torch');
  const bursts = lights
    .filter((l) => l.kind === 'burst')
    .map((b) => {
      const selector = new DynamicLightSelector();
      selectFrame(selector, cam, steadyLights, cap, 0);
      // the burst arrives while the steady set holds its slots: the incumbents have their hysteresis
      const withBurst = selectFrame(selector, cam, [...steadyLights, { ...b, life: [0, 1] }], cap, 0);
      return { burst: b.name, chosen: withBurst.includes(b.id), displaces: steady.filter((id) => !withBurst.includes(id)).map(name) };
    });
  return { tier, cap, steady: steady.map(name), torchesLostSteady: torches.filter((t) => !steady.includes(t.id)).map((t) => t.name), bursts };
}

function torchReport(): string {
  const lights = fight();
  const lines: string[] = ['[r1b] team torches under DYN_CAP (X-47, DR-26, Q20)', '  light                      I    r   dCam   score'];
  for (const l of [...lights].sort((a, b) => scoreOf(b) - scoreOf(a))) {
    lines.push(`  ${l.name.padEnd(24)} ${String(l.intensity).padStart(5)} ${String(l.distance).padStart(4)} ${dCam(l).toFixed(2).padStart(6)} ${scoreOf(l).toFixed(4).padStart(8)}`);
  }
  for (const shadowCaster of [true, false]) {
    lines.push(shadowCaster ? '  with the L shadowCaster on (its throw light exists):' : '  with the L shadowCaster off:');
    for (const tier of TIER_IDS) {
      const o = torchOutcome(tier, shadowCaster);
      lines.push(`  ${tier} (cap ${o.cap}): steady set = ${o.steady.join(', ')}`);
      lines.push(`    torches not drawn while nothing fires: ${o.torchesLostSteady.join(', ') || 'none'}`);
      for (const b of o.bursts) lines.push(`    ${b.burst}: ${b.chosen ? `drawn, pushes out ${b.displaces.join(', ') || 'nothing'}` : 'not drawn'}`);
    }
  }
  return lines.join('\n');
}

describe('team torches under each tier’s DYN_CAP (X-47, DR-26, Q20)', () => {
  const cam = camera(EYE, LOOK_AT);

  it('the scene is the one the acceptance names: six torches, a wave’s runtime lights and its bursts', () => {
    const lights = fight();
    expect(lights.filter((l) => l.kind === 'torch')).toHaveLength(6);
    expect(lights.filter((l) => l.kind === 'torch').every((l) => l.intensity === 5 && l.distance === 13)).toBe(true);
    expect(lights.filter((l) => l.kind === 'burst').map((l) => l.intensity)).toEqual([34, 45, 22, 160, 26]);
    // more lights than any cap: every tier has to choose
    expect(lights.length).toBe(16);
    expect(lights.filter((l) => l.kind !== 'burst').length).toBe(11);
    console.log(torchReport());
  });

  for (const tier of TIER_IDS) {
    const cap = DYN_CAP[tier];

    it(`${tier} (cap ${cap}): with unchanged inputs the selection is identical frame after frame`, () => {
      const lights = fight();
      const selector = new DynamicLightSelector();
      // every state of the timeline, held for 120 frames each
      for (const tMs of [0, 210, 310, 330, 520, 610, 700, 900, 2000]) {
        const first = selectFrame(selector, cam, lights, cap, tMs);
        expect(first.length).toBe(Math.min(cap, lights.filter((l) => alive(l, tMs)).length));
        for (let frame = 1; frame < 120; frame++) {
          expect(selectFrame(selector, cam, lights, cap, tMs), `${tier}, t ${tMs} ms, frame ${frame}`).toEqual(first);
        }
      }
    });

    it(`${tier} (cap ${cap}): over a wave the chosen set changes only on a frame where a burst starts or ends`, () => {
      const lights = fight();
      const selector = new DynamicLightSelector();
      const edges = new Set<number>();
      for (const l of lights) if (l.life !== undefined) for (const t of l.life) edges.add(t);
      let previous: number[] | null = null;
      let previousT = 0;
      let changes = 0;
      const torchIds = new Set(lights.filter((l) => l.kind === 'torch').map((l) => l.id));
      for (let tMs = 0; tMs <= 1500; tMs += 10) {
        const now = selectFrame(selector, cam, lights, cap, tMs);
        if (previous !== null) {
          const same = now.length === previous.length && now.every((id) => previous!.includes(id));
          if (!same) {
            changes++;
            // an edge lies in (previousT, tMs]
            const edge = [...edges].some((e) => e > previousT && e <= tMs);
            expect(edge, `${tier}: the set changed at ${tMs} ms with no burst starting or ending`).toBe(true);
          } else {
            // no torch entered or left
            for (const id of torchIds) expect(now.includes(id)).toBe(previous.includes(id));
          }
        }
        previous = now;
        previousT = tMs;
      }
      // the bursts do reach the list on every tier that has room for them
      if (cap >= 4) expect(changes).toBeGreaterThan(0);
    });

    it(`${tier} (cap ${cap}): a camera that sways a few centimetres does not make a torch pop in or out`, () => {
      const lights = fight().filter((l) => l.kind !== 'burst');
      const selector = new DynamicLightSelector();
      const still = selectFrame(selector, cam, lights, cap, 0);
      for (let frame = 1; frame <= 600; frame++) {
        // walking bob 0.018 m vertical, 0.016 m side (camera.yml), plus breathing
        const sway: V3 = [EYE[0] + 0.016 * Math.sin(frame * 0.21), EYE[1] + 0.018 * Math.sin(frame * 0.42), EYE[2] + 0.01 * Math.sin(frame * 0.13)];
        const now = selectFrame(selector, camera(sway, [sway[0], sway[1] - 0.12, sway[2] - 10]), lights, cap, frame * 16);
        expect(new Set(now), `${tier}, frame ${frame}`).toEqual(new Set(still));
      }
    });
  }

  it('torches rank like every other light: no exemption, and no torch outranks a brighter light at the same place', () => {
    const selector = new DynamicLightSelector();
    const torch: SceneLight = { id: 1, name: 'torch', kind: 'torch', position: [0, 1.4, -4], intensity: 5, distance: 13 };
    const flash: SceneLight = { id: 2, name: 'flash', kind: 'burst', position: [0, 1.4, -4], intensity: 34, distance: 9 };
    expect(selectFrame(selector, cam, [torch, flash], 1, 0)).toEqual([2]);
    // torch against muzzle flash at typical distances: the flash's 22-45 against the torch's 5
    expect(dynamicLightScore(34, 9, 4) / dynamicLightScore(5, 13, 4)).toBeGreaterThan(6);
    expect(dynamicLightScore(22, 7, 4) / dynamicLightScore(5, 13, 4)).toBeGreaterThan(3);
    // the player's own torch (0.75 m from the eye) is worth a rifle flash at about 2.6 m
    expect(dynamicLightScore(5, 13, 0.75)).toBeGreaterThan(dynamicLightScore(34, 9, 2.7));
    expect(dynamicLightScore(5, 13, 0.75)).toBeLessThan(dynamicLightScore(34, 9, 2.5));
  });

  it('records which lights lose: every torch is drawn on high, and the two low tiers drop the far ones', () => {
    const high = torchOutcome('high');
    const medium = torchOutcome('medium');
    const low = torchOutcome('low');
    const minimum = torchOutcome('minimum');

    // high (16): the eleven always-on lights all fit, and all five bursts of the wave fit on top of them
    expect(high.torchesLostSteady).toEqual([]);
    expect(high.steady).toHaveLength(11);
    expect(high.bursts.every((b) => b.chosen && b.displaces.length === 0)).toBe(true);

    // medium (8): the torch of the teammate 17 m away loses while nothing fires (the camera stands outside its 13 m
    // sphere), with the boss glow and the green trader lamp
    expect(medium.steady).toEqual(['torch own', 'shadowCaster throw', 'torch bot-1', 'torch bot-4', 'torch bot-2', 'torch bot-3', 'ammo box', 'trader gate (amber)']);
    expect(medium.torchesLostSteady).toEqual(['torch bot-5']);

    // low (4): the player's own torch, the shadowCaster's throw light and the two nearest teammates' torches
    expect(low.steady).toEqual(['torch own', 'shadowCaster throw', 'torch bot-1', 'torch bot-4']);
    expect(low.torchesLostSteady).toEqual(['torch bot-2', 'torch bot-3', 'torch bot-5']);

    // minimum (2): the player's own torch and the throw light; no teammate's torch is drawn
    expect(minimum.steady).toEqual(['torch own', 'shadowCaster throw']);
    expect(minimum.torchesLostSteady).toEqual(['torch bot-1', 'torch bot-2', 'torch bot-3', 'torch bot-4', 'torch bot-5']);

    // A burst the camera stands inside the sphere of (the player's own muzzle flash, a teammate's 7 m away) pushes out the
    // dimmest chosen light: a teammate's torch on `low`, the throw light on `minimum`. A burst the camera stands outside
    // the sphere of (the explosion 12.2 m away with r 12, the telegraph, the far pistol) scores in the far band and is
    // not drawn on `low` and `minimum` at all, and on `medium` only when the shadowCaster is off.
    const lostTo = (o: TierOutcome, burst: string): string[] => o.bursts.find((b) => b.burst === burst)!.displaces;
    const drawn = (o: TierOutcome, burst: string): boolean => o.bursts.find((b) => b.burst === burst)!.chosen;
    expect(lostTo(medium, 'muzzle own rifle')).toEqual(['trader gate (amber)']);
    expect(lostTo(low, 'muzzle own rifle')).toEqual(['torch bot-4']);
    expect(lostTo(low, 'muzzle bot-2 shotgun')).toEqual(['torch bot-4']);
    expect(lostTo(minimum, 'muzzle own rifle')).toEqual(['shadowCaster throw']);
    expect(drawn(minimum, 'muzzle bot-2 shotgun')).toBe(false);
    for (const o of [medium, low, minimum]) {
      for (const burst of ['muzzle bot-5 pistol', 'explosion', 'telegraph swell']) expect(drawn(o, burst), `${o.tier}: ${burst}`).toBe(false);
    }
    // the player's own torch (0.76 m from the eye, score 5.0) loses to nothing in this fight, on any tier
    for (const o of [high, medium, low, minimum]) {
      for (const b of o.bursts) expect(b.displaces, `${o.tier}: ${b.burst}`).not.toContain('torch own');
    }

    // with the L shadowCaster off there is no throw light: one more teammate's torch is drawn on the two low tiers
    const lowOff = torchOutcome('low', false);
    const minimumOff = torchOutcome('minimum', false);
    expect(torchOutcome('high', false).torchesLostSteady).toEqual([]);
    expect(torchOutcome('medium', false).torchesLostSteady).toEqual(['torch bot-5']);
    expect(lowOff.steady).toEqual(['torch own', 'torch bot-1', 'torch bot-4', 'torch bot-2']);
    expect(lowOff.torchesLostSteady).toEqual(['torch bot-3', 'torch bot-5']);
    expect(minimumOff.steady).toEqual(['torch own', 'torch bot-1']);
    expect(minimumOff.torchesLostSteady).toEqual(['torch bot-2', 'torch bot-3', 'torch bot-4', 'torch bot-5']);
    expect(lostTo(lowOff, 'muzzle own rifle')).toEqual(['torch bot-2']);
    expect(lostTo(minimumOff, 'muzzle own rifle')).toEqual(['torch bot-1']);
    expect(lostTo(minimumOff, 'muzzle bot-2 shotgun')).toEqual(['torch bot-1']);
  });
});
