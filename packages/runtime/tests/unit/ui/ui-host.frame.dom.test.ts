import { LEGACY_UI_CONFIG } from './fakes.ts';
// UiHost per-frame duties (io §3.3-3.4, docs/architecture.md §4.2 steps 6-8; WP UI1 acceptance): cadence ≤ 60 Hz at a 144 Hz
// rAF (30 Hz with setCadence(30)); `onFirstInteractiveFrame` fires once, on the first frame whose #game holds a [data-modal] panel;
// `coversScene` is true while the live menu backdrop (`.ss-blank`, the opaque video, main.js:114-117) stands; the modal scan
// feeds the pointer-lock manager every UI frame; anchors are projected after the morph; the UiPort and dispose.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UiHost } from '../../../src/runtime/ui/ui-host.ts';
import { UiEventBus } from '../../../src/runtime/ui/ui-events.ts';
import { fakeRuntime, renderString, scriptedUi, type ScriptedUi } from './fakes.ts';

let container: HTMLElement;
let host: UiHost | null = null;
let ui: ScriptedUi;

function makeHost(extra: Partial<ConstructorParameters<typeof UiHost>[2]> = {}): UiHost {
  host = new UiHost(container, ui, { config: LEGACY_UI_CONFIG, runtime: fakeRuntime(), actions: { inject: () => true }, rewrite: (s) => s, log: () => {}, ...extra });
  host.mount();
  return host;
}

/** drives `frames` rAF callbacks at `hz` from t0; returns how many renders ran */
function drive(h: UiHost, hz: number, frames: number, t0 = 0, jitterMs = 0): number {
  const before = ui.calls;
  for (let i = 0; i < frames; i++) h.frame(t0 + (i * 1000) / hz + (i % 2 === 0 ? jitterMs : -jitterMs));
  return ui.calls - before;
}

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

describe('cadence (X-39: at most 60 Hz whatever the display rate)', () => {
  it('runs ≤ 60 renders per second at a 144 Hz rAF, and close to 60', () => {
    const h = makeHost();
    const n = drive(h, 144, 144 * 2);
    expect(n).toBeLessThanOrEqual(120); // 2 s of frames: never above 60 per second
    expect(n).toBeGreaterThanOrEqual(115);
    // and never two renders closer than the cap allows by more than the jitter tolerance
    const times: number[] = [];
    let tt = 0;
    ui.default = () => {
      times.push(tt);
      return '';
    };
    for (let i = 0; i < 144; i++) h.frame((tt = 5000 + (i * 1000) / 144));
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThan(12);
  });

  it('renders every frame of a 60 Hz rAF despite ±1 ms jitter', () => {
    const h = makeHost();
    expect(drive(h, 60, 120, 0, 1)).toBe(120);
  });

  it('runs every frame of a 30 Hz rAF and caps at 30 Hz after setCadence(30)', () => {
    const h = makeHost();
    expect(drive(h, 30, 60)).toBe(60);
    h.setCadence(30);
    const n = drive(h, 144, 144, 3000);
    expect(n).toBeLessThanOrEqual(31);
    expect(n).toBeGreaterThanOrEqual(28);
    h.setCadence(60);
    expect(drive(h, 60, 60, 5000)).toBeGreaterThanOrEqual(59);
  });

  it('does not burst after a long stall (no catch-up renders)', () => {
    const h = makeHost();
    drive(h, 60, 10);
    const before = ui.calls;
    h.frame(10_000);
    h.frame(10_000 + 1000 / 144);
    expect(ui.calls - before).toBe(1);
  });
});

describe('onFirstInteractiveFrame (X-04: the shell sends game_ready)', () => {
  it('fires once, on the first frame whose #game holds a [data-modal] panel', () => {
    const h = makeHost();
    const cb = vi.fn();
    h.onFirstInteractiveFrame(cb);
    h.frame(0);
    expect(cb).not.toHaveBeenCalled();
    ui.html = renderString({ body: '<div class="scrim" id="ss-welcome-scrim" data-panel="welcome" data-modal>w</div>' });
    h.frame(20);
    expect(cb).toHaveBeenCalledTimes(1);
    ui.html = renderString({ body: '<div class="scrim" id="ss-lobby-scrim" data-modal>l</div>' });
    h.frame(40);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a hidden panel without data-modal does not count; a late subscriber is called at once', () => {
    const h = makeHost();
    ui.html = renderString({ body: '<div class="scrim" id="ss-settings-scrim" hidden>s</div>' });
    h.frame(0);
    const early = vi.fn();
    h.onFirstInteractiveFrame(early);
    expect(early).not.toHaveBeenCalled();
    ui.html = renderString({ body: '<div class="scrim" id="ss-lobby-scrim" data-modal>l</div>' });
    h.frame(20);
    const late = vi.fn();
    h.onFirstInteractiveFrame(late);
    expect(early).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
  });
});

describe('coversScene (the frame driver skips renderer.render())', () => {
  const blank = '<div class="ss-blank" style="position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:0;background-color:#0b0a0c;opacity:1"><video id="ss-menu-video" src="x.mp4" autoplay muted loop playsinline></video></div>';

  it('is true while the menu backdrop stands and false once it goes', () => {
    const h = makeHost();
    expect(h.coversScene()).toBe(false);
    ui.html = renderString({ cls: 'menuvid', body: `${blank}<div class="scrim" data-modal id="ss-lobby-scrim">l</div>` });
    h.frame(0);
    expect(h.coversScene()).toBe(true);
    ui.html = renderString({ body: '<div id="hud">x</div>' });
    h.frame(20);
    expect(h.coversScene()).toBe(false);
  });

  it('follows a page global that removed the backdrop between renders (ssWelcomeClose, main.js:225)', () => {
    const h = makeHost();
    ui.html = renderString({ cls: 'menuvid', body: `${blank}<div class="scrim" data-modal id="ss-welcome-scrim">w</div>` });
    h.frame(0);
    container.querySelectorAll('.ss-blank').forEach((e) => e.remove());
    h.frame(20); // same string: no morph, but the scan runs
    expect(h.coversScene()).toBe(false);
  });
});

describe('modal scan, anchors, UiPort', () => {
  it('reports [data-modal] (or a chrome modal) to the pointer-lock manager every UI frame', () => {
    const setModal = vi.fn();
    let chromeModal = false;
    const h = makeHost({ pointer: { setModal }, chrome: { hasModal: () => chromeModal } });
    h.frame(0);
    expect(setModal).toHaveBeenLastCalledWith(false);
    ui.html = renderString({ body: '<div class="tm" data-modal id="ss-shop-scrim">shop</div>' });
    h.frame(20);
    expect(setModal).toHaveBeenLastCalledWith(true);
    ui.html = renderString({ body: '<div id="hud">x</div>' });
    h.frame(40);
    expect(setModal).toHaveBeenLastCalledWith(false);
    chromeModal = true;
    h.frame(60);
    expect(setModal).toHaveBeenLastCalledWith(true);
    expect(setModal).toHaveBeenCalledTimes(4);
  });

  it('projects anchors after the morph with the host root', () => {
    const project = vi.fn();
    const h = makeHost({ anchors: { project } });
    h.frame(0);
    expect(project).toHaveBeenCalledWith(container.querySelector('#ss-root'));
    expect(document.getElementById('hud')).not.toBeNull();
  });

  it('the UiPort forwards uiEvent to the event bus; markDirty is accepted', () => {
    const events = new UiEventBus();
    const h = makeHost({ events });
    const got: unknown[] = [];
    events.on((n, p) => got.push([n, p]));
    const port = h.uiPort();
    port.markDirty();
    port.uiEvent('ssBlood', { s: 1, k: 0.5 });
    expect(got).toEqual([['ssBlood', { s: 1, k: 0.5 }]]);
  });

  it('hands the render the ctx with `port` attached and the local player', () => {
    const rt = fakeRuntime();
    let seen: { port: unknown; player: unknown } | null = null;
    ui.default = (ctx, player) => {
      seen = { port: (ctx as { port?: unknown }).port, player };
      return '';
    };
    const h = makeHost({ runtime: rt, port: () => ({ ...h.defaultPortState(), touchActive: true }) });
    h.frame(0);
    expect(seen!.port).toEqual({ touchActive: true });
    expect(seen!.player).toMatchObject({ id: 'player/local', isLocal: true });
  });

  it('dispose calls onDestroy, empties the container and removes the page globals', () => {
    const h = makeHost();
    h.frame(0);
    expect(typeof (window as unknown as Record<string, unknown>)['sendAction']).toBe('function');
    h.dispose();
    host = null;
    expect(ui.destroyed).toBe(true);
    expect(container.childElementCount).toBe(0);
    expect((window as unknown as Record<string, unknown>)['sendAction']).toBeUndefined();
    expect((window as unknown as Record<string, unknown>)['ssClick']).toBeUndefined();
  });
});

describe('onPanelChange', () => {
  it('reports visible panel transitions and ignores re-renders of the same panel', () => {
    const seen: Array<[string | null, string | null]> = [];
    const h = makeHost({ onPanelChange: (from, to) => seen.push([from, to]) });
    h.frame(0);
    expect(seen).toEqual([]);
    ui.html = renderString({ body: '<div class="scrim" id="ss-lobby-scrim" data-panel="lobby" data-modal>l</div>' });
    h.frame(20);
    ui.html = renderString({ body: '<div class="scrim" id="ss-settings-scrim" data-panel="settings" data-modal>s</div>' });
    h.frame(40);
    ui.html = renderString({ body: '<div class="scrim" id="ss-controls-scrim" data-panel="controls" data-modal>c</div>' });
    h.frame(60);
    ui.html = renderString({ body: '<div class="scrim" id="ss-lobby-scrim" data-panel="lobby" data-modal>l</div>' });
    h.frame(80);
    expect(seen).toEqual([
      [null, 'lobby'],
      ['lobby', 'settings'],
      ['settings', 'controls'],
      ['controls', 'lobby'],
    ]);
    h.frame(100);
    expect(seen).toHaveLength(4);
  });
});
