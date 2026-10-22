// FlashGuard (docs/design/rendering.md §8.5; docs/analysis/system-ui.md §3.7a.7; docs/architecture.md X-23; WP R1b).
//
// The acceptance test: "the 14 source waveforms of system-ui.md §3.7a.7 replayed at their live cadences give ≤ 3 flashes in
// any 1 s window with the guard on, and an identical output with it off."
//
// Each source row of that table is a generator here, written from the row's live waveform (the numbers are the table's), on
// the cadence the row states: the 100 ms place / Director tick (`power.js`, `lights.js`), every third tick of the 30 Hz sim
// (`flicker.js`, 10 Hz), the 30 Hz sim (shots, blasts, hits). The guard runs once per rendered frame after the writers, so a
// replay steps a frame clock (60 fps, and 30 and 144 fps too) and feeds the channel the value the writer last wrote.
//
// A flash is counted the way the table counts it (WCAG 2.3.1): a pair of opposing changes of the light multiplier of at
// least 0.1. `countChanges` walks the output, remembers the last extreme and records a change each time the output has moved
// 0.1 away from it against the previous change's direction; flashes in a window = pairs of such changes.
//
// Rows 13 and 14 have no light channel and are not replayed: row 13 is the HUD's CSS opacity pulses (≤ 0.63 per second as
// authored, "none needed", stopped by reduce motion), row 14 is the menu backdrop video (its content was never analysed; the
// port shows a still frame, system-ui.md §3.7a.7 row 14). Neither passes through a FlashChannel.
//
// Row 11 under the guard: the fx interpreter evaluates `flick(hz > 3, amt)` inside `light()` as the constant 1 while
// reduce-flashing is on (system-ui.md row 11; R10's part), so what reaches the channel is the un-modulated pop. The row is
// replayed both ways: with the modulation for "identical with the guard off", without it for the flash limit.
import { describe, expect, it } from 'vitest';
import { DEADBAND, FADE_S, MIN_REVERSAL_MS, createFlashGuard, type FlashChannel } from '../../../src/render/lighting/flash-guard.ts';

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a deterministic hash of a number to [0, 1), standing in for the scripts' `hash()` */
function hash(n: number, salt = 0): number {
  const x = Math.sin(n * 127.1 + salt * 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

/** the value a writer on a fixed cadence last wrote at time `tMs`; `write(k)` is its k-th write (k = 0 at t = 0) */
function onCadence(periodMs: number, write: (tick: number, tMs: number) => number): (tMs: number) => number {
  let last = -1;
  let value = 0;
  return (tMs) => {
    const tick = Math.floor(tMs / periodMs + 1e-9);
    while (last < tick) {
      last++;
      value = write(last, last * periodMs);
    }
    return value;
  };
}

interface Replay {
  times: number[];
  input: number[];
  output: number[];
}

/** steps a frame clock and runs `source` through `channel` */
function replay(source: (tMs: number) => number, channel: FlashChannel, durationMs: number, fps: number): Replay {
  const out: Replay = { times: [], input: [], output: [] };
  const dt = 1 / fps;
  for (let frame = 0; frame * dt * 1000 <= durationMs; frame++) {
    const t = frame * dt * 1000;
    const target = source(t);
    out.times.push(t);
    out.input.push(target);
    out.output.push(channel.apply(target, t, dt));
  }
  return out;
}

/** times at which the series completed a change of at least `threshold` against the direction of the previous one */
function countChanges(times: readonly number[], values: readonly number[], threshold: number): number[] {
  const changes: number[] = [];
  let dir = 0;
  let extreme = values[0] ?? 0;
  let low = extreme;
  let high = extreme;
  for (let i = 1; i < values.length; i++) {
    const v = values[i]!;
    if (dir === 0) {
      // no change yet: either direction counts, measured from the range seen so far
      low = Math.min(low, v);
      high = Math.max(high, v);
      if (v - low >= threshold) {
        dir = 1;
        extreme = v;
        changes.push(times[i]!);
      } else if (high - v >= threshold) {
        dir = -1;
        extreme = v;
        changes.push(times[i]!);
      }
    } else if (dir === 1) {
      if (v > extreme) extreme = v;
      else if (extreme - v >= threshold) {
        dir = -1;
        extreme = v;
        changes.push(times[i]!);
      }
    } else {
      if (v < extreme) extreme = v;
      else if (v - extreme >= threshold) {
        dir = 1;
        extreme = v;
        changes.push(times[i]!);
      }
    }
  }
  return changes;
}

/** the largest number of flashes (pairs of opposing changes) in any window of `windowMs` */
function worstFlashWindow(changes: readonly number[], windowMs = 1000): number {
  let worst = 0;
  let start = 0;
  for (let end = 0; end < changes.length; end++) {
    while (changes[end]! - changes[start]! >= windowMs) start++;
    worst = Math.max(worst, Math.floor((end - start + 1) / 2));
  }
  return worst;
}

// ── the source rows of system-ui.md §3.7a.7 ─────────────────────────────────────────────────────────────────────────────

interface Source {
  row: number;
  name: string;
  /** the authored value the channel is created with */
  base: number;
  durationMs: number;
  /** the live waveform */
  live(seed: number): (tMs: number) => number;
  /** what reaches the channel while reduce-flashing is on, when another package changes the source then (row 11) */
  guarded?(seed: number): (tMs: number) => number;
}

const TICK = 100; // place and Director tick
const FLICKER_MS = 100; // flicker.js: every third tick of the 30 Hz sim
const SIM_MS = 1000 / 30;

/** row 1: a flip every 60-240 ms, seen on the 100 ms tick; k = 0.08 (p .4) / 0.4 (p .2) / 1 (p .4) */
function powerBlink(r: () => number): (tick: number, tMs: number) => number {
  let k = 1;
  let nextFlip = 0;
  return (_tick, tMs) => {
    if (tMs >= nextFlip) {
      const p = r();
      k = p < 0.4 ? 0.08 : p < 0.6 ? 0.4 : 1;
      nextFlip = tMs + 60 + 180 * r();
    }
    return k;
  };
}

const SOURCES: Source[] = [
  {
    row: 1,
    name: 'power-grid blink on a lamp',
    base: 20,
    durationMs: 5000,
    live: (seed) => {
      const blink = powerBlink(rng(seed));
      return onCadence(TICK, (tick, t) => 20 * blink(tick, t));
    },
  },
  {
    row: 1,
    name: 'power-grid blink on the ambient fill (floor 0.12)',
    base: 0.6,
    durationMs: 5000,
    live: (seed) => {
      const blink = powerBlink(rng(seed));
      return onCadence(TICK, (tick, t) => 0.6 * (0.12 + 0.88 * blink(tick, t)));
    },
  },
  {
    row: 2,
    name: 'power return',
    base: 26,
    durationMs: 3000,
    live: () => {
      // dark until 1 s, then 0, .5, .15, .8, .15, .15, .8, 1 on the 100 ms tick
      const steps = [0, 0.5, 0.15, 0.8, 0.15, 0.15, 0.8, 1];
      return onCadence(TICK, (tick) => 26 * (tick < 10 ? 0 : (steps[tick - 10] ?? 1)));
    },
  },
  {
    row: 3,
    name: 'blackout cut on a lamp',
    base: 22,
    durationMs: 3000,
    live: () => onCadence(TICK, (tick) => (tick < 10 ? 22 : 0)),
  },
  {
    row: 3,
    name: 'blackout cut on the hemisphere fill (floor 0.2)',
    base: 1.1,
    durationMs: 3000,
    live: () => onCadence(TICK, (tick) => 1.1 * (tick < 10 ? 1 : 0.2)),
  },
  {
    row: 4,
    name: 'flicker.js mode flicker',
    base: 18,
    durationMs: 20000,
    live: (seed) =>
      onCadence(FLICKER_MS, (_tick, tMs) => {
        const t = tMs / 1000;
        const slot = Math.floor(t / 2.5);
        const inStutter = hash(slot, seed) > 0.55 && t - slot * 2.5 < 0.875;
        return 18 * (inStutter ? (hash(Math.floor(18 * t), seed + 1) > 0.5 ? 1 : 0.15) : 1);
      }),
  },
  {
    row: 5,
    name: 'flicker.js mode buzz',
    base: 16,
    durationMs: 20000,
    live: (seed) =>
      onCadence(FLICKER_MS, (_tick, tMs) => {
        const t = tMs / 1000;
        return 16 * (0.85 + 0.15 * Math.sin(47 * t + seed) * Math.sin(13 * t + seed));
      }),
  },
  {
    row: 6,
    name: 'flicker.js mode dying',
    base: 14,
    durationMs: 20000,
    live: (seed) =>
      onCadence(FLICKER_MS, (_tick, tMs) => {
        const slot = Math.floor(tMs / 400);
        const h = hash(slot, seed);
        return 14 * (h > 0.62 ? 0.3 + 0.7 * hash(slot, seed + 7) : 0.04);
      }),
  },
  {
    row: 7,
    name: 'lamp death',
    base: 24,
    durationMs: 6000,
    live: (seed) => {
      // 3-6 pairs: off 0.08 after 80-300 ms, on 0.4-1.2 after 60-320 ms, then 0; seen on the 100 ms Director tick
      const r = rng(seed);
      const events: Array<[number, number]> = [];
      let t = 500;
      const pairs = 3 + Math.floor(r() * 4);
      for (let i = 0; i < pairs; i++) {
        t += 80 + 220 * r();
        events.push([t, 0.08]);
        t += 60 + 260 * r();
        events.push([t, 0.4 + 0.8 * r()]);
      }
      t += 80 + 220 * r();
      events.push([t, 0]);
      return onCadence(TICK, (_tick, tMs) => {
        let k = 1;
        for (const [at, value] of events) if (tMs >= at) k = value;
        return 24 * k;
      });
    },
  },
  {
    row: 8,
    name: 'flickerers',
    base: 20,
    durationMs: 30000,
    live: (seed) => {
      // a blip to 0.05-0.3 for 60-240 ms every 1.2-5.2 s
      const r = rng(seed);
      let next = 1200 + 4000 * r();
      let until = -1;
      let k = 1;
      return onCadence(TICK, (_tick, tMs) => {
        if (tMs >= next) {
          k = 0.05 + 0.25 * r();
          until = tMs + 60 + 180 * r();
          next = tMs + 1200 + 4000 * r();
        }
        if (until >= 0 && tMs >= until) {
          k = 1;
          until = -1;
        }
        return 20 * k;
      });
    },
  },
  ...(
    [
      ['rifle', 34, 50, 0.13],
      ['rifle at 1200 RPM (kriss-vector)', 34, 50, 0.05],
      ['shotgun', 45, 80, 0.35],
      ['pistol', 22, 60, 0.11],
    ] as const
  ).map(
    ([weapon, intensity, lifeMs, intervalS]): Source => ({
      row: 9,
      name: `muzzle light pops: ${weapon}`,
      base: intensity,
      durationMs: 6000,
      live: (seed) => {
        // one fx per shot, emitted by the 30 Hz sim; bursts of fire with pauses between
        const r = rng(seed);
        let nextShot = 200;
        let burstEnds = 200 + 1500 + 2000 * r();
        let lit = -1;
        const shots = onCadence(SIM_MS, (_tick, tMs) => {
          if (tMs >= nextShot) {
            lit = tMs + lifeMs;
            nextShot = tMs + intervalS * 1000;
            if (tMs >= burstEnds) {
              nextShot = tMs + 300 + 700 * r();
              burstEnds = nextShot + 500 + 2000 * r();
            }
          }
          return lit;
        });
        return (tMs) => (tMs < shots(tMs) ? intensity : 0);
      },
    }),
  ),
  ...(
    [
      ['explosions', 160, 350],
      ['flashbang', 260, 300],
    ] as const
  ).map(
    ([blast, intensity, lifeMs]): Source => ({
      row: 10,
      name: `${blast}, one channel per blast class`,
      base: intensity,
      durationMs: 10000,
      live: (seed) => {
        // launchers are ≥ 0.6 s apart each, but a team's stack: up to six shooters, overlaps merge into one target
        const r = rng(seed);
        const blasts: number[] = [];
        for (let shooter = 0; shooter < 6; shooter++) {
          let t = 300 + 2000 * r();
          while (t < 10000) {
            blasts.push(Math.ceil(t / SIM_MS) * SIM_MS);
            t += 600 + 1800 * r();
          }
        }
        return (tMs) => (blasts.some((at) => tMs >= at && tMs < at + lifeMs) ? intensity : 0);
      },
    }),
  ),
  {
    row: 11,
    name: 'relay-mother sparks, 14 * flick(14, .6) for 1.2 s',
    base: 14,
    durationMs: 6000,
    live: (seed) => (tMs) => (tMs % 2000 < 1200 ? 14 * flick(14, 0.6, tMs / 1000, seed) : 0),
    guarded: () => (tMs) => (tMs % 2000 < 1200 ? 14 : 0),
  },
  {
    row: 11,
    name: 'enemy flamejet, 60 * flick(14, .3) re-emitted every 0.12 s',
    base: 60,
    durationMs: 6000,
    live: (seed) => (tMs) => (tMs % 3000 < 2200 ? 60 * flick(14, 0.3, tMs / 1000, seed) : 0),
    guarded: () => (tMs) => (tMs % 3000 < 2200 ? 60 : 0),
  },
  {
    row: 11,
    name: 'relay-mother strike, 40 for 0.25 s',
    base: 40,
    durationMs: 6000,
    live: (seed) => {
      const r = rng(seed);
      const strikes: number[] = [];
      for (let t = 200; t < 6000; t += 280 + 500 * r()) strikes.push(Math.ceil(t / SIM_MS) * SIM_MS);
      return (tMs) => (strikes.some((at) => tMs >= at && tMs < at + 250) ? 40 : 0);
    },
  },
  {
    row: 12,
    name: 'screenFlash overlay under a swarm',
    base: 0.25,
    durationMs: 10000,
    live: (seed) => {
      // hurt 0.35 s at min(.6, .15 + sev) per hit, DoT pulses every 0.7 s, a heal 0.3 s: each a square alpha pulse, the
      // strongest running one wins (the overlay-side onset merging is UI2b's and is not applied here)
      const r = rng(seed);
      const pulses: Array<[number, number, number]> = [];
      for (let t = 100; t < 10000; t += 60 + 400 * r()) pulses.push([Math.ceil(t / SIM_MS) * SIM_MS, 350, Math.min(0.6, 0.15 + 0.6 * r())]);
      for (let t = 250; t < 10000; t += 700) pulses.push([t, 500, 0.3]);
      return (tMs) => {
        let alpha = 0;
        for (const [at, life, a] of pulses) if (tMs >= at && tMs < at + life) alpha = Math.max(alpha, a);
        return alpha;
      };
    },
  },
];

/** [CAL waveforms.flick]: 1 − amt · (0.5 + 0.5 · n1(t · hz + seed)), n1 = 1D value noise in [−1, 1] */
function flick(hz: number, amt: number, tS: number, seed: number): number {
  const x = tS * hz + seed;
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f);
  const a = hash(i, 3) * 2 - 1;
  const b = hash(i + 1, 3) * 2 - 1;
  return 1 - amt * (0.5 + 0.5 * (a + (b - a) * s));
}

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];
const FRAME_RATES = [60, 30, 144];

// ── the algorithm (system-ui.md §3.7a.7) ────────────────────────────────────────────────────────────────────────────────

describe('FlashGuard: the guard of system-ui.md §3.7a.7', () => {
  it('uses the constants of the specification', () => {
    expect(MIN_REVERSAL_MS).toBe(334);
    expect(FADE_S).toBe(0.25);
    expect(DEADBAND).toBe(0.1);
  });

  it('is the identity while disabled, to the bit', () => {
    const guard = createFlashGuard();
    expect(guard.enabled).toBe(false);
    const c = guard.channel('lamp', 20);
    const r = rng(7);
    for (let i = 0; i < 500; i++) {
      // above the base, negative, tiny, huge: nothing is clamped or rounded while the guard is off
      const v = [0, 24, 20 * r(), -3, 1e-9, 1e9, 0.1 + 0.2][i % 7]!;
      expect(Object.is(c.apply(v, i * 16.6, 1 / 60), v)).toBe(true);
    }
    expect(Object.is(c.apply(Number.NaN, 0, 1 / 60), Number.NaN)).toBe(true);
  });

  it('a channel starts on the first value it is given, not on a fade towards it', () => {
    const guard = createFlashGuard();
    guard.setEnabled(true);
    // a lamp that is dark when the place loads (a blackout in progress) shows dark at once
    expect(guard.channel('dark lamp', 20).apply(0, 0, 1 / 60)).toBe(0);
    expect(guard.channel('lit lamp', 20).apply(20, 0, 1 / 60)).toBe(20);
    // the first value is clamped like every other one
    expect(guard.channel('overdriven', 20).apply(24, 0, 1 / 60)).toBe(20);
  });

  it('never lets the output exceed the authored base (the live lamp death writes up to 1.2 ×)', () => {
    const guard = createFlashGuard();
    guard.setEnabled(true);
    const c = guard.channel('lamp', 20);
    c.apply(20, 0, 1 / 60);
    let t = 0;
    for (let i = 0; i < 200; i++) {
      t += 1000 / 60;
      expect(c.apply(i % 20 < 10 ? 24 : 2, t, 1 / 60)).toBeLessThanOrEqual(20);
    }
  });

  it('passes a change under 10 % of the base straight through, in either direction, at any rate', () => {
    const guard = createFlashGuard();
    guard.setEnabled(true);
    const c = guard.channel('lamp', 20);
    expect(c.apply(20, 0, 1 / 60)).toBe(20);
    expect(c.apply(18.1, 16, 1 / 60)).toBe(18.1);
    expect(c.apply(19.9, 32, 1 / 60)).toBe(19.9);
    expect(c.apply(18.2, 48, 1 / 60)).toBe(18.2);
    // exactly 10 % is not under it: that one is slewed
    const before = c.apply(18.2, 64, 1 / 60);
    const out = c.apply(before - 2.5, 80, 1 / 60);
    expect(out).toBeGreaterThan(before - 2.5);
    expect(out).toBeLessThan(before);
  });

  it('slews a larger change at base per 0.25 s', () => {
    const guard = createFlashGuard();
    guard.setEnabled(true);
    const c = guard.channel('lamp', 20);
    c.apply(20, 0, 1 / 60);
    const dt = 1 / 100;
    // 20 → 0 at 20 / 0.25 s = 80 per second = 0.8 per 10 ms frame
    const seen: number[] = [];
    for (let i = 1; i <= 30; i++) seen.push(c.apply(0, i * 10, dt));
    expect(seen[0]).toBeCloseTo(19.2, 10);
    expect(seen[9]).toBeCloseTo(12, 10);
    // within 10 % of the base of the target the rest passes straight through
    expect(seen[22]).toBeCloseTo(1.6, 10);
    expect(seen[23]).toBe(0);
    expect(seen[29]).toBe(0);
    // the fade takes 0.25 s at most, whatever the frame time
    const c2 = guard.channel('lamp 2', 20);
    c2.apply(0, 0, 1 / 30);
    let t = 0;
    let frames = 0;
    while (c2.apply(20, (t += 1000 / 30), 1 / 30) < 20) frames++;
    expect((frames + 1) / 30).toBeLessThanOrEqual(0.25 + 1 / 30);
  });

  it('holds instead of turning round within 334 ms of the last reversal', () => {
    const guard = createFlashGuard();
    guard.setEnabled(true);
    const c = guard.channel('lamp', 20);
    const dt = 1 / 100;
    c.apply(20, 0, dt);
    // down from t = 10 ms: the first reversal
    let out = 20;
    for (let t = 10; t <= 100; t += 10) out = c.apply(0, t, dt);
    expect(out).toBeCloseTo(12, 10);
    // the writer goes back up at once: too soon, the output holds where it is
    for (let t = 110; t < 10 + MIN_REVERSAL_MS; t += 10) expect(c.apply(20, t, dt)).toBe(out);
    // from 334 ms after the reversal it may turn
    expect(c.apply(20, 10 + MIN_REVERSAL_MS, dt)).toBeGreaterThan(out);
    // and continuing in the same direction is never held
    const c2 = guard.channel('lamp 2', 20);
    c2.apply(20, 0, dt);
    c2.apply(10, 10, dt);
    expect(c2.apply(0, 20, dt)).toBeCloseTo(18.4, 10);
  });

  it('returns the same channel for the same key, and independent channels for different keys', () => {
    const guard = createFlashGuard();
    guard.setEnabled(true);
    const a = guard.channel('a', 20);
    expect(guard.channel('a', 20)).toBe(a);
    const b = guard.channel('b', 20);
    expect(b).not.toBe(a);
    a.apply(20, 0, 1 / 60);
    b.apply(20, 0, 1 / 60);
    for (let i = 1; i <= 10; i++) a.apply(0, i * 16, 1 / 60);
    // b saw none of it: its first move is a fresh one
    expect(b.apply(20, 200, 1 / 60)).toBe(20);
    expect(guard.size).toBe(2);
    // a new base for a known key replaces the old one (a tier or map change re-reads the authored value)
    expect(guard.channel('a', 40)).toBe(a);
    let last = 0;
    for (let i = 0; i < 120; i++) last = a.apply(60, 5000 + i * 16, 1 / 60);
    expect(last).toBe(40);
    guard.release('a');
    expect(guard.size).toBe(1);
    expect(guard.channel('a', 20)).not.toBe(a);
    guard.reset();
    expect(guard.size).toBe(0);
  });

  it('rejects a base that is not a positive finite number, and an empty key', () => {
    const guard = createFlashGuard();
    expect(() => guard.channel('', 1)).toThrow(RangeError);
    for (const base of [Number.NaN, -1, Number.POSITIVE_INFINITY]) expect(() => guard.channel('x', base)).toThrow(RangeError);
    // a light authored dark has nothing to flash: its channel pins the output to 0 while the guard is on
    const dark = guard.channel('dark', 0);
    guard.setEnabled(true);
    expect(dark.apply(5, 0, 1 / 60)).toBe(0);
  });

  it('switching the guard on mid-session continues from the value last shown', () => {
    const guard = createFlashGuard();
    const c = guard.channel('lamp', 20);
    for (let i = 0; i < 10; i++) c.apply(i % 2 === 0 ? 20 : 1, i * 16, 1 / 60);
    // last shown: 1
    guard.setEnabled(true);
    const out = c.apply(20, 160, 1 / 60);
    expect(out).toBeGreaterThan(1);
    expect(out).toBeLessThan(20);
    guard.setEnabled(false);
    expect(c.apply(20, 176, 1 / 60)).toBe(20);
  });
});

// ── the waveform replay ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('FlashGuard: the source waveforms of system-ui.md §3.7a.7 at their live cadences', () => {
  it('replays the twelve rows that are light channels', () => {
    expect([...new Set(SOURCES.map((s) => s.row))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(SOURCES.find((s) => s.row === 12)!.base).toBe(0.25);
  });

  it('the flash counter counts what the table counts', () => {
    const t = [0, 100, 200, 300, 400, 500, 600, 700];
    // on/off every 100 ms: seven changes, three and a half flashes in 0.7 s
    expect(countChanges(t, [1, 0, 1, 0, 1, 0, 1, 0], 0.1)).toHaveLength(7);
    expect(worstFlashWindow(countChanges(t, [1, 0, 1, 0, 1, 0, 1, 0], 0.1))).toBe(3);
    // a ramp is one change, whatever its length; swings under the threshold are none
    expect(countChanges(t, [1, 0.9, 0.8, 0.6, 0.4, 0.3, 0.1, 0], 0.1)).toHaveLength(1);
    expect(countChanges(t, [1, 0.95, 1, 0.93, 1, 0.95, 1, 0.92], 0.1)).toHaveLength(0);
    // a slow drift down in small steps and back is one flash
    expect(countChanges(t, [1, 0.95, 0.9, 0.85, 0.9, 0.95, 1, 1], 0.1)).toHaveLength(2);
    // changes more than 1 s apart never share a window
    expect(worstFlashWindow([0, 1000, 2000, 3000])).toBe(0);
    expect(worstFlashWindow([0, 999])).toBe(1);
  });

  it('the live waveforms do flash: without the guard several rows exceed 3 flashes in a second', () => {
    const worst = new Map<number, number>();
    for (const s of SOURCES) {
      for (const seed of SEEDS) {
        const off = createFlashGuard();
        const run = replay(s.live(seed), off.channel('c', s.base), s.durationMs, 60);
        const k = run.output.map((v) => Math.min(v, s.base) / s.base);
        worst.set(s.row, Math.max(worst.get(s.row) ?? 0, worstFlashWindow(countChanges(run.times, k, 0.1))));
      }
    }
    // the muzzle pops (7.7-16 on/off pairs per second) and the 14 Hz fx lights are far over the limit as authored
    expect(worst.get(9)!).toBeGreaterThan(3);
    expect(worst.get(11)!).toBeGreaterThan(3);
    console.log(`[r1b] flashes per second as authored, worst window per row: ${[...worst].map(([row, n]) => `${row}: ${n}`).join(', ')}`);
  });

  for (const s of SOURCES) {
    it(`row ${s.row}, ${s.name}: identical with the guard off`, () => {
      for (const fps of FRAME_RATES) {
        for (const seed of SEEDS.slice(0, 4)) {
          const guard = createFlashGuard();
          const run = replay(s.live(seed), guard.channel(`row${s.row}`, s.base), s.durationMs, fps);
          // not close: the same numbers
          expect(run.output.every((v, i) => Object.is(v, run.input[i]))).toBe(true);
        }
      }
    });

    it(`row ${s.row}, ${s.name}: at most 3 flashes in any 1 s window with the guard on`, () => {
      for (const fps of FRAME_RATES) {
        for (const seed of SEEDS) {
          const guard = createFlashGuard();
          guard.setEnabled(true);
          const source = (s.guarded ?? s.live)(seed);
          const run = replay(source, guard.channel(`row${s.row}`, s.base), s.durationMs, fps);
          const label = `row ${s.row} (${s.name}), seed ${seed}, ${fps} fps`;
          // never above the authored value, never below what the writers ever asked for
          expect(Math.max(...run.output), label).toBeLessThanOrEqual(s.base);
          expect(Math.min(...run.output), label).toBeGreaterThanOrEqual(Math.min(0, ...run.input));
          const k = run.output.map((v) => v / s.base);
          const changes = countChanges(run.times, k, 0.1);
          expect(worstFlashWindow(changes), label).toBeLessThanOrEqual(3);
        }
      }
    });
  }

  it('no row comes near the limit: at most 4 opposing changes (2 flashes) in any second', () => {
    // The design figure is ≤ 3 reversals per second per channel (1.5 flashes). A fourth change in a second happens where a
    // move under 10 % of the base, which passes through by design, completes a swing the slewed moves began (buzz, and the
    // shotgun's 80 ms pops). Still a third under the general limit of 3 flashes.
    for (const s of SOURCES) {
      for (const seed of SEEDS.slice(0, 6)) {
        const guard = createFlashGuard();
        guard.setEnabled(true);
        const run = replay((s.guarded ?? s.live)(seed), guard.channel('c', s.base), s.durationMs, 60);
        const changes = countChanges(
          run.times,
          run.output.map((v) => v / s.base),
          0.1,
        );
        let worst = 0;
        let start = 0;
        for (let end = 0; end < changes.length; end++) {
          while (changes[end]! - changes[start]! >= 1000) start++;
          worst = Math.max(worst, end - start + 1);
        }
        expect(worst, `row ${s.row} (${s.name}), seed ${seed}`).toBeLessThanOrEqual(4);
      }
    }
  });

  it('a steady light is untouched by the guard', () => {
    const guard = createFlashGuard();
    guard.setEnabled(true);
    const c = guard.channel('steady', 26);
    for (let i = 0; i < 600; i++) expect(c.apply(26, i * 16.6667, 1 / 60)).toBe(26);
  });
});
