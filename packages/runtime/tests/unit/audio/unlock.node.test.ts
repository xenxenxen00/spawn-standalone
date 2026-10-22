// unlock (io §2.12, X-33): the engine exists from boot without a context; the first gesture (pointerdown, keydown or touchend
// on window, capture phase) creates the AudioContext and resumes it, plays a 1-sample silent buffer and sets the iOS audio
// session to 'playback'. Later gestures create nothing; a context the browser suspended on its own is resumed by the next
// gesture or by the page becoming visible, but never one we suspended for a pause.
import { describe, expect, it } from 'vitest';
import { installUnlock } from '../../../src/runtime/audio/unlock.ts';
import { FakeAudioContext } from './fake-context.ts';
import { makeEngine } from './helpers.ts';

class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
  show(): void {
    this.visibilityState = 'visible';
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

class RecordingWindow extends EventTarget {
  added: Array<{ type: string; capture: boolean }> = [];
  override addEventListener(type: string, cb: EventListenerOrEventListenerObject | null, opts?: AddEventListenerOptions | boolean): void {
    this.added.push({ type, capture: typeof opts === 'boolean' ? opts : !!opts?.capture });
    super.addEventListener(type, cb, opts);
  }
}

function setup(opts: { ctxState?: 'running' | 'suspended'; audioSession?: { type: string } | null } = {}) {
  const rig = makeEngine({ unlock: false, ctx: { state: opts.ctxState ?? 'suspended' } });
  const win = new RecordingWindow();
  const doc = new FakeDocument();
  const nav = opts.audioSession === null ? {} : { audioSession: opts.audioSession ?? { type: 'auto' } };
  const unlock = installUnlock(rig.engine, { target: win, document: doc, navigator: nav });
  return { ...rig, win, doc, nav, unlock };
}

const gesture = (t: EventTarget, type = 'pointerdown'): boolean => t.dispatchEvent(new Event(type));

describe('unlock', () => {
  it('listens on window in the capture phase for pointerdown, keydown and touchend', () => {
    const { win } = setup();
    expect(win.added).toEqual([
      { type: 'pointerdown', capture: true },
      { type: 'keydown', capture: true },
      { type: 'touchend', capture: true },
    ]);
  });

  it('creates and resumes the context on the first gesture, once', () => {
    const { engine, ctx, win, contexts, unlock } = setup();
    expect(contexts()).toBe(0);
    expect(engine.ready).toBe(false);
    expect(unlock.unlocked).toBe(false);
    gesture(win);
    expect(contexts()).toBe(1);
    expect(ctx.calls).toEqual(['resume']);
    expect(engine.ready).toBe(true);
    expect(unlock.unlocked).toBe(true);
    // the silent 1-sample buffer, started inside the gesture
    const prime = ctx.sources()[0]!;
    expect(prime.buffer!.length).toBe(1);
    expect(prime.started).not.toBeNull();
    gesture(win, 'keydown');
    gesture(win, 'touchend');
    expect(contexts()).toBe(1);
    expect(ctx.calls).toEqual(['resume']);
    expect(ctx.sources()).toHaveLength(1);
  });

  it('keydown and touchend unlock as well', () => {
    for (const type of ['keydown', 'touchend']) {
      const { win, contexts, engine } = setup();
      gesture(win, type);
      expect(contexts()).toBe(1);
      expect(engine.ready).toBe(true);
    }
  });

  it("sets navigator.audioSession.type = 'playback' when the property exists (iOS ringer switch)", () => {
    const withSession = setup();
    gesture(withSession.win);
    expect(withSession.nav).toEqual({ audioSession: { type: 'playback' } });
    const without = setup({ audioSession: null });
    expect(() => gesture(without.win)).not.toThrow();
  });

  it('resumes a context the browser suspended on its own at the next gesture or when the page is visible', () => {
    const { engine, ctx, win, doc } = setup();
    gesture(win);
    ctx.externalState('interrupted');
    expect(engine.ready).toBe(false);
    expect(engine.needsUnlock()).toBe(true);
    gesture(win);
    expect(ctx.state).toBe('running');
    ctx.externalState('suspended');
    doc.show();
    expect(ctx.state).toBe('running');
    expect(engine.needsUnlock()).toBe(false);
  });

  it('never resumes a context suspended for a pause', async () => {
    const { engine, ctx, win, doc } = setup();
    gesture(win);
    engine.setPaused(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(ctx.state).toBe('suspended');
    expect(engine.needsUnlock()).toBe(false);
    gesture(win);
    doc.show();
    expect(ctx.state).toBe('suspended');
    engine.setPaused(false);
    expect(ctx.state).toBe('running');
  });

  it('a gesture while paused still creates the context, which stays suspended until the pause ends', () => {
    const { engine, ctx, win, contexts } = setup({ ctxState: 'running' });
    engine.setPaused(true);
    gesture(win);
    expect(contexts()).toBe(1);
    expect(ctx.state).toBe('suspended');
    engine.setPaused(false);
    expect(ctx.state).toBe('running');
  });

  it('runs onUnlock inside each unlocking gesture (media priming hook), not on idle gestures', () => {
    const rig = makeEngine({ unlock: false, ctx: { state: 'suspended' } });
    const win = new EventTarget();
    let primed = 0;
    installUnlock(rig.engine, { target: win, document: null, navigator: null, onUnlock: () => primed++ });
    gesture(win);
    gesture(win);
    expect(primed).toBe(1);
    rig.ctx.externalState('interrupted');
    gesture(win, 'touchend');
    expect(primed).toBe(2);
  });

  it('dispose removes the listeners', () => {
    const { win, unlock, contexts } = setup();
    unlock.dispose();
    gesture(win);
    expect(contexts()).toBe(0);
  });
});
