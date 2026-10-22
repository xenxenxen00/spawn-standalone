// The per-tick pipeline and its rates (docs/design/core-runtime.md §9.2-9.4, §9.7, D-CORE-10; docs/architecture.md §4.1):
// the exact A-H order with a phase boundary after B-G, `every` phases that spread a cohort, `every: {seconds}` rounding, the dt
// each behavior gets, sims on every third tick, at most two ticks per frame with the backlog dropped.
import { describe, expect, it } from 'vitest';
import {
  EVERY_TICK,
  compileSchedule,
  everyTicksOf,
  fnv1a32,
  isLocal,
  phaseFor,
  shouldRun,
} from '../../../src/compat/core/sched/schedule.ts';
import { mintId } from '../../../src/compat/core/ids.ts';
import { ENGINE } from '../../../src/compat/core/rules.ts';
import type { EventMeta } from '../../../src/compat/core/types.ts';
import { FakeWorld, recordingPorts, type MiniCtx, type TestModule } from './fakes/tick-world.ts';

const pad4 = (n: number): string => String(n).padStart(4, '0');
const dtOf = (n: number): string => (n / 30).toFixed(4);

describe('updateSchedule (core §9.4, D-CORE-10, contract §7.2)', () => {
  it('fnv1a32 is the 32-bit FNV-1a hash', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
    for (const s of ['player/local:scripts/player.js', 'é']) expect(Number.isInteger(fnv1a32(s)) && fnv1a32(s) >= 0).toBe(true);
  });

  it('every N runs every N ticks with dt = N/30; no schedule is every tick at 1/30', () => {
    expect(compileSchedule(undefined, 'a', 'scripts/a.js')).toEqual(EVERY_TICK);
    expect(EVERY_TICK).toEqual({ everyTicks: 1, phase: 0, dtS: 1 / 30 });
    for (const n of [1, 2, 3, 6, 90]) {
      const s = compileSchedule({ every: n }, 'r', 'scripts/x.js');
      expect(s.everyTicks).toBe(n);
      expect(s.dtS).toBe(n / 30);
      expect(s.phase).toBeGreaterThanOrEqual(0);
      expect(s.phase).toBeLessThan(n);
      const runs = Array.from({ length: n * 4 }, (_, i) => i + 1).filter((t) => shouldRun(s, t));
      expect(runs.length).toBe(4);
      for (let i = 1; i < runs.length; i++) expect(runs[i]! - runs[i - 1]!).toBe(n);
    }
  });

  it('every {seconds: s} rounds s·30 to whole ticks (at least one): the live schedules', () => {
    const live: Array<[number, number]> = [
      [0.25, 8], // radio: 7.5 → 8
      [0.35, 11], // trader trail: 10.5 → 11
      [0.4, 12], // trader gate
      [1, 30], // sirens, surge host, nuke
      [0.01, 1],
      [0, 1],
    ];
    for (const [s, n] of live) {
      expect(everyTicksOf({ every: { seconds: s } }), `${s} s`).toBe(n);
      expect(compileSchedule({ every: { seconds: s } }, 'r', 'p').dtS).toBe(n / 30);
    }
  });

  it('treats a malformed schedule as every tick and rounds a fractional N', () => {
    for (const spec of [null, 7, 'every 3', {}, { every: 0 }, { every: -2 }, { every: Number.NaN }, { every: { seconds: Number.POSITIVE_INFINITY } }, { every: {} }]) {
      expect(everyTicksOf(spec), JSON.stringify(spec)).toBe(1);
    }
    expect(everyTicksOf({ every: 2.6 })).toBe(3);
    expect(everyTicksOf({ every: 3, near: { radius: 45 } })).toBe(3); // near is accepted; every live map fits the locality radius
  });

  it('phases are deterministic per (row, behavior) and independent between behaviors', () => {
    expect(phaseFor('door-12', 'scripts/map/door.js', 2)).toBe(phaseFor('door-12', 'scripts/map/door.js', 2));
    expect(compileSchedule({ every: 3 }, 'en-7f3a-0042', 'scripts/enemies/enemy-brain.js')).toEqual(
      compileSchedule({ every: 3 }, 'en-7f3a-0042', 'scripts/enemies/enemy-brain.js'),
    );
    expect(phaseFor('x', 'p', 1)).toBe(0);
    // ids without a trailing serial keep the documented hash: fnv1a32(id + ':' + path) mod N
    expect(phaseFor('player/local', 'scripts/audio/music-director.js', 3)).toBe(fnv1a32('player/local:scripts/audio/music-director.js') % 3);
  });

  it('spreads a cohort over its N ticks: 300 rows, each residue class within ±10 % (babylon §21.9: brains split across three ticks)', () => {
    const cohorts: Array<[string, (i: number) => string, string]> = [];
    for (const short of ['7f3a', 'a1b2', '0000', 'ffff', '3c9d']) {
      cohorts.push([`enemies of match ${short}`, (i) => `en-${short}-${pad4(i)}`, 'scripts/enemies/enemy-brain.js']);
      cohorts.push([`enemy bodies of match ${short}`, (i) => `en-${short}-${pad4(i)}`, 'scripts/enemies/enemy.js']);
    }
    cohorts.push(['scene doors', (i) => `gf-door-${i}`, 'scripts/map/door.js']);
    cohorts.push(['flicker lamps', (i) => `cb-lamp-${i + 7}`, 'scripts/map/flicker.js']);
    cohorts.push(['minted rows', (i) => mintId(i + 40), 'scripts/x.js']);
    for (const every of [2, 3, 6]) {
      for (const [name, idOf, path] of cohorts) {
        const counts = new Array<number>(every).fill(0);
        for (let i = 1; i <= 300; i++) counts[phaseFor(idOf(i), path, every)]!++;
        const mean = 300 / every;
        for (const c of counts) expect(Math.abs(c - mean), `${name}, every ${every}: ${counts.join('/')}`).toBeLessThanOrEqual(mean * 0.1);
      }
    }
  });

  it('ids with no serial still spread (the plain hash): no residue class empty or holding half the cohort', () => {
    for (const every of [2, 3]) {
      const counts = new Array<number>(every).fill(0);
      for (let i = 1; i <= 300; i++) counts[phaseFor(`en-7f3a-${pad4(i)}/bp-Head`, 'scripts/enemies/probes.js', every)]!++;
      const mean = 300 / every;
      for (const c of counts) expect(Math.abs(c - mean), counts.join('/')).toBeLessThanOrEqual(mean * 0.4);
    }
  });

  it('locality: a row updates while its place is simulated; a place-less row always does', () => {
    const sim = (p: string): boolean => p === 'p1';
    expect(isLocal('p1', sim)).toBe(true);
    expect(isLocal('p2', sim)).toBe(false);
    expect(isLocal(null, sim)).toBe(true);
  });

  it('the scheduler spreads a cohort of 300 every-3 rows across the three ticks', () => {
    const w = new FakeWorld();
    const perTick = new Map<number, number>();
    const brain: TestModule = { updateSchedule: { every: 3 }, update: () => perTick.set(w.k.clock.tick, (perTick.get(w.k.clock.tick) ?? 0) + 1) };
    for (let i = 1; i <= 300; i++) w.spawn(`en-7f3a-${pad4(i)}`, { behaviors: [['scripts/enemies/enemy-brain.js', brain]] });
    w.k.runTicks(6);
    const counts = [1, 2, 3].map((t) => perTick.get(t) ?? 0);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(300);
    for (const c of counts) expect(Math.abs(c - 100), counts.join('/')).toBeLessThanOrEqual(10);
    expect([4, 5, 6].map((t) => perTick.get(t))).toEqual(counts);
  });
});

describe('the per-tick pipeline: exact trace of a scripted scene (core §9.3)', () => {
  it('runs A CLOCK, B INPUT ◆, C TIMERS ◆, D UPDATE ◆, E PHYSICS ◆, F SIMS ◆, G LIFETIME ◆, H END in that order', () => {
    const trace: string[] = [];
    const w = new FakeWorld({ ports: recordingPorts(trace) });
    trace.length = 0; // the world's `boot` resume already told the input port to drop its edges
    const T = (s: string): void => {
      trace.push(s);
    };
    const tick = (): number => w.k.clock.tick;
    w.time.use({ tickStart: (t) => T(`A tick ${t}`) });
    w.k.on('tickEnd', (t) => T(`H tickEnd ${t}`));

    const intent: TestModule = {
      onSpawn: () => T('◆ onSpawn player/local scripts/intent.js'),
      onInput: () => T('B onInput player/local scripts/intent.js'),
      update: (ctx: MiniCtx, dt: number) => {
        T(`D update player/local scripts/intent.js ${dt.toFixed(4)}`);
        if (tick() === 1) ctx.emit('ss:req', { op: 'ready' }, { audience: { kind: 'all' } });
      },
    };
    const gib: TestModule = {
      onSpawn: () => T('◆ onSpawn gib-1'),
      update: (_ctx: MiniCtx, dt: number) => T(`D update gib-1 ${dt.toFixed(4)}`),
      onDestroy: () => T('◆ onDestroy gib-1'),
    };
    const body: TestModule = {
      update: (ctx: MiniCtx, dt: number) => {
        T(`D update player/local scripts/body.js ${dt.toFixed(4)}`);
        if (tick() === 1) {
          ctx.spawn('gib-1', { behaviors: [['scripts/gib.js', gib]], expiresAtTick: 3 });
          ctx.after(0.1, 'kick', { n: 1 });
        }
      },
      kick: (_ctx: MiniCtx, p: unknown) => T(`C after kick ${JSON.stringify(p)}`),
    };
    const door: TestModule = { updateSchedule: { every: 2 }, update: (_c: MiniCtx, dt: number) => T(`D update door-1 ${dt.toFixed(4)}`) };
    w.spawn('player/local', { vm: 'client', player: { userId: 'u1' }, behaviors: [['scripts/intent.js', intent], ['scripts/body.js', body]] });
    w.spawn('door-1', { behaviors: [['scripts/map/door.js', door]] });
    w.spawn('far-1', { place: 'p2', behaviors: [['scripts/far.js', { update: () => T('D update far-1 (never: p2 is not simulated)') }]] });
    const root = w.addSim('sim', null, { tick: () => T('F tick sim.js') });
    w.addSim('sim:p1', 'p1', { tick: () => T('F tick places/p1/sim.js') });
    w.addSim('sim:p2', 'p2', { tick: () => T('F tick places/p2/sim.js (never: p2 is not simulated)') });
    w.time.listeners.on({ kind: 'sim', sim: root }, 'ss:req', (_c: unknown, p: unknown, meta: EventMeta) =>
      T(`◆ deliver ${meta.name} ${JSON.stringify(p)} from ${meta.sourceId} to sim.js`),
    );

    const doorPhase = phaseFor('door-1', 'scripts/map/door.js', 2);
    const doorAt = (t: number): string[] => ((t + doorPhase) % 2 === 0 ? [`D update door-1 ${dtOf(2)}`] : []);
    const input = (t: number): string[] => (t === 1 ? [] : ['B input.sampleTick', 'B onInput player/local scripts/intent.js']);
    const e = (t: number): string[] => [`E physics.step p1 ${dtOf(1)}`];
    const h = (t: number): string[] => [`H motion.advanceTick ${dtOf(1)}`, `H tickEnd ${t}`];

    w.k.runTicks(4);
    expect(trace).toEqual([
      // tick 1: the body's onSpawn runs at B's boundary, so it gets no onInput yet but updates in D
      'A tick 1',
      ...input(1),
      '◆ onSpawn player/local scripts/intent.js',
      `D update player/local scripts/intent.js ${dtOf(1)}`,
      `D update player/local scripts/body.js ${dtOf(1)}`,
      ...doorAt(1),
      '◆ onSpawn gib-1', // spawned in D: onSpawn at D's boundary, before the queued event
      '◆ deliver ss:req {"op":"ready"} from player/local to sim.js',
      ...e(1),
      ...h(1),
      // tick 2: the first sim tick (2 % 3 === 2): root sim, then the simulated place's sim
      'A tick 2',
      ...input(2),
      `D update player/local scripts/intent.js ${dtOf(1)}`,
      `D update player/local scripts/body.js ${dtOf(1)}`,
      ...doorAt(2),
      `D update gib-1 ${dtOf(1)}`, // spawned during D of tick 1: first update in tick 2
      ...e(2),
      'F tick sim.js',
      'F tick places/p1/sim.js',
      ...h(2),
      // tick 3: gib-1's lifetime ends in G; its onDestroy runs at G's boundary
      'A tick 3',
      ...input(3),
      `D update player/local scripts/intent.js ${dtOf(1)}`,
      `D update player/local scripts/body.js ${dtOf(1)}`,
      ...doorAt(3),
      `D update gib-1 ${dtOf(1)}`,
      ...e(3),
      '◆ onDestroy gib-1',
      ...h(3),
      // tick 4: ctx.after(0.1) from tick 1 is due at 1 + ceil(0.1·30) = 4, in C
      'A tick 4',
      ...input(4),
      'C after kick {"n":1}',
      `D update player/local scripts/intent.js ${dtOf(1)}`,
      `D update player/local scripts/body.js ${dtOf(1)}`,
      ...doorAt(4),
      ...e(4),
      ...h(4),
    ]);
  });

  it('runs sims at ticks where tick % 3 === 2, root sim first (core §9.2)', () => {
    const w = new FakeWorld();
    const ran: string[] = [];
    w.addSim('sim', null, { tick: () => ran.push(`root ${w.k.clock.tick}`) });
    w.addSim('sim:p1', 'p1', { tick: () => ran.push(`p1 ${w.k.clock.tick}`) });
    w.k.runTicks(9);
    expect(ran).toEqual(['root 2', 'p1 2', 'root 5', 'p1 5', 'root 8', 'p1 8']);
    expect(ENGINE.SIM_TICK_PHASE).toBe(2);
  });

  it('a row spawned during UPDATE first updates next tick; a row destroyed during UPDATE gets no further hook', () => {
    const w = new FakeWorld();
    const seen: string[] = [];
    const child: TestModule = { update: () => seen.push(`child ${w.k.clock.tick}`) };
    w.spawn('a', {
      behaviors: [
        [
          'scripts/a.js',
          {
            update: (ctx: MiniCtx) => {
              seen.push(`a ${w.k.clock.tick}`);
              if (w.k.clock.tick === 1) ctx.spawn('c', { behaviors: [['scripts/c.js', child]] });
              if (w.k.clock.tick === 2) ctx.destroy('b');
            },
          },
        ],
      ],
    });
    w.spawn('b', {
      behaviors: [
        ['scripts/b1.js', { update: () => seen.push(`b1 ${w.k.clock.tick}`) }],
        ['scripts/b2.js', { update: () => seen.push(`b2 ${w.k.clock.tick}`) }],
      ],
    });
    w.k.runTicks(3);
    expect(seen).toEqual(['a 1', 'b1 1', 'b2 1', 'a 2', 'child 2', 'a 3', 'child 3']);
  });

  it('a row whose behavior destroys it mid-update skips its later behaviors', () => {
    const w = new FakeWorld();
    const seen: string[] = [];
    w.spawn('a', {
      behaviors: [
        ['scripts/first.js', { update: (ctx: MiniCtx) => (seen.push('first'), ctx.destroy()) }],
        ['scripts/second.js', { update: () => seen.push('second') }],
      ],
    });
    w.k.runTicks(2);
    expect(seen).toEqual(['first']);
  });

  it('skips a row until its onSpawn ran, never updates the camera rig in the tick, and skips pending (late-bound) modules', () => {
    const w = new FakeWorld();
    const seen: string[] = [];
    w.spawn('camera/local', { vm: 'client', rig: true, behaviors: [['scripts/camera.js', { update: () => seen.push('rig') }]] });
    const late = w.spawn('late', { behaviors: [['scripts/late.js', null]] });
    late.pendingSpawnHooks = true;
    const pending = w.spawn('pending', { behaviors: [['scripts/p.js', { update: () => seen.push('pending') }]] });
    w.k.runTicks(1);
    expect(seen).toEqual(['pending']); // onSpawn ran at B's boundary of tick 1
    pending.pendingSpawnHooks = true; // e.g. a late bind still waiting (core §12.4)
    w.time.use({ flushDeferred: () => 0 });
    w.k.runTicks(1);
    expect(seen).toEqual(['pending']);
    expect(late.behaviors[0]!.pendingModule).toBe(true);
  });

  it('passes each behavior its own schedule step as dt', () => {
    const w = new FakeWorld();
    const dts: Record<string, number[]> = { one: [], three: [], sec: [] };
    w.spawn('r', {
      behaviors: [
        ['scripts/one.js', { update: (_c: MiniCtx, dt: number) => dts['one']!.push(dt) }],
        ['scripts/three.js', { updateSchedule: { every: 3 }, update: (_c: MiniCtx, dt: number) => dts['three']!.push(dt) }],
        ['scripts/sec.js', { updateSchedule: { every: { seconds: 0.25 } }, update: (_c: MiniCtx, dt: number) => dts['sec']!.push(dt) }],
      ],
    });
    w.k.runTicks(24);
    expect(dts['one']!.length).toBe(24);
    expect(new Set(dts['one'])).toEqual(new Set([1 / 30]));
    expect(dts['three']!.length).toBe(8);
    expect(new Set(dts['three'])).toEqual(new Set([3 / 30]));
    expect(dts['sec']!.length).toBe(3);
    expect(new Set(dts['sec'])).toEqual(new Set([8 / 30]));
  });
});

describe('kernel.advance: at most two ticks per frame, backlog dropped (core §9.7)', () => {
  it('runs 30 ticks per second of frames at any frame rate', () => {
    for (const fps of [30, 60, 75, 144, 240]) {
      const w = new FakeWorld();
      let ticks = 0;
      for (let i = 0; i < fps * 10; i++) ticks += w.k.advance(1000 / fps).ticks;
      expect(ticks, `${fps} fps`).toBe(300);
      expect(w.k.clock.tick).toBe(300);
      expect(w.k.metrics.droppedTicks).toBe(0);
    }
  });

  it('returns the interpolation alpha: the accumulated fraction of a tick', () => {
    const w = new FakeWorld();
    expect(w.k.advance(10)).toEqual({ ticks: 0, alpha: 10 / (1000 / 30) });
    const r = w.k.advance(30);
    expect(r.ticks).toBe(1);
    expect(r.alpha).toBeCloseTo((40 - 1000 / 30) / (1000 / 30), 9);
  });

  it('runs at most two ticks in one frame and drops the rest (a hitch is a brief slow-down, not a burst)', () => {
    const w = new FakeWorld();
    const r = w.k.advance(200); // six ticks of time
    expect(r.ticks).toBe(2);
    expect(w.k.metrics.droppedTicks).toBe(4);
    expect(r.alpha).toBeGreaterThanOrEqual(0);
    expect(r.alpha).toBeLessThan(1);
    expect(w.k.advance(1000 / 60).ticks).toBe(0); // nothing of the dropped backlog is left over
  });

  it('clamps a frame to 250 ms and ignores a negative or non-finite one', () => {
    const w = new FakeWorld();
    w.k.advance(10_000);
    expect(w.k.clock.tick).toBe(2);
    expect(w.k.metrics.droppedTicks).toBe(5); // 250 ms = 7.5 ticks: 2 run, 5 dropped, half a tick kept
    for (const bad of [-50, Number.NaN, Number.POSITIVE_INFINITY]) expect(w.k.advance(bad).ticks).toBe(0);
  });

  it('runs nothing while paused and nothing accumulates', () => {
    const w = new FakeWorld();
    w.k.clock.pause('overlay');
    for (let i = 0; i < 10; i++) expect(w.k.advance(100)).toEqual({ ticks: 0, alpha: 0 });
    w.k.clock.resume('overlay');
    expect(w.k.advance(20).ticks).toBe(0);
  });

  it('setTicksPerFrame (test builds) fast-forwards: n/2 sim seconds per real second, up to n ticks a frame, dt unchanged', () => {
    const w = new FakeWorld();
    const set = w.k.setTicksPerFrame;
    expect(typeof set).toBe('function');
    const dts = new Set<number>();
    w.spawn('r', { behaviors: [['scripts/r.js', { update: (_c: MiniCtx, dt: number) => dts.add(dt) }]] });
    set!.call(w.k, 8);
    let ticks = 0;
    for (let i = 0; i < 60; i++) ticks += w.k.advance(1000 / 60).ticks;
    expect(ticks).toBe(120); // one second of frames, timeScale(4)
    expect(dts).toEqual(new Set([1 / 30]));
    expect(w.k.advance(250).ticks).toBe(8);
    set!.call(w.k, 2);
    ticks = 0;
    for (let i = 0; i < 60; i++) ticks += w.k.advance(1000 / 60).ticks;
    expect(ticks).toBe(30);
    expect(() => set!.call(w.k, 3 as 2)).toThrow(RangeError);
  });
});

describe('kernel.runTicks (core §3.7)', () => {
  it('runs n ticks back to back, respects pause unless forced', () => {
    const w = new FakeWorld({ keepBoot: true });
    w.k.runTicks(3);
    expect(w.k.clock.tick).toBe(0);
    w.k.runTicks(3, { force: true }); // the Director pre-roll under `boot` (core §14 step 7)
    expect(w.k.clock.tick).toBe(3);
    w.k.clock.resume('boot');
    w.k.runTicks(30);
    expect(w.k.clock.tick).toBe(33);
  });

  it('stops an unforced run when a tick pauses the clock', () => {
    const w = new FakeWorld();
    w.k.on('tickEnd', (t) => {
      if (t === 2) w.k.clock.pause('test');
    });
    w.k.runTicks(10);
    expect(w.k.clock.tick).toBe(2);
  });

  it('refuses a re-entrant tick', () => {
    const w = new FakeWorld();
    let caught: unknown = null;
    w.k.on('tickEnd', () => {
      try {
        w.k.runTicks(1);
      } catch (e) {
        caught = e;
      }
    });
    w.k.runTicks(1);
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toMatch(/re-entrant/);
    expect(() => w.k.runTicks(1)).not.toThrow();
  });

  it('records tick wall time in the metrics', () => {
    const w = new FakeWorld();
    w.spawn('r', {
      behaviors: [
        [
          'scripts/slow.js',
          {
            update: () => {
              const t0 = performance.now();
              while (performance.now() - t0 < 1);
            },
          },
        ],
      ],
    });
    w.k.runTicks(40);
    expect(w.k.metrics.tickMsEwma).toBeGreaterThan(0.5);
    expect(w.k.metrics.tickMsP95).toBeGreaterThan(0.5);
  });
});
