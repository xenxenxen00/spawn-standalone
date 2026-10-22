// MA3: the mixer's sampling cost and its steady-state allocations (docs/design/motion-physics-nav.md §3.5.7): 48 enemies
// × 24 bones × 3 channels per presentation frame within 0.5 ms, with nothing allocated per frame.
//
// Timing on a shared machine is noisy, so the budget is asserted on the best frame of the run (the cost without
// interference; an algorithmic regression moves it, a busy neighbour does not) and the median is reported.
// SS_PERF_SLACK scales the budget for a slower runner.
import { describe, expect, it } from 'vitest';
import type { CompiledClip } from '../../../src/compat/motion/clip.ts';
import { ClipRegistry } from '../../../src/compat/motion/clip-registry.ts';
import { Mixer } from '../../../src/compat/motion/mixer.ts';
import { Pose } from '../../../src/compat/motion/pose.ts';
import { HUMANOID_BONES, clipOf, humanoidRig, quat, type TrackDef } from './fakes/rig.ts';

const DT = 1 / 30;
const ROWS = 48;
const BUDGET_MS = 0.5 * Number(process.env['SS_PERF_SLACK'] ?? '1');

/** a library-style clip: a rotation track per bone at 30 fps over one second, plus the hips translation */
function libraryClip(id: string, phase: number, rigId: string): CompiledClip {
  const times = Array.from({ length: 31 }, (_, i) => i / 30);
  const tracks: TrackDef[] = HUMANOID_BONES.map(([bone], b) => ({
    bone,
    prop: 'rotation' as const,
    times,
    values: times.flatMap((t) => quat(30 * Math.sin(2 * Math.PI * t + b + phase), 10 * Math.cos(2 * Math.PI * t + b), 5 * b * t)),
  }));
  tracks.push({ bone: 'Hips', prop: 'position', times, values: times.flatMap((t) => [0, 0.97 + 0.03 * Math.sin(4 * Math.PI * t + phase), 0]) });
  return clipOf(id, 'absolute', 1, tracks, { sourceRig: rigId });
}

/** an authored-style clip: deltas on the upper body, keys 0.1 s apart */
function authoredClip(id: string): CompiledClip {
  const times = Array.from({ length: 10 }, (_, i) => i / 10);
  const bones = ['Spine02', 'Spine01', 'Spine', 'neck', 'Head', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'];
  return clipOf(
    id,
    'delta',
    0.9,
    bones.map((bone, b) => ({ bone, prop: 'rotation' as const, times, values: times.flatMap((t) => quat(40 * t * (b % 3), 20 * t, -15 * t)) })),
  );
}

function scene() {
  const rig = humanoidRig('bench.rig');
  const registry = new ClipRegistry();
  const walk = libraryClip('cdn/clip-walk-loop.glb', 0, rig.id);
  const idle = libraryClip('cdn/clip-idle-loop.glb', 1.3, rig.id);
  registry.setLibrary({ get: (a) => (a === walk.id ? walk : a === idle.id ? idle : undefined) });
  registry.addFunctionClip('bench#swipe', authoredClip('bench#swipe'));
  const rows = Array.from({ length: ROWS }, (_, i) => {
    const mixer = new Mixer(`enemy-${i}`, rig, { registry });
    mixer.write('loco', { clip: walk.id, loop: 'loop', speed: 0.8 + (i % 7) * 0.1, weight: i % 2 === 0 ? 1 : 0.001, blendIn: 0.2 }, 0);
    mixer.write('idle', { clip: idle.id, loop: 'loop', weight: 0.001, blendIn: 0.2 }, 0);
    mixer.write('act', { clip: 'bench#swipe', loop: 'loop', speed: 1.1, weight: 1, blendIn: 0.08 }, 0);
    return { mixer, pose: new Pose(rig) };
  });
  const frame = (alpha: number): void => {
    for (let i = 0; i < ROWS; i++) rows[i]!.mixer.evaluate(rows[i]!.pose, alpha);
  };
  const tick = (): void => {
    for (let i = 0; i < ROWS; i++) rows[i]!.mixer.advanceTick(DT);
  };
  return { rig, rows, frame, tick };
}

describe('mixer cost (motion §3.5.7)', () => {
  it(`evaluates ${ROWS} rows × 24 bones × 3 channels within ${BUDGET_MS} ms per frame`, { timeout: 60_000 }, () => {
    const s = scene();
    // the scene is what the budget names: every row has three contributing channels over 24 bones
    expect(s.rig.bones.length).toBe(24);
    s.tick();
    s.frame(0);
    expect(s.rows.every((r) => r.pose.dirty.every((d) => d === 1))).toBe(true);
    for (let f = 0; f < 400; f++) {
      if (f % 2 === 0) s.tick();
      s.frame((f % 2) * 0.5);
    }
    const samples: number[] = [];
    for (let f = 0; f < 400; f++) {
      if (f % 2 === 0) s.tick();
      const t0 = performance.now();
      s.frame((f % 2) * 0.5);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const best = samples[0]!;
    const median = samples[samples.length >> 1]!;
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    console.info(`[mixer bench] ${ROWS} rows × 24 bones × 3 channels: best ${best.toFixed(3)} ms, median ${median.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms per frame (budget ${BUDGET_MS} ms)`);
    if (median > BUDGET_MS) console.warn(`[mixer bench] the median frame (${median.toFixed(3)} ms) is over the ${BUDGET_MS} ms budget on this run (a busy machine?)`);
    expect(best).toBeLessThanOrEqual(BUDGET_MS);
  });

  it('allocates nothing in the steady state: evaluate and advanceTick reuse the mixer’s own buffers', { timeout: 60_000 }, () => {
    const s = scene();
    for (let f = 0; f < 600; f++) {
      if (f % 2 === 0) s.tick();
      s.frame((f % 2) * 0.5);
    }
    const FRAMES = 2000; // 96,000 evaluate calls and 48,000 tick calls per window
    // heap growth over a window with no collection in it is what the window allocated. A loop that allocates grows every
    // window (or collects in it); one that does not leaves every window flat. The median of five windows ignores a
    // collection left over from the set-up.
    const moved: number[] = [];
    for (let window = 0; window < 5; window++) {
      const before = process.memoryUsage().heapUsed;
      for (let f = 0; f < FRAMES; f++) {
        if (f % 2 === 0) s.tick();
        s.frame((f % 2) * 0.5);
      }
      moved.push(Math.abs(process.memoryUsage().heapUsed - before));
    }
    moved.sort((a, b) => a - b);
    // one 16-byte object per evaluate call would be 1.5 MB per window; process.memoryUsage itself accounts for a few KB
    expect(moved[2]!, `heap moved per window: ${moved.join(', ')} bytes`).toBeLessThan(256 * 1024);
  });
});
