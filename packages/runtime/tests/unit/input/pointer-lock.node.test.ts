// pointer-lock (io §4.4, §4.6, §3.9; X-07): the plain requestPointerLock() call as under Spawn (the measured live scale was taken
// under ordinary pointer lock, OS acceleration included); { unadjustedMovement: true } only with RAW MOUSE INPUT (port.rawMouse).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PointerLockManager, RELOCK_COOLDOWN_MS, type LockState } from '../../../src/runtime/input/pointer-lock.ts';

class FakeCanvas extends EventTarget {
  calls: unknown[][] = [];
  /** what the next request answers: resolve (and lock), or reject with this error name */
  next: 'lock' | 'pending' | string = 'lock';
  doc: FakeDoc | null = null;
  requestPointerLock(...args: unknown[]): Promise<void> {
    this.calls.push(args);
    const answer = this.next;
    if (answer === 'pending') return new Promise(() => {});
    if (answer === 'lock') {
      queueMicrotask(() => this.doc!.lockTo(this));
      return Promise.resolve();
    }
    const err = Object.assign(new Error(answer), { name: answer });
    queueMicrotask(() => this.doc!.dispatchEvent(new Event('pointerlockerror')));
    return Promise.reject(err);
  }
}

class FakeDoc extends EventTarget {
  pointerLockElement: unknown = null;
  exits = 0;
  lockTo(el: unknown): void {
    this.pointerLockElement = el;
    this.dispatchEvent(new Event('pointerlockchange'));
  }
  exitPointerLock(): void {
    this.exits++;
    this.unlock();
  }
  unlock(): void {
    if (this.pointerLockElement === null) return;
    this.pointerLockElement = null;
    this.dispatchEvent(new Event('pointerlockchange'));
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

interface Rig {
  canvas: FakeCanvas;
  doc: FakeDoc;
  pauses: string[];
  removals: string[];
  mgr: PointerLockManager;
  states: LockState[];
}

let rigs: PointerLockManager[] = [];
afterEach(() => {
  for (const m of rigs) m.dispose();
  rigs = [];
});

function setup(opts: { rawMouse?: boolean; touchActive?: () => boolean } = {}): Rig {
  const canvas = new FakeCanvas();
  const doc = new FakeDoc();
  canvas.doc = doc;
  const pauses: string[] = [];
  const removals: string[] = [];
  const mgr = new PointerLockManager({
    canvas,
    document: doc,
    pause: { add: (r) => void pauses.push(r), remove: (r) => void removals.push(r) },
    ...(opts.rawMouse !== undefined ? { rawMouse: opts.rawMouse } : {}),
    ...(opts.touchActive ? { touchActive: opts.touchActive } : {}),
  });
  rigs.push(mgr);
  const states: LockState[] = [];
  mgr.onChange((s) => void states.push(s));
  return { canvas, doc, pauses, removals, mgr, states };
}

describe('the request', () => {
  it('by default: the plain call, no options (as under Spawn)', async () => {
    const { canvas, mgr, states } = setup();
    expect(mgr.rawMouse).toBe(false);
    mgr.requestLock('canvas');
    expect(canvas.calls).toEqual([[]]);
    expect(canvas.calls[0]).toHaveLength(0);
    expect(mgr.state).toBe('locking');
    await flush();
    expect(mgr.state).toBe('locked');
    expect(states).toEqual(['locking', 'locked']);
  });

  it('with port.rawMouse: { unadjustedMovement: true }', async () => {
    const { canvas, mgr } = setup({ rawMouse: true });
    mgr.requestLock('canvas');
    expect(canvas.calls).toEqual([[{ unadjustedMovement: true }]]);
    await flush();
    expect(mgr.state).toBe('locked');
    expect(mgr.rawSupported).toBe(true);
  });

  it('raw input rejected by the browser: falls back to the plain call and reports "not supported"', async () => {
    const { canvas, mgr } = setup({ rawMouse: true });
    canvas.next = 'NotSupportedError';
    mgr.requestLock('canvas');
    canvas.next = 'lock';
    await flush();
    expect(canvas.calls).toEqual([[{ unadjustedMovement: true }], []]);
    expect(mgr.rawSupported).toBe(false);
    expect(mgr.state).toBe('locked');
    // later requests stay plain
    mgr.setModal(true);
    mgr.setModal(false);
    mgr.requestLock('ui');
    expect(canvas.calls.at(-1)).toEqual([]);
  });

  it('toggling the setting while locked re-requests the lock with or without the option', async () => {
    const { canvas, mgr } = setup();
    mgr.requestLock('canvas');
    await flush();
    mgr.setRawMouse(true);
    expect(canvas.calls.at(-1)).toEqual([{ unadjustedMovement: true }]);
    await flush();
    mgr.setRawMouse(false);
    expect(canvas.calls.at(-1)).toEqual([]);
    mgr.setRawMouse(false);
    expect(canvas.calls).toHaveLength(3);
  });

  it('toggling the setting while free does not request (that needs a gesture)', () => {
    const { canvas, mgr } = setup();
    mgr.setRawMouse(true);
    expect(canvas.calls).toEqual([]);
    mgr.requestLock('canvas');
    expect(canvas.calls).toEqual([[{ unadjustedMovement: true }]]);
  });

  it('a canvas click requests the lock (desktop, no modal)', () => {
    const { canvas } = setup();
    canvas.dispatchEvent(new Event('click'));
    expect(canvas.calls).toEqual([[]]);
  });

  it('a request while locking or locked is not repeated', async () => {
    const { canvas, mgr } = setup();
    canvas.next = 'pending';
    mgr.requestLock('canvas');
    mgr.requestLock('canvas');
    expect(canvas.calls).toHaveLength(1);
  });

  it('a synchronous throw (old browsers) is an error, not a crash', () => {
    const { canvas, mgr } = setup();
    canvas.requestPointerLock = () => {
      throw new Error('nope');
    };
    expect(() => mgr.requestLock('canvas')).not.toThrow();
    expect(mgr.state).toBe('cooldown');
  });
});

describe('modal, touch and match rules (io §3.9)', () => {
  it('a modal releases the lock and the canvas stops requesting it; a UI click (relockPointer) still may', async () => {
    const { canvas, doc, mgr } = setup();
    mgr.requestLock('canvas');
    await flush();
    mgr.setModal(true);
    expect(doc.exits).toBe(1);
    expect(mgr.state).toBe('free');
    canvas.dispatchEvent(new Event('click'));
    mgr.requestLock('canvas');
    expect(canvas.calls).toHaveLength(1);
    mgr.requestLock('ui');
    expect(canvas.calls).toHaveLength(2);
  });

  it('the click that closes a modal re-locks, and the modal still reported for a frame or two does not undo it', async () => {
    const { doc, mgr } = setup();
    mgr.setModal(true); // the shop is open
    mgr.requestLock('ui'); // its CLOSE button: sendAction('ss_ui', …, {relockPointer: true})
    mgr.setModal(true); // the UI host's next frame: the body has not closed the panel yet
    await flush();
    mgr.setModal(true);
    expect(mgr.state).toBe('locked');
    expect(doc.exits).toBe(0);
    mgr.setModal(false); // the panel is gone
    mgr.setModal(true); // a new panel opens (M): the lock is released
    expect(doc.exits).toBe(1);
    expect(mgr.state).toBe('free');
  });

  it('touch active: the lock is never requested', () => {
    let touch = true;
    const { canvas, mgr } = setup({ touchActive: () => touch });
    mgr.requestLock('canvas');
    mgr.requestLock('ui');
    mgr.requestLock('resume');
    expect(canvas.calls).toEqual([]);
    touch = false;
    mgr.requestLock('resume');
    expect(canvas.calls).toHaveLength(1);
  });

  it('lock lost with no modal while a match runs → pause reason overlay', async () => {
    const { doc, mgr, pauses } = setup();
    mgr.setGameplayActive(true);
    mgr.requestLock('canvas');
    await flush();
    doc.unlock();
    expect(mgr.state).toBe('free');
    expect(pauses).toEqual(['overlay']);
  });

  it('lock lost in the lobby, or to a modal, pauses nothing', async () => {
    const { doc, mgr, pauses } = setup();
    mgr.requestLock('canvas');
    await flush();
    doc.unlock();
    mgr.setGameplayActive(true);
    mgr.requestLock('canvas');
    await flush();
    mgr.setModal(true);
    expect(pauses).toEqual([]);
  });
});

describe('the overlay resume (X-07)', () => {
  it('a lock granted for an explicit canvas request removes overlay (blur → focus → click)', async () => {
    const { doc, mgr, pauses, removals } = setup();
    mgr.setGameplayActive(true);
    mgr.requestLock('canvas');
    await flush();
    expect(mgr.state).toBe('locked');
    removals.length = 0; // ignore the initial grant; assert only the post-blur resume
    doc.unlock(); // the blur: the browser drops the lock, the page adds `hidden`
    expect(mgr.state).toBe('free');
    expect(pauses).toEqual(['overlay']);
    mgr.requestLock('canvas'); // the resume click re-locks
    await flush();
    expect(mgr.state).toBe('locked');
    expect(removals).toEqual(['overlay']);
  });

  it('a refused explicit request keeps overlay', async () => {
    const { canvas, doc, mgr, pauses, removals } = setup();
    mgr.setGameplayActive(true);
    mgr.requestLock('canvas');
    await flush();
    removals.length = 0; // isolate the refused re-lock from the initial grant
    doc.unlock();
    expect(pauses).toEqual(['overlay']);
    canvas.next = 'SecurityError';
    mgr.requestLock('canvas');
    await flush();
    expect(mgr.state).toBe('cooldown');
    expect(removals).toEqual([]);
  });

  it('an explicit gesture while already locked removes overlay idempotently and requests nothing', async () => {
    const { canvas, doc, mgr, pauses, removals } = setup();
    mgr.setGameplayActive(true);
    doc.lockTo(canvas); // the lock arrives with no explicit request behind it: no removal
    expect(mgr.state).toBe('locked');
    expect(removals).toEqual([]);
    doc.unlock();
    expect(pauses).toEqual(['overlay']);
    doc.lockTo(canvas); // locked again, still unrequested: overlay stays
    expect(removals).toEqual([]);
    canvas.dispatchEvent(new Event('click')); // the resume click: a valid resume, no new request
    expect(removals).toEqual(['overlay']);
    expect(canvas.calls).toEqual([]);
    expect(mgr.state).toBe('locked');
  });

  it('only overlay is removed: a remaining hidden reason still pauses', async () => {
    const { doc, mgr, pauses, removals } = setup();
    mgr.setGameplayActive(true);
    mgr.requestLock('canvas');
    await flush();
    removals.length = 0; // assert only the re-lock after the pause reason is added
    doc.unlock();
    pauses.push('hidden'); // the page's own path adds `hidden` on blur; the manager must not touch it
    mgr.requestLock('canvas');
    await flush();
    expect(mgr.state).toBe('locked');
    expect(removals).toEqual(['overlay']);
    expect(pauses).toEqual(['overlay', 'hidden']);
  });

  it('a settings-driven re-request (the RAW MOUSE toggle) never removes overlay', async () => {
    const { mgr, pauses, removals } = setup();
    mgr.setGameplayActive(true);
    mgr.requestLock('canvas');
    await flush();
    expect(removals).toEqual(['overlay']); // the explicit grant itself: idempotent, nothing was paused
    pauses.push('overlay'); // the reason returns from another path while the lock is held
    const removalsBefore = removals.length;
    mgr.setRawMouse(true);
    await flush();
    expect(mgr.state).toBe('locked');
    expect(removals).toHaveLength(removalsBefore);
  });

  it('an explicit raw request refused by the browser still removes overlay once the plain fallback locks', async () => {
    const { canvas, doc, mgr, removals } = setup({ rawMouse: true });
    mgr.setGameplayActive(true);
    canvas.next = 'NotSupportedError';
    mgr.requestLock('canvas');
    canvas.next = 'lock';
    await flush();
    expect(canvas.calls).toEqual([[{ unadjustedMovement: true }], []]);
    expect(mgr.state).toBe('locked');
    expect(doc.pointerLockElement).toBe(canvas);
    expect(removals).toEqual(['overlay']);
  });
});

describe('errors and the re-lock cooldown', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it(`pointerlockerror → cooldown for ${RELOCK_COOLDOWN_MS} ms, requests ignored, then free again`, async () => {
    expect(RELOCK_COOLDOWN_MS).toBe(1100);
    const { canvas, mgr } = setup();
    canvas.next = 'SecurityError';
    mgr.requestLock('canvas');
    await flush();
    expect(mgr.state).toBe('cooldown');
    canvas.next = 'lock';
    mgr.requestLock('canvas');
    expect(canvas.calls).toHaveLength(1);
    vi.advanceTimersByTime(RELOCK_COOLDOWN_MS - 1);
    expect(mgr.state).toBe('cooldown');
    vi.advanceTimersByTime(1);
    expect(mgr.state).toBe('free');
    mgr.requestLock('resume');
    expect(canvas.calls).toHaveLength(2);
  });
});

describe('lifecycle', () => {
  it('dispose removes the listeners and onChange unsubscribes', async () => {
    const { canvas, doc, mgr, states } = setup();
    const off = mgr.onChange(() => {
      throw new Error('a throwing subscriber is isolated');
    });
    mgr.requestLock('canvas');
    await flush();
    off();
    mgr.dispose();
    canvas.dispatchEvent(new Event('click'));
    doc.unlock();
    expect(canvas.calls).toHaveLength(1);
    expect(states).toEqual(['locking', 'locked']);
  });
});
