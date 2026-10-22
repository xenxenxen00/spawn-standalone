import { LEGACY_UI_CONFIG } from './fakes.ts';
// Modal ↔ pointer lock ↔ resume prompt (io §3.9, every row; §3.10; §4.6; X-07; WP UI2a) over a fake Pointer Lock API, the real
// PointerLockManager (IN1), the real PauseController over a fake SimClock, the real ActionSink and, where a row is about UI
// frames, the real UiHost with its modal scan. Rows 1, 2, 4, 5, 7 (manager side) and 8 are the manager's own rules (its unit
// test is tests/unit/input/pointer-lock.node.test.ts); here they are asserted together with what UI2a adds: the "CLICK TO
// RESUME" prompt of row 3, which never pauses the sim, never counts as a modal and never shows beside the pause overlay.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InputsDef, PauseReason, SimClock } from '../../../src/compat/core/types.ts';
import { PauseController } from '../../../src/platform/pause-controller.ts';
import { ActionSink } from '../../../src/runtime/input/action-sink.ts';
import { InputLog } from '../../../src/runtime/input/input-log.ts';
import { PointerLockManager, RELOCK_COOLDOWN_MS, type LockState } from '../../../src/runtime/input/pointer-lock.ts';
import { RESUME_PROMPT_TEXT, ResumePrompt } from '../../../src/runtime/ui/chrome/resume-prompt.ts';
import { ModalLock } from '../../../src/runtime/ui/modal-lock.ts';
import { UiHost } from '../../../src/runtime/ui/ui-host.ts';
import { fakeRuntime, renderString, scriptedUi, type ScriptedUi } from './fakes.ts';

// ── fake Pointer Lock API (the pattern of tests/unit/input/pointer-lock.node.test.ts) ─────────────────────────────────────

class FakeCanvas extends EventTarget {
  calls: unknown[][] = [];
  /** what the next request answers: resolve (and lock), stay pending, or reject with this error name */
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
  /** Esc, alt-tab, the browser revoking the lock */
  unlock(): void {
    if (this.pointerLockElement === null) return;
    this.pointerLockElement = null;
    this.dispatchEvent(new Event('pointerlockchange'));
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** the SimClock contract of core §9.1: idempotent per reason, running iff no reason */
function fakeClock(): SimClock {
  const reasons = new Set<PauseReason>();
  return {
    tick: 0,
    now: () => 1_000_000,
    get running() {
      return reasons.size === 0;
    },
    reasons,
    pause: (r) => void reasons.add(r),
    resume: (r) => void reasons.delete(r),
  };
}

const MAP: InputsDef = { actions: { ss_ui: {}, ss_req: {} }, axes: {} };

const HUD = renderString({ body: '<div id="hud">hud</div>' });
const SHOP = renderString({ body: '<div id="hud">hud</div><div class="tm" data-modal id="ss-shop-scrim"><button id="close">CLOSE</button></div>' });

// ── rig ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Rig {
  canvas: FakeCanvas;
  doc: FakeDoc;
  clock: SimClock;
  pause: PauseController;
  mgr: PointerLockManager;
  lock: ModalLock;
  sink: ActionSink;
  chrome: HTMLElement;
  ui: ScriptedUi;
  host: UiHost;
  /** the origins requestLock was called with */
  origins: string[];
  /** the prompt's visibility sampled at every lock-state change and every pause change, in order */
  seen: boolean[];
  touch: { active: boolean };
  /** one UI frame (the host's modal scan feeds ModalLock.setModal) */
  frame(): void;
  /** the lifecycle binding: `ss.phase` not in LOBBY, LOADING, RESULTS */
  setMatch(running: boolean): void;
  /** lock the pointer through a canvas click */
  lockNow(): Promise<void>;
  promptEl(): HTMLElement;
}

let live: Rig[] = [];

function setup(opts: { chromeModal?: (r: () => Rig) => boolean } = {}): Rig {
  const canvas = new FakeCanvas();
  const doc = new FakeDoc();
  canvas.doc = doc;
  const clock = fakeClock();
  const pause = new PauseController(clock, { setPaused: () => {}, setPlatformAudio: () => {} });
  const touch = { active: false };
  const mgr = new PointerLockManager({ canvas, document: doc, pause, touchActive: () => touch.active });
  const origins: string[] = [];
  const realRequest = mgr.requestLock.bind(mgr);
  mgr.requestLock = (origin) => {
    origins.push(origin);
    realRequest(origin);
  };
  const chrome = document.createElement('div');
  chrome.id = 'port-chrome';
  const container = document.createElement('div');
  container.id = 'tome-ui-container';
  document.body.append(container, chrome);
  const lock = new ModalLock({ pointer: mgr, parent: chrome, gameplayActive: () => pause.gameplayActive, touchActive: () => touch.active, pause });
  const seen: boolean[] = [];
  mgr.onChange(() => void seen.push(lock.promptVisible));
  pause.onChange(() => void seen.push(lock.promptVisible));
  const sink = new ActionSink(new InputLog({ map: MAP }), mgr);
  const ui = scriptedUi(HUD);
  const host = new UiHost(container, ui, { config: LEGACY_UI_CONFIG,
    runtime: fakeRuntime(),
    actions: sink,
    rewrite: (s) => s,
    log: (m) => {
      throw new Error(`unexpected host log: ${m}`);
    },
    pointer: lock,
    chrome: { hasModal: () => opts.chromeModal?.(() => rig) ?? false },
  });
  host.mount();
  let t = 0;
  const rig: Rig = {
    canvas,
    doc,
    clock,
    pause,
    mgr,
    lock,
    sink,
    chrome,
    ui,
    host,
    origins,
    seen,
    touch,
    frame: () => host.frame((t += 20)),
    setMatch(running) {
      mgr.setGameplayActive(running);
      pause.setGameplayActive(running);
    },
    async lockNow() {
      canvas.dispatchEvent(new Event('click'));
      await flush();
      expect(mgr.state).toBe('locked');
    },
    promptEl() {
      const el = chrome.querySelector<HTMLElement>('.pc-resume');
      expect(el).not.toBeNull();
      return el!;
    },
  };
  live.push(rig);
  return rig;
}

afterEach(() => {
  for (const r of live) {
    r.host.dispose();
    r.lock.dispose();
    r.mgr.dispose();
    r.pause.dispose();
  }
  live = [];
  document.body.replaceChildren();
  vi.useRealTimers();
});

/** a match with the shop open and the cursor free (the modal released the lock) */
async function shopOpenInMatch(): Promise<Rig> {
  const r = setup();
  r.setMatch(true);
  r.frame();
  await r.lockNow();
  r.ui.html = SHOP;
  r.frame();
  expect(r.mgr.state).toBe('free');
  expect(r.lock.promptVisible).toBe(false);
  return r;
}

/** …then the phase change closes the shop: no click, no gesture (row 3) */
async function promptUp(): Promise<Rig> {
  const r = await shopOpenInMatch();
  r.ui.html = HUD;
  r.frame();
  expect(r.lock.promptVisible).toBe(true);
  r.canvas.calls.length = 0;
  r.origins.length = 0;
  return r;
}

// ── io §3.9, row by row ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('row 1: a game panel with data-modal appears', () => {
  it('exits the pointer lock, and the canvas stops requesting it on click', async () => {
    const r = setup();
    r.setMatch(true);
    r.frame();
    await r.lockNow();
    r.ui.html = SHOP;
    r.frame();
    expect(r.doc.exits).toBe(1);
    expect(r.mgr.state).toBe('free');
    expect(r.host.hasModal()).toBe(true);
    r.canvas.dispatchEvent(new Event('click'));
    r.frame();
    r.canvas.dispatchEvent(new Event('click'));
    expect(r.canvas.calls).toHaveLength(1); // only the first lock
    // the modal owns the screen: no prompt, and the sim was not paused for it (build B-6: the panels keep live behaviour)
    expect(r.lock.promptVisible).toBe(false);
    expect(r.seen).not.toContain(true);
    expect(r.clock.running).toBe(true);
  });
});

describe('row 2: the modal disappears because of a click (sendAction(…, {relockPointer: true}))', () => {
  it('locks inside that gesture and never shows the prompt, although the modal is reported for two more frames', async () => {
    const r = await shopOpenInMatch();
    const before = r.canvas.calls.length;
    // the panel's CLOSE: onclick="sendAction('ss_ui', {panel:null}, {relockPointer:true})"
    r.sink.inject('ss_ui', { panel: null }, { relockPointer: true });
    expect(r.canvas.calls).toHaveLength(before + 1); // synchronously, inside the click
    expect(r.origins.at(-1)).toBe('ui');
    r.frame(); // the body has not closed the panel yet
    expect(r.host.hasModal()).toBe(true);
    await flush();
    expect(r.mgr.state).toBe('locked');
    r.frame(); // still reported
    expect(r.mgr.state).toBe('locked');
    r.ui.html = HUD;
    r.frame(); // gone
    r.frame();
    expect(r.host.hasModal()).toBe(false);
    expect(r.mgr.state).toBe('locked');
    expect(r.doc.exits).toBe(1); // only the release when the shop opened
    expect(r.lock.promptVisible).toBe(false);
    expect(r.seen).not.toContain(true);
    expect(r.promptEl().hidden).toBe(true);
  });

  it('a lock that arrives only after the panel has gone still shows no prompt (the request is under way)', async () => {
    const r = await shopOpenInMatch();
    r.canvas.next = 'pending';
    r.sink.inject('ss_ui', { panel: null }, { relockPointer: true });
    expect(r.mgr.state).toBe('locking');
    r.ui.html = HUD;
    r.frame();
    r.frame();
    expect(r.lock.promptVisible).toBe(false);
    r.doc.lockTo(r.canvas); // the browser grants it late
    r.frame();
    expect(r.mgr.state).toBe('locked');
    expect(r.lock.promptVisible).toBe(false);
    expect(r.seen).not.toContain(true);
  });

  it('a closing click whose lock the browser refuses falls back to the prompt (contract §14.2: re-lock on the next click)', async () => {
    vi.useFakeTimers();
    const r = await shopOpenInMatch();
    r.canvas.next = 'SecurityError';
    r.sink.inject('ss_ui', { panel: null }, { relockPointer: true });
    await flush();
    expect(r.mgr.state).toBe('cooldown');
    r.frame(); // the panel is still up
    expect(r.lock.promptVisible).toBe(false);
    r.ui.html = HUD;
    r.frame();
    expect(r.lock.promptVisible).toBe(true);
    vi.advanceTimersByTime(RELOCK_COOLDOWN_MS);
    r.canvas.next = 'lock';
    r.promptEl().click();
    await flush();
    expect(r.mgr.state).toBe('locked');
    expect(r.lock.promptVisible).toBe(false);
  });
});

describe('row 3: the modal disappears without a gesture (a phase change closes the shop, results time out)', () => {
  it('shows CLICK TO RESUME over the dim and keeps the sim running', async () => {
    const r = await promptUp();
    const el = r.promptEl();
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe('CLICK TO RESUME');
    expect(RESUME_PROMPT_TEXT).toBe('CLICK TO RESUME');
    expect(el.parentElement).toBe(r.chrome);
    // the sim keeps running (live: closing panels never paused): no pause reason at all
    expect(r.pause.has('overlay')).toBe(false);
    expect(r.clock.running).toBe(true);
    expect(r.mgr.state).toBe('free');
  });

  it("a click on the prompt requests the lock as 'resume', synchronously inside the click; it hides once locked", async () => {
    const r = await promptUp();
    r.promptEl().click();
    expect(r.origins).toEqual(['resume']);
    expect(r.canvas.calls).toHaveLength(1); // before any await: still inside the gesture
    await flush();
    expect(r.mgr.state).toBe('locked');
    expect(r.lock.promptVisible).toBe(false);
    expect(r.promptEl().hidden).toBe(true);
    r.frame();
    expect(r.lock.promptVisible).toBe(false);
  });

  it('a click on the canvas requests the lock too', async () => {
    const r = await promptUp();
    r.canvas.dispatchEvent(new Event('click'));
    expect(r.origins).toEqual(['canvas']);
    expect(r.canvas.calls).toHaveLength(1);
    await flush();
    expect(r.mgr.state).toBe('locked');
    expect(r.lock.promptVisible).toBe(false);
  });

  it('stays up over the frames that follow, and a new modal takes the screen from it', async () => {
    const r = await promptUp();
    for (let i = 0; i < 5; i++) r.frame();
    expect(r.lock.promptVisible).toBe(true);
    r.ui.html = SHOP; // M
    r.frame();
    expect(r.lock.promptVisible).toBe(false);
    r.ui.html = HUD; // closed with the keyboard: no gesture again
    r.frame();
    expect(r.lock.promptVisible).toBe(true);
  });

  it('is not shown outside a match (LOBBY, LOADING, RESULTS: the menus own the cursor)', async () => {
    const r = setup();
    r.setMatch(false);
    r.ui.html = SHOP;
    r.frame();
    r.ui.html = HUD;
    r.frame();
    r.frame();
    expect(r.lock.promptVisible).toBe(false);
    expect(r.seen).not.toContain(true);
  });

  it('a card that went away just before the phase turned (LOADING → PREP) still leads to the prompt once the match runs', () => {
    const r = setup();
    r.ui.html = SHOP; // the LOADING card
    r.frame();
    r.ui.html = HUD;
    r.frame();
    expect(r.lock.promptVisible).toBe(false);
    r.setMatch(true);
    r.frame();
    expect(r.lock.promptVisible).toBe(true);
  });

  it('hides when the match ends', async () => {
    const r = await promptUp();
    r.setMatch(false); // RESULTS
    r.frame();
    expect(r.lock.promptVisible).toBe(false);
    expect(r.promptEl().hidden).toBe(true);
  });

  it('is not a modal: the scan stays false and the canvas keeps requesting', async () => {
    const r = await promptUp();
    for (let i = 0; i < 3; i++) r.frame();
    expect(r.host.hasModal()).toBe(false);
    expect(document.querySelector('[data-modal]')).toBeNull();
    expect(r.promptEl().hasAttribute('data-modal')).toBe(false);
    r.canvas.dispatchEvent(new Event('click'));
    expect(r.canvas.calls).toHaveLength(1);
  });
});

describe('row 4: lock lost with no modal while a match runs (Esc, alt-tab, browser revoke)', () => {
  it("adds the pause reason 'overlay' once and does not show the prompt (the pause overlay owns that case)", async () => {
    const r = setup();
    r.setMatch(true);
    r.frame();
    await r.lockNow();
    const changes: PauseReason[][] = [];
    r.pause.onChange((_p, reasons) => void changes.push([...reasons].sort()));
    r.doc.unlock();
    expect(r.mgr.state).toBe('free');
    expect(changes).toEqual([['overlay']]);
    expect(r.clock.running).toBe(false);
    for (let i = 0; i < 3; i++) r.frame();
    expect(changes).toHaveLength(1);
    expect(r.lock.promptVisible).toBe(false);
    expect(r.seen).not.toContain(true); // not even between the state change and the pause
  });

  it('after a re-lock by the closing click, a later Esc is the pause overlay again, not the prompt', async () => {
    const r = await shopOpenInMatch();
    r.sink.inject('ss_ui', { panel: null }, { relockPointer: true });
    await flush();
    r.frame(); // the panel is still reported, the pointer is locked
    r.ui.html = HUD;
    r.frame();
    expect(r.mgr.state).toBe('locked');
    r.doc.unlock(); // Esc
    expect(r.pause.has('overlay')).toBe(true);
    r.frame();
    expect(r.lock.promptVisible).toBe(false);
    expect(r.seen).not.toContain(true);
  });

  it('after a re-lock through the prompt, a later Esc is the pause overlay again, not the prompt', async () => {
    const r = await promptUp();
    r.promptEl().click();
    await flush();
    expect(r.mgr.state).toBe('locked');
    r.seen.length = 0;
    r.doc.unlock(); // Esc
    expect(r.pause.has('overlay')).toBe(true);
    r.frame();
    expect(r.lock.promptVisible).toBe(false);
    expect(r.seen).not.toContain(true);
  });

  it('with the pause overlay as a chrome modal: RESUME whose lock is refused leaves the prompt as the way back in', async () => {
    vi.useFakeTimers();
    const r = setup({ chromeModal: (rig) => rig().pause.has('overlay') }); // UI2b: PortChrome.hasModal() = the pause overlay
    r.setMatch(true);
    r.frame();
    await r.lockNow();
    r.doc.unlock(); // Esc
    r.frame();
    expect(r.host.hasModal()).toBe(true);
    expect(r.lock.promptVisible).toBe(false);
    // ssResume: clears `overlay` and requests the lock; Chrome refuses within ~1 s of Esc
    r.canvas.next = 'SecurityError';
    r.pause.remove('overlay');
    r.mgr.requestLock('resume');
    await flush();
    expect(r.mgr.state).toBe('cooldown');
    r.frame(); // the overlay is gone, the cursor is still free, the sim runs
    expect(r.clock.running).toBe(true);
    expect(r.lock.promptVisible).toBe(true);
    vi.advanceTimersByTime(RELOCK_COOLDOWN_MS);
    r.canvas.next = 'lock';
    r.promptEl().click();
    await flush();
    expect(r.mgr.state).toBe('locked');
    expect(r.lock.promptVisible).toBe(false);
  });
});

describe('row 5: lock lost in LOBBY / RESULTS', () => {
  it('does nothing: no overlay pause, no prompt', async () => {
    const r = setup();
    r.setMatch(false);
    r.frame();
    await r.lockNow();
    r.doc.unlock();
    for (let i = 0; i < 3; i++) r.frame();
    expect(r.clock.reasons.size).toBe(0);
    expect(r.lock.promptVisible).toBe(false);
    expect(r.seen).not.toContain(true);
  });
});

describe('row 6: platform pause (ad, tab hidden, blur) during a match', () => {
  it("adds 'overlay' beside the host reason; removing the host reason leaves 'overlay'; no prompt while it is set", async () => {
    const r = setup();
    r.setMatch(true);
    r.frame();
    await r.lockNow();
    r.pause.add('hidden');
    r.doc.unlock(); // the browser takes the lock with the focus
    expect([...r.clock.reasons].sort()).toEqual(['hidden', 'overlay']);
    r.frame();
    r.pause.remove('hidden');
    expect([...r.clock.reasons]).toEqual(['overlay']);
    for (let i = 0; i < 3; i++) r.frame();
    expect(r.lock.promptVisible).toBe(false);
    expect(r.seen).not.toContain(true);
    for (const reason of ['platform', 'ad'] as const) {
      r.pause.add(reason);
      r.pause.remove(reason);
      expect(r.pause.has('overlay')).toBe(true);
    }
  });

  it('a platform pause that starts while the prompt is up hides it at once (no UI frame needed)', async () => {
    const r = await promptUp();
    r.pause.add('platform');
    expect(r.pause.has('overlay')).toBe(true);
    expect(r.lock.promptVisible).toBe(false);
    expect(r.promptEl().hidden).toBe(true);
    r.pause.remove('platform');
    r.frame();
    expect(r.lock.promptVisible).toBe(false); // `overlay` is still set: resume needs the overlay's click
    // the re-lock click of the chrome clears `overlay`; with the cursor still free the prompt is the way back in
    r.pause.remove('overlay');
    expect(r.lock.promptVisible).toBe(true);
  });
});

describe('row 7: the ~1 s re-lock cooldown after Esc, or pointerlockerror', () => {
  beforeEach(() => void vi.useFakeTimers());

  it(`a refused request keeps the prompt up; a click during the ${RELOCK_COOLDOWN_MS} ms cooldown does nothing; the next click after it retries`, async () => {
    expect(RELOCK_COOLDOWN_MS).toBe(1100);
    const r = await promptUp();
    r.seen.length = 0;
    r.canvas.next = 'SecurityError';
    r.promptEl().click();
    expect(r.canvas.calls).toHaveLength(1);
    await flush();
    expect(r.mgr.state).toBe('cooldown');
    expect(r.lock.promptVisible).toBe(true);
    expect(r.seen).toEqual([true, true]); // locking, cooldown: it never blinked
    r.canvas.next = 'lock';
    r.promptEl().click();
    r.canvas.dispatchEvent(new Event('click'));
    expect(r.canvas.calls).toHaveLength(1);
    expect(r.lock.promptVisible).toBe(true);
    vi.advanceTimersByTime(RELOCK_COOLDOWN_MS - 1);
    r.promptEl().click();
    expect(r.canvas.calls).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(r.mgr.state).toBe('free');
    expect(r.lock.promptVisible).toBe(true);
    r.promptEl().click();
    expect(r.canvas.calls).toHaveLength(2);
    expect(r.origins.at(-1)).toBe('resume');
    await flush();
    expect(r.mgr.state).toBe('locked');
    expect(r.lock.promptVisible).toBe(false);
    expect(r.clock.running).toBe(true); // none of this ever paused the sim
  });

  it('the legacy pointerlockerror event (no promise) is handled the same way', async () => {
    const r = await promptUp();
    r.canvas.requestPointerLock = (...args: unknown[]) => {
      r.canvas.calls.push(args);
      queueMicrotask(() => r.doc.dispatchEvent(new Event('pointerlockerror')));
      return undefined as unknown as Promise<void>;
    };
    r.promptEl().click();
    await flush();
    expect(r.mgr.state).toBe('cooldown');
    expect(r.lock.promptVisible).toBe(true);
  });
});

describe('row 8: touch active', () => {
  it('never requests the lock and never shows the prompt; modals only block the touch layer', () => {
    const r = setup();
    r.touch.active = true;
    r.setMatch(true);
    r.frame();
    r.canvas.dispatchEvent(new Event('click'));
    r.ui.html = SHOP;
    r.frame();
    r.sink.inject('ss_ui', { panel: null }, { relockPointer: true });
    r.ui.html = HUD;
    r.frame();
    r.frame();
    expect(r.canvas.calls).toEqual([]);
    expect(r.lock.promptVisible).toBe(false);
    expect(r.seen).not.toContain(true);
    expect(r.clock.running).toBe(true);
  });

  it('touch becoming active while the prompt is up hides it', async () => {
    const r = await promptUp();
    r.touch.active = true;
    r.frame();
    expect(r.lock.promptVisible).toBe(false);
  });
});

// ── the pieces ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('ModalLock as the UiHost pointer dep', () => {
  it('forwards every setModal to the manager', () => {
    const calls: boolean[] = [];
    const parent = document.createElement('div');
    document.body.append(parent);
    const lock = new ModalLock({
      pointer: { state: 'free', setModal: (m) => void calls.push(m), requestLock: () => {}, onChange: () => () => {} },
      parent,
      gameplayActive: () => true,
    });
    lock.setModal(false);
    lock.setModal(true);
    lock.setModal(true);
    lock.setModal(false);
    expect(calls).toEqual([false, true, true, false]);
    expect(lock.promptVisible).toBe(true); // touch and pause default to "not active" / "none"
    lock.dispose();
  });

  it('update() re-reads the getters between UI frames (a phase change)', () => {
    let running = false;
    const parent = document.createElement('div');
    document.body.append(parent);
    const lock = new ModalLock({
      pointer: { state: 'free', setModal: () => {}, requestLock: () => {}, onChange: () => () => {} },
      parent,
      gameplayActive: () => running,
    });
    lock.setModal(true);
    lock.setModal(false);
    expect(lock.promptVisible).toBe(false);
    running = true;
    lock.update();
    expect(lock.promptVisible).toBe(true);
    lock.dispose();
  });

  it('dispose removes the prompt DOM and every listener', async () => {
    const r = await promptUp();
    const el = r.promptEl();
    const states: LockState[] = [];
    r.mgr.onChange((s) => void states.push(s));
    r.lock.dispose();
    expect(r.chrome.childElementCount).toBe(0);
    expect(r.lock.promptVisible).toBe(false);
    el.click(); // the detached element no longer requests
    expect(r.canvas.calls).toEqual([]);
    // lock and pause changes no longer reach it
    r.canvas.dispatchEvent(new Event('click'));
    await flush();
    r.doc.unlock();
    r.pause.add('platform');
    r.lock.setModal(true);
    r.lock.setModal(false);
    r.lock.update();
    expect(states).toEqual(['locking', 'locked', 'free']);
    expect(r.lock.promptVisible).toBe(false);
    expect(r.chrome.childElementCount).toBe(0);
    r.lock.dispose(); // twice is fine
  });
});

describe('ResumePrompt (chrome, io §3.10)', () => {
  it('is plain DOM in the given parent, hidden until shown, and reports clicks only while it exists', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const prompt = new ResumePrompt(parent);
    expect(parent.children).toHaveLength(1);
    expect(prompt.element.className).toBe('pc-resume');
    expect(prompt.element.hidden).toBe(true);
    expect(prompt.visible).toBe(false);
    let clicks = 0;
    const off = prompt.onClick(() => void clicks++);
    prompt.show();
    prompt.show();
    expect(prompt.visible).toBe(true);
    expect(prompt.element.hidden).toBe(false);
    prompt.element.click();
    (prompt.element.firstElementChild as HTMLElement).click(); // the plate: the whole layer is the target
    expect(clicks).toBe(2);
    off();
    prompt.element.click();
    expect(clicks).toBe(2);
    prompt.hide();
    expect(prompt.visible).toBe(false);
    prompt.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
