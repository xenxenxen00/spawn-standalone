// pause/mute lifecycle (io §2.12, WP AU3 acceptance): pause ramps master to zero and suspends the context at
// PAUSE_SUSPEND_DELAY_MS (silence well within the 100 ms acceptance bound); resuming before the delay cancels the
// pending suspend; unpausing after an actual suspend resumes the context; pause dominates the user/platform mute
// matrix; a browser-side resume while a pause is held is undone. The engine half of unlock (needsUnlock, the
// unlock-before-init guard, the silent graph built while paused) is pinned here; the gesture wiring lives in
// unlock.node.test.ts (installUnlock) and is not duplicated. The PauseController (build §6.4) is wired to the real
// engine: every audio-suspending host reason silences it, kernel/test reasons never do, and the match escalation
// holds the pause for the re-lock click. Test-only except one production line: setPaused() is inert after dispose().
// Uses createAudioEngine directly, the FakeAudioContext and injected fake timers.
import { describe, expect, it } from 'vitest';
import type { SimClock } from '../../../src/compat/core/types.ts';
import { createAudioEngine, type AudioEngineCore } from '../../../src/runtime/audio/audio-engine.ts';
import { MUTE_TC_S, PAUSE_SUSPEND_DELAY_MS } from '../../../src/runtime/audio/limits.ts';
import { PauseController, type PageLike } from '../../../src/platform/pause-controller.ts';
import type { Platform } from '../../../src/platform/platform.ts';
import { FakeAudioContext, FakeGain } from './fake-context.ts';

/** manual clock for the engine's suspend timer: record, cancel and fire in schedule order.
 *  Each timer fires at (elapsed when scheduled) + delay: advance() moves total time forward. */
class FakeTimers {
  private seq = 0;
  private elapsed = 0;
  readonly pending = new Map<number, { fn: () => void; fireAt: number }>();
  /** the delays passed to setTimer, in call order */
  readonly scheduled: number[] = [];

  readonly setTimer = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.pending.set(id, { fn, fireAt: this.elapsed + ms });
    this.scheduled.push(ms);
    return id;
  };
  readonly clearTimer = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };
  /** move the clock forward by ms, firing every timer whose total fire time has elapsed */
  advance(ms: number): void {
    this.elapsed += ms;
    const due = [...this.pending.entries()]
      .filter(([, t]) => t.fireAt <= this.elapsed)
      .sort((a, b) => a[0] - b[0]);
    for (const [id, t] of due) {
      this.pending.delete(id);
      t.fn();
    }
  }
}

interface Rig {
  engine: AudioEngineCore;
  ctx: FakeAudioContext;
  timers: FakeTimers;
  master: () => FakeGain;
}

function makeRig(opts: { unlock?: boolean } = {}): Rig {
  const ctx = new FakeAudioContext({ state: 'running' });
  const timers = new FakeTimers();
  const engine = createAudioEngine({
    createContext: () => ctx,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  engine.init({ manifest: {}, tier: 'high', log: () => {} });
  if (opts.unlock !== false) engine.unlock();
  return {
    engine,
    ctx,
    timers,
    master: () => (engine.bus('sfx') as FakeGain).outputs[0] as FakeGain,
  };
}

describe('pause', () => {
  it('ramps master to zero and suspends the context at the configured delay (silence within 100 ms)', () => {
    const { engine, ctx, timers, master } = makeRig();
    ctx.currentTime = 5;
    engine.setPaused(true);
    expect(master().gain.last()).toEqual({ type: 'target', value: 0, time: 5, tc: MUTE_TC_S });
    expect(master().gain.value).toBe(0);
    // the suspend is delayed, not immediate; it fires at the configured delay, inside the 100 ms acceptance bound
    expect(timers.scheduled).toEqual([PAUSE_SUSPEND_DELAY_MS]);
    expect(PAUSE_SUSPEND_DELAY_MS).toBeLessThanOrEqual(100);
    timers.advance(PAUSE_SUSPEND_DELAY_MS - 1);
    expect(ctx.calls).toEqual([]);
    expect(ctx.state).toBe('running');
    timers.advance(1); // the final millisecond: exactly one suspend, at exactly the configured delay
    expect(ctx.calls).toEqual(['suspend']);
    expect(ctx.state).toBe('suspended');
  });

  it('resuming before the delayed suspend cancels it', () => {
    const { engine, ctx, timers, master } = makeRig();
    engine.setPaused(true);
    expect(timers.pending.size).toBe(1);
    engine.setPaused(false);
    expect(timers.pending.size).toBe(0);
    timers.advance(PAUSE_SUSPEND_DELAY_MS);
    expect(ctx.calls).toEqual([]);
    expect(ctx.state).toBe('running');
    expect(master().gain.last()).toEqual({ type: 'target', value: 1, time: ctx.currentTime, tc: MUTE_TC_S });
  });

  it('unpausing after an actual suspend resumes the context', () => {
    const { engine, ctx, timers, master } = makeRig();
    engine.setPaused(true);
    timers.advance(PAUSE_SUSPEND_DELAY_MS);
    expect(ctx.state).toBe('suspended');
    engine.setPaused(false);
    expect(ctx.calls).toEqual(['suspend', 'resume']);
    expect(ctx.state).toBe('running');
    expect(master().gain.value).toBe(1);
  });

  it('a re-pause schedules its suspend from the re-pause, not the first pause', () => {
    const { engine, ctx, timers } = makeRig();
    engine.setPaused(true);
    timers.advance(30); // 30 ms into the first pause: no suspend yet
    expect(ctx.calls).toEqual([]);
    engine.setPaused(false);
    engine.setPaused(true); // re-paused at t=30: the suspend is due at t=70, not t=40
    timers.advance(10);
    expect(ctx.calls).toEqual([]);
    expect(ctx.state).toBe('running');
    timers.advance(30);
    expect(ctx.calls).toEqual(['suspend']);
    expect(ctx.state).toBe('suspended');
  });

  it('a browser-side resume while a pause is held is undone', () => {
    const { engine, ctx, timers } = makeRig();
    engine.setPaused(true);
    timers.advance(PAUSE_SUSPEND_DELAY_MS - 1);
    expect(ctx.calls).toEqual([]);
    timers.advance(1); // the delayed suspend ran; no timer is outstanding
    ctx.resume(); // someone else resumes, e.g. a gesture handler racing the pause
    expect(ctx.calls).toEqual(['suspend', 'resume', 'suspend']);
    expect(ctx.state).toBe('suspended');
  });
});

describe('mute interaction', () => {
  it('pause dominates the user/platform mute matrix and really suspends', () => {
    const { engine, ctx, timers, master } = makeRig();
    engine.setUserMuted(true);
    expect(master().gain.value).toBe(0);
    engine.setPaused(true);
    engine.setUserMuted(false); // unmuting under a pause stays silent
    expect(master().gain.value).toBe(0);
    timers.advance(PAUSE_SUSPEND_DELAY_MS);
    expect(ctx.calls).toEqual(['suspend']); // the pause silences for real, not just the gain
    engine.setPaused(false);
    expect(ctx.calls).toEqual(['suspend', 'resume']);
    expect(master().gain.value).toBe(1);

    engine.setPlatformAudio(false);
    expect(master().gain.value).toBe(0);
    expect(timers.pending.size).toBe(0); // a platform mute is not a pause: no suspend is scheduled
    engine.setPaused(true); // the platform mute is set while the pause is held
    engine.setPaused(false); // and outlives the pause
    expect(master().gain.value).toBe(0);
    expect(timers.pending.size).toBe(0);
    engine.setPlatformAudio(true);
    expect(master().gain.value).toBe(1);
  });

  it('unpausing after an actual suspend keeps a mute that was set while suspended', () => {
    const { engine, ctx, timers, master } = makeRig();
    engine.setPaused(true);
    timers.advance(PAUSE_SUSPEND_DELAY_MS);
    engine.setUserMuted(true);
    engine.setPaused(false);
    expect(ctx.state).toBe('running');
    expect(master().gain.value).toBe(0);
    engine.setUserMuted(false);
    expect(master().gain.value).toBe(1);
  });
});

describe('unlock / needsUnlock (engine)', () => {
  it('unlock before init logs once and creates nothing; works after init', () => {
    const ctx = new FakeAudioContext({ state: 'running' });
    let made = 0;
    const engine = createAudioEngine({
      createContext: () => {
        made++;
        return ctx;
      },
    });
    const warns: string[] = [];
    const prev = console.warn;
    console.warn = (m?: unknown) => {
      warns.push(String(m));
    };
    try {
      engine.unlock();
      engine.unlock();
      expect(made).toBe(0);
      expect(engine.needsUnlock()).toBe(false); // unusable before init: never unlockable
      engine.init({ manifest: {}, tier: 'high', log: () => {} });
      engine.unlock();
      expect(made).toBe(1);
      expect(engine.needsUnlock()).toBe(false);
    } finally {
      console.warn = prev;
    }
    expect(warns.filter((w) => w.includes('unlock() before init()'))).toHaveLength(1);
  });

  it('unlock while paused builds the graph silent and suspends a running context immediately', () => {
    const { engine, ctx, timers, master } = makeRig({ unlock: false });
    engine.setPaused(true);
    expect(timers.pending.size).toBe(0); // no context yet: nothing to suspend
    engine.unlock();
    expect(master().gain.value).toBe(0); // the graph is built silent: no audible blip on unlock
    expect(ctx.calls).toEqual(['suspend']); // immediate suspend, not the delayed one
    expect(timers.pending.size).toBe(0);
    expect(engine.needsUnlock()).toBe(false); // the pause holds: a gesture would not help
    expect(ctx.sources().filter((s) => s.buffer?.length === 1 && s.started)).toHaveLength(1); // primed in the gesture
    engine.setPaused(false);
    expect(ctx.calls).toEqual(['suspend', 'resume']);
    expect(master().gain.value).toBe(1);
  });

  it('dispose makes the engine inert to further pause input', () => {
    const { engine, ctx, timers, master } = makeRig();
    const events = master().gain.events.length;
    engine.dispose();
    engine.setPaused(true);
    engine.setPaused(false);
    expect(timers.pending.size).toBe(0); // no suspend timer may be scheduled after dispose
    expect(master().gain.events.length).toBe(events); // the closed context's master is untouched
    expect(ctx.calls).toEqual(['close']);
  });
});

describe('pause controller → engine (build §6.4)', () => {
  class TestClock {
    readonly reasons = new Set<string>();
    pause(r: string): void {
      this.reasons.add(r);
    }
    resume(r: string): void {
      this.reasons.delete(r);
    }
  }

  class TestPlatform {
    platformPaused = false;
    platformMuted = false;
    private readonly handlers = new Map<string, Array<(...args: any[]) => void>>();
    on(event: string, listener: (...args: any[]) => void): () => void {
      const list = this.handlers.get(event) ?? [];
      list.push(listener);
      this.handlers.set(event, list);
      return () => {
        const l = this.handlers.get(event);
        if (l) {
          const i = l.indexOf(listener);
          if (i >= 0) l.splice(i, 1);
        }
      };
    }
    emit(event: string, ...args: any[]): void {
      for (const fn of [...(this.handlers.get(event) ?? [])]) fn(...args);
    }
  }

  interface ControlRig extends Rig {
    clock: TestClock;
    controller: PauseController;
    pausedEdges: boolean[];
  }

  function makeControlRig(): ControlRig {
    const base = makeRig();
    const clock = new TestClock();
    const pausedEdges: boolean[] = [];
    const orig = base.engine.setPaused.bind(base.engine);
    base.engine.setPaused = (p: boolean): void => {
      pausedEdges.push(p);
      orig(p);
    };
    const controller = new PauseController(clock as unknown as SimClock, base.engine);
    return { ...base, clock, controller, pausedEdges };
  }

  const SUSPENDING = ['platform', 'hidden', 'overlay', 'orientation', 'gpu'] as const;

  it('every audio-suspending host reason silences the engine; its removal resumes it', () => {
    for (const reason of SUSPENDING) {
      const { engine, ctx, timers, clock, controller, pausedEdges, master } = makeControlRig();
      controller.add(reason);
      expect([...clock.reasons]).toEqual([reason]); // no escalation outside a match
      expect(pausedEdges).toEqual([true]);
      expect(master().gain.last()).toEqual({ type: 'target', value: 0, time: 0, tc: MUTE_TC_S });
      timers.advance(PAUSE_SUSPEND_DELAY_MS); // silence well within the 100 ms acceptance bound
      expect(ctx.calls).toEqual(['suspend']);
      controller.remove(reason);
      expect(pausedEdges).toEqual([true, false]);
      expect(ctx.calls).toEqual(['suspend', 'resume']);
      expect(engine.needsUnlock()).toBe(false);
    }
  });

  it('overlapping reasons drive one suspend; the last removal resumes', () => {
    const { controller, pausedEdges, timers, ctx } = makeControlRig();
    controller.add('platform');
    controller.add('hidden');
    controller.remove('platform');
    expect(pausedEdges).toEqual([true]); // 'hidden' still holds: no unpause edge
    timers.advance(PAUSE_SUSPEND_DELAY_MS);
    expect(ctx.calls).toEqual(['suspend']); // exactly one suspend for the overlapping reasons
    controller.remove('hidden');
    expect(pausedEdges).toEqual([true, false]);
    expect(ctx.calls).toEqual(['suspend', 'resume']);
  });

  it('boot, loading, preparing and test never silence audio', () => {
    const { clock, controller, pausedEdges, ctx, master } = makeControlRig();
    for (const reason of ['boot', 'loading', 'preparing'] as const) {
      clock.pause(reason); // kernel reasons bypass add(): they are not host reasons
      controller.refresh();
    }
    controller.add('test'); // host-shaped, but never audio-suspending
    controller.refresh();
    expect(pausedEdges).toEqual([]);
    expect(ctx.calls).toEqual([]);
    expect(master().gain.value).toBe(1);
    expect([...clock.reasons].sort()).toEqual(['boot', 'loading', 'preparing', 'test']);
  });

  it('a match escalation holds the pause for the re-lock click', () => {
    const { clock, controller, pausedEdges, timers, ctx } = makeControlRig();
    controller.setGameplayActive(true);
    controller.add('platform');
    expect([...clock.reasons].sort()).toEqual(['overlay', 'platform']);
    controller.remove('platform');
    expect(pausedEdges).toEqual([true]); // overlay still holds: no unpause edge
    timers.advance(PAUSE_SUSPEND_DELAY_MS);
    expect(ctx.calls).toEqual(['suspend']);
    controller.remove('overlay'); // the re-lock click
    expect(pausedEdges).toEqual([true, false]);
    expect(ctx.calls).toEqual(['suspend', 'resume']);
  });

  it('bindPage: hidden suspends, visible resumes; blur and focus do the same', () => {
    const { controller, pausedEdges, timers, ctx } = makeControlRig();
    let visibilityState: 'visible' | 'hidden' = 'visible';
    let focused = true;
    const docTarget = new EventTarget();
    const winTarget = new EventTarget();
    const doc = {
      get visibilityState() {
        return visibilityState;
      },
      hasFocus: () => focused,
      addEventListener: docTarget.addEventListener.bind(docTarget),
      removeEventListener: docTarget.removeEventListener.bind(docTarget),
      dispatchEvent: docTarget.dispatchEvent.bind(docTarget),
    };
    const page: PageLike = { document: doc, window: winTarget };
    const unbind = controller.bindPage(page);
    visibilityState = 'hidden';
    docTarget.dispatchEvent(new Event('visibilitychange'));
    expect(pausedEdges).toEqual([true]);
    timers.advance(PAUSE_SUSPEND_DELAY_MS);
    expect(ctx.calls).toEqual(['suspend']);
    visibilityState = 'visible';
    docTarget.dispatchEvent(new Event('visibilitychange')); // visible + focused clears the blur flag
    expect(pausedEdges).toEqual([true, false]);
    winTarget.dispatchEvent(new Event('blur'));
    expect(pausedEdges).toEqual([true, false, true]);
    winTarget.dispatchEvent(new Event('focus'));
    expect(pausedEdges).toEqual([true, false, true, false]);
    unbind();
    visibilityState = 'hidden';
    docTarget.dispatchEvent(new Event('visibilitychange'));
    expect(pausedEdges).toEqual([true, false, true, false]); // unbound: no further edges
  });

  it('bindPlatform applies the current state first and wires pause/mute events', () => {
    const { controller, pausedEdges, timers, ctx, master } = makeControlRig();
    const platform = new TestPlatform();
    platform.platformMuted = true;
    const unbind = controller.bindPlatform(platform as unknown as Platform);
    expect(master().gain.value).toBe(0); // the current mute applies before any event
    expect(pausedEdges).toEqual([]); // a mute is not a pause: no suspend timer
    expect(timers.pending.size).toBe(0);
    platform.emit('platformMute', false);
    expect(master().gain.value).toBe(1);
    platform.emit('platformPause', true);
    expect(pausedEdges).toEqual([true]);
    expect(timers.pending.size).toBe(1);
    timers.advance(PAUSE_SUSPEND_DELAY_MS);
    expect(ctx.calls).toEqual(['suspend']); // the platform pause really suspends the context
    platform.emit('platformPause', false);
    expect(pausedEdges).toEqual([true, false]);
    expect(ctx.calls).toEqual(['suspend', 'resume']);
    platform.emit('adPause');
    platform.emit('adResume');
    expect(pausedEdges).toEqual([true, false, true, false]);
    expect(ctx.calls).toEqual(['suspend', 'resume']); // the ad timer never fired
    expect(timers.pending.size).toBe(0);
    unbind();
    platform.emit('platformPause', true);
    expect(pausedEdges).toEqual([true, false, true, false]); // unbound: no further edges
    expect(timers.pending.size).toBe(0);
  });
});
