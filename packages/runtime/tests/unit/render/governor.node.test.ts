// src/render/perf/governor.ts (render §15.2; WP R14b): the governor state machine driven by simulated frame series. The
// target stands in for the render facade: its render scale is clamped to the tier's range by nothing but the governor, and
// a tier change resets the scale to the new tier's start scale, as the canvas host does.
import { describe, expect, it } from 'vitest';
import { tierConfig, type TierId } from '../../../src/render/perf/budget.ts';
import {
  CPU_LEVER_ORDER,
  GOVERNOR_DESKTOP_FIRST_DROP_MS,
  GOVERNOR_FLOOR_HOLD_MS,
  createGovernor,
  fxHeldStepDown,
  type CpuLever,
  type Governor,
  type GovernorDevice,
  type GovernorEvent,
  type GovernorTarget,
} from '../../../src/render/perf/governor.ts';

interface Fake extends GovernorTarget {
  tier: TierId;
  renderScale: number;
  explicitTier: boolean;
  readonly tierCalls: TierId[];
}

function fakeTarget(tier: TierId = 'high', explicit = false): Fake {
  const t: Fake = {
    tier,
    renderScale: tierConfig(tier).startRenderScale,
    explicitTier: explicit,
    tierCalls: [],
    setRenderScale(s) {
      t.renderScale = s;
    },
    applyTier(next) {
      t.tierCalls.push(next);
      t.tier = next;
      t.renderScale = tierConfig(next).startRenderScale;
    },
  };
  return t;
}

interface Rig {
  gov: Governor;
  target: Fake;
  events: GovernorEvent[];
  pulls: CpuLever[];
  /** the levers' answers; absent: true */
  answers: Partial<Record<CpuLever, boolean>>;
}

function rig(o: { tier?: TierId; device?: GovernorDevice; explicit?: boolean; levers?: readonly CpuLever[]; floor?: number } = {}): Rig {
  const target = fakeTarget(o.tier ?? 'high', o.explicit ?? false);
  const pulls: CpuLever[] = [];
  const answers: Partial<Record<CpuLever, boolean>> = {};
  const levers: Partial<Record<CpuLever, () => boolean>> = {};
  for (const l of o.levers ?? CPU_LEVER_ORDER) {
    levers[l] = () => {
      pulls.push(l);
      return answers[l] ?? true;
    };
  }
  const gov = createGovernor({ target, device: o.device ?? 'desktop', levers });
  if (o.floor !== undefined) gov.setFrameFloor(o.floor);
  const events: GovernorEvent[] = [];
  gov.onEvent((e) => events.push(e));
  gov.setPhase('play');
  return { gov, target, events, pulls, answers };
}

/** feeds `seconds` of frames; `frame(t)` gives [frameMs, cpuMs] at governor-independent wall time t (ms) */
function run(r: Rig, seconds: number, frame: (t: number, target: Fake) => readonly [number, number]): void {
  let t = 0;
  while (t < seconds * 1000) {
    const [ms, cpu] = frame(t, r.target);
    r.gov.sample(ms, cpu);
    t += ms;
  }
}

const kinds = (events: readonly GovernorEvent[]): string[] =>
  events.map((e) => (e.kind === 'lever' ? `lever:${e.lever}` : e.kind === 'scale' ? `scale:${e.to}` : `${e.kind}:${e.to}`));

describe('governor: steady and recovering frames', () => {
  it('a steady 16 ms desktop frame moves nothing', () => {
    const r = rig();
    run(r, 120, () => [16, 6]);
    expect(r.events).toEqual([]);
    expect(r.gov.inspect().windows).toBeGreaterThan(50);
  });

  it('the hysteresis band: frames between 13 and 18.5 ms neither lower nor raise the scale', () => {
    const r = rig();
    run(r, 2.1, () => [25, 4]); // one GPU-bound miss: 1.0 → 0.9
    expect(r.target.renderScale).toBeCloseTo(0.9, 6);
    run(r, 60, () => [15, 4]);
    expect(r.target.renderScale).toBeCloseTo(0.9, 6);
  });

  it('4 s below 13 ms raises the scale by 0.05, up to the tier maximum', () => {
    const r = rig();
    // whole windows: 80 frames of 25 ms and 200 of 10 ms are exactly 2 s each
    run(r, 2, () => [25, 4]);
    run(r, 2, () => [25, 4]);
    expect(r.target.renderScale).toBeCloseTo(0.8, 6);
    r.events.length = 0;
    run(r, 2, () => [10, 4]);
    expect(r.events).toEqual([]); // one good window is not 4 s
    run(r, 2, () => [10, 4]);
    expect(kinds(r.events)).toEqual(['scale:0.85']);
    run(r, 60, () => [10, 4]);
    expect(r.target.renderScale).toBeCloseTo(1.0, 6);
    expect(kinds(r.events)).toEqual(['scale:0.85', 'scale:0.9', 'scale:0.95', 'scale:1']);
  });
});

describe('governor: CPU-bound and GPU-bound misses', () => {
  it('a CPU-bound trace pulls the CPU levers, one per window, before the resolution moves', () => {
    const r = rig();
    run(r, 2.05, () => [25, 22]);
    expect(kinds(r.events)).toEqual(['lever:uiCadence']);
    run(r, 2.05, () => [25, 22]);
    run(r, 2.05, () => [25, 22]);
    // `fxHeld` does not apply on `high` (X-22): the third CPU lever is simCaps
    expect(kinds(r.events)).toEqual(['lever:uiCadence', 'lever:mixerLod', 'lever:simCaps']);
    expect(r.target.renderScale).toBe(1);
    run(r, 2.05, () => [25, 22]);
    expect(kinds(r.events).at(-1)).toBe('scale:0.9');
  });

  it('above the tier CPU total counts as CPU-bound even below 80 % of the frame', () => {
    const r = rig();
    run(r, 2.05, () => [25, 12]); // 12 ms > 10 ms (high) though < 0.8 × 25
    expect(kinds(r.events)).toEqual(['lever:uiCadence']);
  });

  it('a GPU-bound trace steps the resolution to the floor, then pulls the CPU levers that are left', () => {
    const r = rig();
    run(r, 14.5, () => [25, 4]);
    expect(kinds(r.events)).toEqual(['scale:0.9', 'scale:0.8', 'scale:0.75', 'lever:uiCadence', 'lever:mixerLod', 'lever:simCaps']);
    expect(r.target.renderScale).toBeCloseTo(tierConfig('high').renderScaleRange[0], 6);
  });

  it('a lever already in effect is passed over in the same window', () => {
    const r = rig();
    r.answers.uiCadence = false; // the HUD already runs at 30 Hz
    run(r, 2.05, () => [25, 22]);
    expect(r.pulls).toEqual(['uiCadence', 'mixerLod']);
    expect(kinds(r.events)).toEqual(['lever:mixerLod']);
  });

  it('the fx held lever exists on the mobile tiers only, after the mixer and before simCaps', () => {
    const r = rig({ tier: 'low', device: 'mobile' });
    run(r, 8.5, () => [45, 40]);
    expect(kinds(r.events)).toEqual(['lever:uiCadence', 'lever:mixerLod', 'lever:fxHeld', 'lever:simCaps']);
    expect(fxHeldStepDown(tierConfig('low').fxHeldFactor)).toBe(0.35);
    expect(fxHeldStepDown(tierConfig('minimum').fxHeldFactor)).toBe(0.25);
    expect(fxHeldStepDown(0.25)).toBe(0.25);
  });

  it('mobile is judged against its 30 fps target', () => {
    const r = rig({ tier: 'minimum', device: 'mobile' });
    run(r, 30, () => [33, 20]);
    expect(r.events).toEqual([]);
    r.gov.setPhase('break'); // a fresh window
    run(r, 2, () => [40, 10]);
    expect(kinds(r.events)).toEqual(['scale:0.55']);
  });

  it("the player's 30 fps cap is not a miss", () => {
    const r = rig({ floor: 1000 / 30 });
    run(r, 60, () => [33.4, 5]);
    expect(r.events).toEqual([]);
  });
});

describe('governor: tier drops', () => {
  /** a GPU-bound desktop at `high` that misses whatever the governor does */
  const hopeless = (): readonly [number, number] => [30, 4];

  it('the first desktop drop waits for a 30 s miss, then lands at the next break, toasted once', () => {
    const r = rig();
    run(r, GOVERNOR_DESKTOP_FIRST_DROP_MS / 1000 - 2.5, hopeless);
    expect(r.gov.inspect().pendingDrop).toBeNull();
    run(r, 3, hopeless);
    expect(r.gov.inspect().pendingDrop).toBe('medium');
    expect(r.target.tierCalls).toEqual([]); // mid-wave: not yet
    r.gov.setPhase('protected');
    run(r, 10, hopeless);
    expect(r.target.tierCalls).toEqual([]); // never in a boss fight
    r.gov.setPhase('break');
    expect(r.target.tierCalls).toEqual(['medium']);
    expect(r.events.filter((e) => e.kind === 'drop')).toEqual([{ kind: 'drop', from: 'high', to: 'medium' }]);
    expect(r.target.renderScale).toBe(tierConfig('medium').startRenderScale);
  });

  it('a later drop needs 10 s at the new floor, not 30 s', () => {
    const r = rig();
    const at: number[] = [];
    r.gov.onEvent((e) => {
      if (e.kind === 'drop') at.push(r.gov.inspect().clockMs);
    });
    r.gov.setPhase('break');
    while (at.length < 2 && r.gov.inspect().clockMs < 200_000) run(r, 0.5, hopeless);
    expect(r.target.tierCalls).toEqual(['medium', 'low']);
    expect(at[0]).toBeGreaterThanOrEqual(GOVERNOR_DESKTOP_FIRST_DROP_MS);
    // medium: 1.0 → 0.9 → 0.8 → 0.7 (three windows; the CPU levers were pulled on high), then 10 s at the floor
    const gap = at[1]! - at[0]!;
    expect(gap).toBeGreaterThanOrEqual(GOVERNOR_FLOOR_HOLD_MS);
    expect(gap).toBeLessThan(GOVERNOR_DESKTOP_FIRST_DROP_MS);
    expect(r.gov.inspect().drops).toBe(2);
  });

  it('desktop never leaves high without a sustained miss: alternating miss and neutral windows', () => {
    const r = rig();
    r.gov.setPhase('break');
    run(r, 300, (t) => (Math.floor(t / 2000) % 2 === 0 ? [30, 4] : [16, 4]));
    expect(r.target.tierCalls).toEqual([]);
    expect(r.target.tier).toBe('high');
  });

  it("the player's explicit pick disables drops; resolution and CPU levers still adapt", () => {
    const r = rig({ explicit: true });
    r.gov.setPhase('break');
    run(r, 120, hopeless);
    expect(r.target.tierCalls).toEqual([]);
    expect(r.target.renderScale).toBeCloseTo(0.75, 6);
    expect(r.gov.inspect().pulled).toEqual(['uiCadence', 'mixerLod', 'simCaps']);
  });

  it('minimum has nothing below it', () => {
    const r = rig({ tier: 'minimum', device: 'mobile' });
    r.gov.setPhase('break');
    run(r, 120, () => [60, 10]);
    expect(r.target.tierCalls).toEqual([]);
    expect(r.gov.inspect().pendingDrop).toBeNull();
  });

  it('reset (the player changed the setting) cancels a pending drop', () => {
    const r = rig();
    run(r, 40, hopeless);
    expect(r.gov.inspect().pendingDrop).toBe('medium');
    r.gov.reset();
    r.gov.setPhase('break');
    expect(r.target.tierCalls).toEqual([]);
  });
});

describe('governor: no oscillation', () => {
  it('a scene on the edge of the budget settles instead of see-sawing', () => {
    const r = rig();
    // above 0.85 the scene misses (20 ms), at 0.85 and below it is good (12 ms)
    run(r, 600, (_t, target) => (target.renderScale > 0.85 + 1e-6 ? [20, 4] : [12, 4]));
    const scales = r.events.filter((e) => e.kind === 'scale');
    // down to 0.8, one probe up to 0.85 (good), one probe to 0.9 that misses, then the ceiling holds it at 0.85 and below
    expect(scales.length).toBeLessThanOrEqual(6);
    const tail = r.events.slice(-1)[0];
    expect(tail).toBeDefined();
    const late = r.gov.inspect();
    expect(late.ceiling).toBeLessThanOrEqual(0.85 + 1e-6);
    run(r, 600, (_t, target) => (target.renderScale > 0.85 + 1e-6 ? [20, 4] : [12, 4]));
    expect(r.events.filter((e) => e.kind === 'scale').length).toBe(scales.length);
    expect(r.target.tierCalls).toEqual([]);
  });
});

describe('governor: phases', () => {
  it('idle frames (menus, LOADING) are never judged', () => {
    const r = rig();
    r.gov.setPhase('idle');
    run(r, 120, () => [80, 70]);
    expect(r.events).toEqual([]);
    expect(r.gov.inspect().windows).toBe(0);
  });

  it('a window never spans a phase change', () => {
    const r = rig();
    run(r, 1.9, () => [30, 4]);
    r.gov.setPhase('break');
    run(r, 1.9, () => [30, 4]);
    expect(r.events).toEqual([]);
    run(r, 0.2, () => [30, 4]);
    expect(kinds(r.events)).toEqual(['scale:0.9']);
  });

  it('disabled: nothing is sampled or moved', () => {
    const r = rig();
    r.gov.setEnabled(false);
    run(r, 120, () => [30, 4]);
    expect(r.events).toEqual([]);
  });
});
