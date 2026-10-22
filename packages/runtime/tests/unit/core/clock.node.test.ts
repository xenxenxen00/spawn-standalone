// The pausable sim clock (docs/design/core-runtime.md §9.1, D-CORE-09; docs/architecture.md X-07, §4.1): pause reasons,
// `now` frozen while paused, no catch-up burst on resume, and the `loading` pause a cross sets at the end of its tick.
import { describe, expect, it, vi } from 'vitest';
import { SimClockImpl, nowAtTick } from '../../../src/compat/core/sched/clock.ts';
import { ENGINE, PAUSE_REASONS } from '../../../src/compat/core/rules.ts';
import type { PauseReason } from '../../../src/compat/core/types.ts';
import { FakeWorld, recordingPorts } from './fakes/tick-world.ts';

const FRAME_MS = 1000 / 60;

describe('SimClockImpl: ticks and now (core §9.1, contract §7.1)', () => {
  it('starts at tick 0 with now at the 1,000,000 ms epoch (core §17.5)', () => {
    const c = new SimClockImpl();
    expect(c.tick).toBe(0);
    expect(c.now()).toBe(ENGINE.NOW_EPOCH_MS);
    expect(c.running).toBe(true);
  });

  it('now = epoch + tick·1000/30, exact on every third tick (the 100 ms sim cadence)', () => {
    const c = new SimClockImpl();
    const seen: number[] = [];
    for (let i = 0; i < 90; i++) seen.push(c.advance());
    expect(seen[0]).toBe(1);
    expect(c.tick).toBe(90);
    expect(c.now()).toBe(1_003_000);
    for (const t of [3, 6, 30, 300, 3000, 30_000]) expect(nowAtTick(t)).toBe(ENGINE.NOW_EPOCH_MS + t * (100 / 3));
    expect(nowAtTick(3)).toBe(1_000_100);
    expect(nowAtTick(30)).toBe(1_001_000);
    expect(nowAtTick(1)).toBeCloseTo(1_000_033.333, 3);
  });

  it('now is constant between advances (within a tick)', () => {
    const c = new SimClockImpl();
    c.advance();
    expect(c.now()).toBe(c.now());
  });
});

describe('SimClockImpl: pause reasons (X-07)', () => {
  it('runs only while no reason is set; pause and resume are idempotent per reason', () => {
    const c = new SimClockImpl(['boot']);
    expect(c.running).toBe(false);
    expect([...c.reasons]).toEqual(['boot']);
    c.pause('ad');
    c.pause('ad');
    expect([...c.reasons].sort()).toEqual(['ad', 'boot']);
    c.resume('boot');
    expect(c.running).toBe(false);
    c.resume('ad');
    c.resume('ad');
    c.resume('hidden');
    expect(c.running).toBe(true);
    expect(c.reasons.size).toBe(0);
  });

  it('accepts nonempty host reasons and refuses invalid values', () => {
    const c = new SimClockImpl();
    for (const r of PAUSE_REASONS) c.pause(r);
    expect(c.reasons.size).toBe(PAUSE_REASONS.length);
    expect(() => c.pause('menu')).not.toThrow();
    expect(c.reasons.has('menu')).toBe(true);
    expect(() => c.resume('' as PauseReason)).toThrow(TypeError);
  });

  it('hands out read-only snapshots: a cast-and-mutate never reaches the clock', () => {
    const c = new SimClockImpl(['boot']);
    const r = c.reasons as Set<PauseReason>;
    r.clear();
    expect(c.running).toBe(false);
    expect(c.reasons.has('boot')).toBe(true);
  });

  it('tells listeners about every change of the reason set, with the change', () => {
    const c = new SimClockImpl();
    const seen: string[] = [];
    const off = c.onChange((running, reasons, ch) => seen.push(`${running}:${[...reasons].join('+')}:${ch.added ? '+' : '-'}${ch.reason}`));
    c.pause('platform');
    c.pause('platform');
    c.pause('overlay');
    c.resume('platform');
    c.resume('overlay');
    c.resume('overlay');
    off();
    c.pause('gpu');
    expect(seen).toEqual(['false:platform:+platform', 'false:platform+overlay:+overlay', 'false:overlay:-platform', 'true::-overlay']);
  });
});

describe('the kernel clock under advance() (core §9.1, §9.7; docs/architecture.md §4.1)', () => {
  it('is created paused with `boot` (core §14 step 3; the kernel owns that reason)', () => {
    const w = new FakeWorld({ keepBoot: true });
    expect(w.k.clock.running).toBe(false);
    expect([...w.k.clock.reasons]).toEqual(['boot']);
    expect(w.k.advance(100)).toEqual({ ticks: 0, alpha: 0 });
    expect(w.k.clock.tick).toBe(0);
  });

  it('freezes now while paused: no ticks, no timers, nothing advances', () => {
    const w = new FakeWorld();
    const updates: number[] = [];
    w.spawn('a', { behaviors: [['scripts/a.js', { update: (ctx: { now(): number }) => updates.push(ctx.now()) }]] });
    for (let i = 0; i < 12; i++) w.k.advance(FRAME_MS);
    const tick = w.k.clock.tick;
    const now = w.k.clock.now();
    expect(tick).toBe(6);
    w.k.clock.pause('ad');
    for (let i = 0; i < 600; i++) w.k.advance(FRAME_MS); // ten seconds of frames under an ad
    expect(w.k.clock.tick).toBe(tick);
    expect(w.k.clock.now()).toBe(now);
    expect(updates.length).toBe(6);
  });

  it('resumes without a catch-up burst and tells the input port to drop edges captured while paused', () => {
    const trace: string[] = [];
    const w = new FakeWorld({ ports: recordingPorts(trace) });
    for (let i = 0; i < 6; i++) w.k.advance(FRAME_MS);
    expect(w.k.clock.tick).toBe(3);
    w.k.advance(FRAME_MS); // half a tick in the accumulator
    w.k.clock.pause('hidden');
    for (let i = 0; i < 300; i++) w.k.advance(250);
    trace.length = 0;
    w.k.clock.resume('hidden');
    expect(trace).toEqual(['input.discardEdges']);
    const r = w.k.advance(FRAME_MS);
    expect(r.ticks).toBe(0); // the half tick from before the pause was dropped with the accumulator
    expect(w.k.advance(FRAME_MS).ticks).toBe(1);
    expect(w.k.clock.tick).toBe(4);
  });

  it('fires the `paused` KernelEvent with every reason change', () => {
    const w = new FakeWorld();
    const seen: string[] = [];
    w.k.on('paused', (paused, reasons) => seen.push(`${paused}:${[...reasons].sort().join('+')}`));
    w.k.clock.pause('platform');
    w.k.clock.pause('overlay');
    w.k.clock.resume('platform');
    w.k.clock.resume('overlay');
    expect(seen).toEqual(['true:platform', 'true:overlay+platform', 'true:overlay', 'false:']);
  });

  it('a pause set by a tick-end subscriber stops the second tick of the same frame', () => {
    const w = new FakeWorld();
    w.k.on('tickEnd', (t) => {
      if (t === 1) w.k.clock.pause('preparing');
    });
    const r = w.k.advance(70); // two ticks of time
    expect(r.ticks).toBe(1);
    expect(w.k.clock.tick).toBe(1);
  });
});

describe('the `loading` pause during a cross (core §11.5 step 2)', () => {
  it('lands at the end of the tick that asked for it: the rest of the tick runs, the next one does not, now stays frozen', () => {
    const w = new FakeWorld();
    const log: string[] = [];
    let crossAt = -1;
    w.spawn('player/local', {
      vm: 'client',
      player: { userId: 'u1' },
      behaviors: [
        [
          'scripts/body.js',
          {
            update: (ctx: { now(): number }) => {
              log.push(`update ${w.k.clock.tick}`);
              if (w.k.clock.tick === 5 && crossAt < 0) {
                crossAt = w.k.clock.tick;
                // what C4's ctx.cross does when the target place is not resident (core §11.5-11.6)
                w.time.scheduler.pauseAtTickEnd('loading');
                log.push(`running after the ask: ${w.k.clock.running}`); // still true: the tick finishes first
                log.push(`cross asked at ${ctx.now()}`);
              }
            },
          },
        ],
      ],
    });
    w.addSim('sim', null, { tick: () => log.push(`sim ${w.k.clock.tick}`) });
    const tickEnds: Array<[number, boolean]> = [];
    w.k.on('tickEnd', (t) => tickEnds.push([t, w.k.clock.running]));

    for (let i = 0; i < 6; i++) w.k.advance(1000 / 30); // ticks 1..6, paused after tick 5
    expect(crossAt).toBe(5);
    expect(log).toContain('running after the ask: true');
    expect(w.k.clock.tick).toBe(5);
    expect([...w.k.clock.reasons]).toEqual(['loading']);
    expect(log).toContain('sim 5'); // step F of the crossing tick still ran (5 % 3 === 2)
    expect(tickEnds.at(-1)).toEqual([5, false]); // tickEnd already sees the pause
    const frozen = w.k.clock.now();
    for (let i = 0; i < 90; i++) w.k.advance(FRAME_MS); // the place streams in
    expect(w.k.clock.now()).toBe(frozen);
    expect(log.filter((l) => l.startsWith('update')).length).toBe(5);

    w.k.clock.resume('loading'); // the sim-side load finished
    let ticks = 0;
    for (let i = 0; i < 4; i++) ticks += w.k.advance(FRAME_MS).ticks;
    expect(ticks).toBe(2); // two ticks for four frames: no catch-up for the time spent loading
    expect(w.k.clock.tick).toBe(7);
  });

  it('outside a tick it pauses at once', () => {
    const w = new FakeWorld();
    w.time.scheduler.pauseAtTickEnd('loading');
    expect(w.k.clock.running).toBe(false);
  });

  it('a spy on discardEdges sees one call per resume to running, none per reason change while still paused', () => {
    const ports = recordingPorts([]);
    const spy = vi.spyOn(ports.input!, 'discardEdges');
    const w = new FakeWorld({ ports });
    expect(spy).toHaveBeenCalledTimes(1); // the world resumed `boot`
    spy.mockClear();
    w.k.clock.pause('ad');
    w.k.clock.pause('overlay');
    w.k.clock.resume('ad');
    expect(spy).not.toHaveBeenCalled();
    w.k.clock.resume('overlay');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
