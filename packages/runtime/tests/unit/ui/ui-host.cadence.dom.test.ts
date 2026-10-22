import { LEGACY_UI_CONFIG } from './fakes.ts';
// UiHost cadence cap per rolling second (io §3.4, X-39: "at most 60 Hz whatever the display refresh", 30 Hz with setCadence(30)).
// tests/perf/ui-cpu.spec.ts drives a 144 Hz rAF (frame × 1000 / 144) and fails on more than 60 renders in any rolling second,
// measured with its own `maxInWindow` (end − start ≥ 1000 opens a new window). These deterministic fake-clock tests replay that
// exact stream and the 60/120/144/240 Hz displays with and without frame jitter, measure with the same metric, and hold the rate
// up (no starving at 60 Hz). Negative controls: the accumulator-only schedule (the tolerance without the window guard) does
// produce 61 on the perf spec's stream, and the metric itself flags a 61-render second.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UiHost } from '../../../src/runtime/ui/ui-host.ts';
import { fakeRuntime, renderString, scriptedUi, type ScriptedUi } from './fakes.ts';

let container: HTMLElement;
let host: UiHost | null = null;
let ui: ScriptedUi;

function makeHost(): UiHost {
  host = new UiHost(container, ui, { config: LEGACY_UI_CONFIG, runtime: fakeRuntime(), actions: { inject: () => true }, rewrite: (s) => s, log: () => {} });
  host.mount();
  return host;
}

/** the perf spec's metric, verbatim (tests/perf/ui-cpu.spec.ts maxInWindow) */
function maxInWindow(sortedTimes: readonly number[], windowMs: number): number {
  let start = 0;
  let max = 0;
  for (let end = 0; end < sortedTimes.length; end++) {
    while (sortedTimes[end]! - sortedTimes[start]! >= windowMs) start++;
    max = Math.max(max, end - start + 1);
  }
  return max;
}

/** feeds `stamps` to the host; returns the timestamps of the frames that rendered */
function renderTimes(h: UiHost, stamps: readonly number[]): number[] {
  const out: number[] = [];
  for (const t of stamps) {
    const before = ui.calls;
    h.frame(t);
    if (ui.calls > before) out.push(t);
  }
  return out;
}

/** `frames` rAF timestamps of an `hz` display from t0, each moved by `jitter(i)` ms */
function stream(hz: number, frames: number, t0 = 0, jitter: (i: number) => number = () => 0): number[] {
  return Array.from({ length: frames }, (_, i) => t0 + (i * 1000) / hz + jitter(i));
}

/** mulberry32: a seeded jitter source, so every run replays the same frames */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** the schedule before the window guard (accumulator + 3 ms tolerance), kept as the negative control */
function accumulatorOnly(stamps: readonly number[], hz = 60): number[] {
  const interval = 1000 / hz;
  const out: number[] = [];
  let acc = 0;
  let prev: number | null = null;
  for (const t of stamps) {
    if (prev === null) {
      prev = t;
      out.push(t);
      continue;
    }
    const dt = t - prev;
    prev = t;
    if (dt > 0) acc += dt;
    if (acc + 3 < interval) continue;
    acc = Math.min(acc - interval, 3);
    out.push(t);
  }
  return out;
}

/** the perf spec's run: 20 mock screens + the WAVE HUD, 144 frames each, at frame × 1000 / 144 */
const SPEC_STREAM = Array.from({ length: 21 * 144 }, (_, frame) => (frame * 1000) / 144);

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  ui = scriptedUi(renderString({ body: '<div id="hud">x</div>' }));
});

afterEach(() => {
  host?.dispose();
  host = null;
  document.body.replaceChildren();
});

describe('negative controls', () => {
  it('the accumulator-only schedule renders 61 times in one rolling second of the perf spec stream', () => {
    expect(maxInWindow(accumulatorOnly(SPEC_STREAM), 1000)).toBe(61);
  });

  it('the metric flags 61 renders inside one second and passes 61 renders spanning a full second', () => {
    expect(maxInWindow(Array.from({ length: 61 }, (_, i) => i * 16.65), 1000)).toBe(61);
    expect(maxInWindow(Array.from({ length: 61 }, (_, i) => i * 50), 3000)).toBe(60); // integers, no float noise
  });
});

describe('cadence ≤ 60 renders in any rolling second (X-39)', () => {
  it('the perf spec stream (144 Hz rAF, 21 screens): never above 60 in any rolling second, and close to 60 Hz', () => {
    const times = renderTimes(makeHost(), SPEC_STREAM);
    expect(maxInWindow(times, 1000)).toBeLessThanOrEqual(60);
    expect(times.length / 21).toBeGreaterThanOrEqual(59.5);
  });

  for (const hz of [120, 144, 240]) {
    it(`${hz} Hz rAF, steady, ±1 ms alternating and ±2 ms random jitter: ≤ 60 per rolling second, near 60 Hz on average`, () => {
      const rnd = seeded(hz);
      // [label, jitter, average-rate floor]: steady frames reach the cap; jittered frames lose a few to the 3 ms tolerance
      const cases: Array<[string, (i: number) => number, number]> = [
        ['steady', () => 0, 59.5],
        ['alternating', (i) => (i % 2 === 0 ? 1 : -1), 57],
        ['random', () => (rnd() - 0.5) * 4, 57],
      ];
      for (const [label, jitter, floor] of cases) {
        host?.dispose();
        const times = renderTimes(makeHost(), stream(hz, hz * 20, 0, jitter));
        expect(maxInWindow(times, 1000), `${hz} Hz ${label}`).toBeLessThanOrEqual(60);
        expect(times.length / 20, `${hz} Hz ${label}`).toBeGreaterThanOrEqual(floor);
        for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!, `${hz} Hz ${label}`).toBeGreaterThan(9);
      }
    });
  }

  it('odd display rates and odd jitter (75, 90, 165 Hz; random ±3 ms) never exceed the cap', () => {
    for (const hz of [75, 90, 165, 59.94, 60.05]) {
      const rnd = seeded(Math.round(hz * 100));
      host?.dispose();
      const times = renderTimes(makeHost(), stream(hz, Math.round(hz * 20), 0, () => (rnd() - 0.5) * 6));
      expect(maxInWindow(times, 1000), `${hz} Hz`).toBeLessThanOrEqual(60);
    }
  });
});

describe('no starving at 60 Hz', () => {
  it('renders every frame of a steady or ±1 ms alternating 60 Hz rAF (a pair exactly one second apart is no excess)', () => {
    const steady = stream(60, 60 * 20);
    expect(renderTimes(makeHost(), steady)).toHaveLength(steady.length);
    host?.dispose();
    const alt = stream(60, 60 * 20, 0, (i) => (i % 2 === 0 ? 1 : -1));
    const times = renderTimes(makeHost(), alt);
    expect(times).toHaveLength(alt.length);
    // exact window arithmetic (the stream is periodic, so float noise is the only thing below 1000)
    expect(maxInWindow(times, 1000 - 1e-6)).toBeLessThanOrEqual(60);
  });

  it('a 60 Hz rAF with random ±2 ms jitter stays at or below 60 per rolling second and keeps ≥ 57 Hz', () => {
    const rnd = seeded(60);
    const times = renderTimes(makeHost(), stream(60, 60 * 20, 0, () => (rnd() - 0.5) * 4));
    expect(maxInWindow(times, 1000)).toBeLessThanOrEqual(60);
    expect(times.length / 20).toBeGreaterThanOrEqual(57);
  });

  it('a slightly fast display (60.05 Hz) drops one frame in 61, the fewest the cap allows', () => {
    // 61 consecutive frames span 60 × 16.653 ms < 1000 ms, so at most 60 of any 61 may render
    const times = renderTimes(makeHost(), stream(60.05, 1201));
    expect(maxInWindow(times, 1000)).toBeLessThanOrEqual(60);
    expect(times.length).toBeGreaterThanOrEqual(Math.floor((1201 * 60) / 61) - 1);
  });
});

describe('setCadence and time bases', () => {
  it('30 Hz at a 144 Hz rAF: ≤ 30 per rolling second, ≥ 29 Hz, and the switch from 60 does not freeze the HUD', () => {
    const h = makeHost();
    renderTimes(h, stream(144, 144 * 2));
    h.setCadence(30);
    const times = renderTimes(h, stream(144, 144 * 10, 2000));
    expect(maxInWindow(times, 1000)).toBeLessThanOrEqual(30);
    expect(times.length / 10).toBeGreaterThanOrEqual(29);
    expect(times[0]! - 2000).toBeLessThan(40); // first render within one 30 Hz interval of the switch, not after the last second ages out
  });

  it('back to 60 Hz: the second straddling the switch stays at or below 60', () => {
    const h = makeHost();
    h.setCadence(30);
    const before = renderTimes(h, stream(144, 144 * 2));
    h.setCadence(60);
    const after = renderTimes(h, stream(144, 144 * 3, 2000));
    expect(maxInWindow([...before, ...after], 1000)).toBeLessThanOrEqual(60);
    expect(after.length / 3).toBeGreaterThanOrEqual(58);
  });

  it('a timestamp that jumps back (a new time base) does not hold the HUD back for the old second', () => {
    const h = makeHost();
    renderTimes(h, stream(60, 120, 50_000));
    const times = renderTimes(h, stream(60, 60, 100));
    expect(times.length).toBeGreaterThanOrEqual(58);
  });
});
