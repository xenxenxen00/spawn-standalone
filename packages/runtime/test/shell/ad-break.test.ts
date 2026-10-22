// The generic ad-break channel (P-2 / C-6): the game's uiEvent, the shell's ad, the answer in ctx.session, composed into composeGame.
import { describe, expect, it, vi } from 'vitest';
import type { BootResult } from '../../src/compat/core/boot/boot.ts';
import type { AdKind, AdResult, PlatformEvents } from '../../src/platform/platform.ts';
import { SimClockImpl } from '../../src/compat/core/sched/clock.ts';
import { createEmitter } from '../../src/platform/emitter.ts';
import { composeGame, type ShellParts } from '../../src/shell/compose-game.ts';
import { adBreakUiPort, AdBreaks, installAdBreakPageApi, type AdBreakHost, type AdBreakOptions } from '../../src/shell/ad-break.ts';

/** a platform whose ads the test opens and closes by hand, emitting the events an adapter does */
function fakePlatform() {
  const events = createEmitter<PlatformEvents>('test');
  const asks: Array<{ kind: AdKind; placement: string; resolve(r: AdResult): void }> = [];
  return {
    events,
    asks,
    platform: {
      on: events.on,
      showAd: (kind: AdKind, placement: string) => new Promise<AdResult>((resolve) => asks.push({ kind, placement, resolve })),
    },
  };
}

/** timers the test fires by hand */
function manualTimers() {
  const timers: Array<{ cb: () => void; ms: number; live: boolean }> = [];
  const paints: Array<() => void> = [];
  return {
    timers,
    paint: () => paints.splice(0).forEach((f) => f()),
    fire: (ms?: number) => timers.filter((t) => t.live && (ms === undefined || t.ms === ms)).forEach((t) => ((t.live = false), t.cb())),
    opts: {
      afterPaint: (cb: () => void) => (paints.push(cb), () => void paints.splice(paints.indexOf(cb), 1)),
      setTimer: (cb: () => void, ms: number) => {
        const t = { cb, ms, live: true };
        timers.push(t);
        return t;
      },
      clearTimer: (t: unknown) => void ((t as { live: boolean }).live = false),
    } satisfies AdBreakOptions,
  };
}

function setup(over: AdBreakOptions = {}) {
  const p = fakePlatform();
  const m = manualTimers();
  const sessions = [{} as Record<string, unknown>, {} as Record<string, unknown>];
  const ui: Array<[string, unknown]> = [];
  const host: AdBreakHost = { platform: p.platform as never, sessions: () => sessions, ui: { uiEvent: (n, v) => void ui.push([n, v]) } };
  const breaks = new AdBreaks(host, { ...m.opts, ...over });
  return { p, m, sessions, ui, breaks };
}

describe('AdBreaks', () => {
  it('showing at the request, the ad after the paint, done when it is over; the game is told through session and uiEvent', async () => {
    const { p, m, sessions, ui, breaks } = setup();
    const done = breaks.request({ placement: 'results', id: 'round-1' });
    expect(sessions.every((s) => JSON.stringify(s['adBreak']) === JSON.stringify({ state: 'showing', placement: 'results', id: 'round-1' }))).toBe(true);
    expect(p.asks).toHaveLength(0);
    m.paint();
    m.fire();
    expect(p.asks.map((a) => [a.kind, a.placement])).toEqual([['interstitial', 'results']]);
    p.events.emit('adPause');
    p.asks[0]!.resolve({ shown: true, rewarded: false });
    expect(await done).toMatchObject({ state: 'done', shown: true, placement: 'results', id: 'round-1' });
    expect(sessions[0]!['adBreak']).toMatchObject({ state: 'done', shown: true });
    expect(sessions[1]!['adBreak']).toMatchObject({ state: 'done' });
    expect(ui.map(([n]) => n)).toEqual(['adBreakResult']);
    expect(breaks.active).toBeNull();
  });

  it('no fill, cooldown and a rejecting platform answer skipped in one go', async () => {
    const { p, m, breaks } = setup();
    const a = breaks.request({ placement: 'a' });
    m.paint();
    m.fire();
    p.asks[0]!.resolve({ shown: false, reason: 'cooldown' });
    expect(await a).toEqual({ state: 'skipped', placement: 'a', id: null, shown: false, reason: 'cooldown' });
    const warn = vi.fn();
    const r = setup({ log: warn });
    r.p.platform.showAd = () => Promise.reject(new Error('boom'));
    const b = r.breaks.request({ placement: 'b' });
    r.m.paint();
    r.m.fire();
    expect(await b).toMatchObject({ state: 'skipped', reason: 'other' });
    expect(warn).toHaveBeenCalled();
  });

  it('the game proceeds after timeoutMs when the ad never opens, but waits for one that is on screen', async () => {
    const { p, m, breaks } = setup({ timeoutMs: 6000 });
    const slow = breaks.request({ placement: 'a' });
    m.paint();
    m.fire(0);
    m.fire(6000);
    expect(await slow).toMatchObject({ state: 'skipped', reason: 'timeout' });
    p.asks[0]!.resolve({ shown: false, reason: 'timeout' }); // the late answer changes nothing
    const long = breaks.request({ placement: 'b' });
    m.paint();
    m.fire(0);
    p.events.emit('adPause');
    m.fire(6000); // the watchdog was cleared by the open
    expect(breaks.active?.placement).toBe('b');
    p.asks[1]!.resolve({ shown: true, rewarded: false });
    expect(await long).toMatchObject({ state: 'done' });
  });

  it('one break at a time, once per id, never a bad request, cancellable before the ad is asked', async () => {
    const { p, m, breaks } = setup({ delayMs: 250 });
    const first = breaks.request({ placement: 'a', id: 1 });
    expect(await breaks.request({ placement: 'b' })).toMatchObject({ reason: 'busy' });
    expect(breaks.cancel()).toBe(true);
    expect(await first).toMatchObject({ state: 'skipped', reason: 'cancelled' });
    expect(await breaks.request({ placement: 'a', id: 1 })).toMatchObject({ reason: 'duplicate' });
    expect(await breaks.request({ placement: '' })).toMatchObject({ reason: 'invalid' });
    expect(await breaks.request(undefined as never)).toMatchObject({ reason: 'invalid' });
    const again = breaks.request({ placement: 'a', id: 2 });
    m.paint();
    m.fire(250);
    expect(breaks.cancel()).toBe(false);
    expect(p.asks).toHaveLength(1);
    p.asks[0]!.resolve({ shown: true, rewarded: false });
    await again;
  });

  it('rewarded requests and the per-request delay', async () => {
    const { p, m, breaks } = setup();
    const r = breaks.request({ placement: 'bonus', kind: 'rewarded', delayMs: 40 });
    m.paint();
    expect(m.timers.at(-1)?.ms).toBe(40);
    m.fire(40);
    expect(p.asks[0]).toMatchObject({ kind: 'rewarded', placement: 'bonus' });
    p.asks[0]!.resolve({ shown: true, rewarded: true });
    expect(await r).toMatchObject({ rewarded: true });
  });

  it('uiEvent routing: adBreak asks (object or string payload), adBreakCancel cancels, other names are not its own', async () => {
    const { m, breaks } = setup();
    expect(breaks.handleUiEvent('hud', {})).toBe(false);
    expect(breaks.handleUiEvent('adBreak', 'results')).toBe(true);
    expect(breaks.active?.placement).toBe('results');
    expect(breaks.handleUiEvent('adBreakCancel', null)).toBe(true);
    expect(breaks.active).toBeNull();
    expect(breaks.handleUiEvent('adBreak', { placement: 'x', delayMs: 5 })).toBe(true);
    m.paint();
    expect(m.timers.at(-1)?.ms).toBe(5);
  });

  it('dispose answers the break in flight and refuses new ones', async () => {
    const { breaks } = setup();
    const r = breaks.request({ placement: 'a' });
    breaks.dispose();
    expect(await r).toMatchObject({ reason: 'disposed' });
    expect(await breaks.request({ placement: 'b' })).toMatchObject({ reason: 'disposed' });
  });

  it('adBreakUiPort offers the event to the channel and forwards everything', () => {
    const seen: string[] = [];
    const inner = { markDirty: () => void seen.push('dirty'), uiEvent: (n: string, _p: unknown) => void seen.push(`ui ${n}`) };
    const channel = { handleUiEvent: (n: string) => (seen.push(`channel ${n}`), true) } as unknown as AdBreaks;
    const port = adBreakUiPort(inner, () => channel);
    port.uiEvent('adBreak', {});
    port.markDirty();
    expect(seen).toEqual(['channel adBreak', 'ui adBreak', 'dirty']);
    adBreakUiPort(inner, () => null).uiEvent('x', 1);
  });

  it('the page API: __ssBreak always resolves with nothing; __ssMatch speaks to the platform; removal', async () => {
    const { p, m, breaks } = setup();
    const win: Record<string, unknown> = {};
    const calls: string[] = [];
    const off = installAdBreakPageApi(win, { breaks, platform: { matchEvent: (e) => void calls.push(`match ${e.type} ${e.map}`), setGameplay: (a) => void calls.push(`gameplay ${a}`) }, slug: 'crown' });
    const r = (win['__ssBreak'] as (p: string) => Promise<void>)('match_end');
    m.paint();
    m.fire();
    p.asks[0]!.resolve({ shown: false, reason: 'cooldown' });
    expect(await r).toBeUndefined();
    (win['__ssMatch'] as (k: string) => void)('start');
    (win['__ssMatch'] as (k: string) => void)('end');
    expect(calls).toEqual(['match start crown', 'gameplay true', 'match complete crown', 'gameplay false']);
    off();
    expect(win['__ssBreak']).toBeUndefined();
  });
});

describe('composeGame adBreaks', () => {
  function parts(seen: { ext?: unknown; ports?: { ui?: { uiEvent(n: string, p: unknown): void } }; kernel?: unknown } = {}): Partial<ShellParts> {
    const kernel = { vms: { client: { session: {} as Record<string, unknown> }, platform: { session: {} as Record<string, unknown> } }, clock: new SimClockImpl() };
    seen.kernel = kernel;
    return {
      platform: () => ({ ...fakePlatform().platform, setGameplay() {}, matchEvent() {} }) as never,
      audio: () => ({ frame() {}, playSound() {}, stopSound() {}, setListener() {} }),
      worldConfig: async () => ({}),
      input: () => ({ port: {} as never, sink: {}, log: {}, dispose() {} }),
      camera: () => ({ presentation: { hitstop() {}, now: () => 0 }, presenter: { last: null }, rig: { attach() {}, frame() {} } as never }),
      scene: () => ({ attach() {}, attached: false }) as never,
      extensions: (o) => ((seen.ext = o.game), {}),
      boot: async (e) => ((seen.ports = e.ports as never), await e.onKernel?.(kernel as never), { kernel, dispose() {} } as unknown as BootResult),
      attach: () => ({ driver: { start() {}, attach() {}, stop() {} } as never, dispose() {} }),
    };
  }
  const base = { slug: 'fixture', canvas: null, headless: true } as const;

  it('off by default; on with adBreaks or platform playgama (pauseFreezesClock with it)', async () => {
    const off: { ext?: unknown } = {};
    const a = await composeGame({ ...base, parts: parts(off) });
    expect(a.adBreaks).toBeNull();
    expect(off.ext).toBeUndefined();
    const on: { ext?: unknown } = {};
    const b = await composeGame({ ...base, adBreaks: true, extensions: { changed: true }, parts: parts(on) });
    expect(b.adBreaks).toBeInstanceOf(AdBreaks);
    expect(on.ext).toEqual({ pauseFreezesClock: true, changed: true });
    const keep: { ext?: unknown } = {};
    await composeGame({ ...base, adBreaks: true, ext: { pauseFreezesClock: false }, parts: parts(keep) });
    expect(keep.ext).toEqual({ pauseFreezesClock: false });
    const pg: { ext?: unknown } = {};
    const kinds: string[] = [];
    const c = await composeGame({ ...base, platform: 'playgama', parts: { ...parts(pg), platform: ({ kind, saveKeys }) => (kinds.push(`${kind} ${saveKeys.join(',')}`), parts().platform!({} as never)) } });
    expect(c.adBreaks).not.toBeNull();
    expect(kinds).toEqual(['playgama ss_save_v1,ss_save_v1_bad']);
    const d = await composeGame({ ...base, platform: 'playgama', adBreaks: false, parts: parts() });
    expect(d.adBreaks).toBeNull();
  });

  it('the save keys follow the durable options', async () => {
    const kinds: string[] = [];
    const p = parts();
    await composeGame({ ...base, platform: 'playgama', durable: { key: 'g_save' }, parts: { ...p, durable: () => ({}) as never, platform: ({ saveKeys }) => (kinds.push(saveKeys.join(',')), {} as never) } });
    expect(kinds).toEqual(['g_save,g_save_bad']);
  });

  it('a game uiEvent reaches the channel through the kernel ui port and is still forwarded; the answer lands in the VM sessions', async () => {
    const seen: { ports?: { ui?: { uiEvent(n: string, p: unknown): void } }; kernel?: { vms: Record<string, { session: Record<string, unknown> }>; clock: SimClockImpl } } = {};
    const forwarded: string[] = [];
    const app = await composeGame({
      ...base,
      adBreaks: { afterPaint: (cb) => (cb(), () => {}), setTimer: (cb, ms) => (ms === 0 ? cb() : undefined, 0), clearTimer: () => {} },
      uiContainer: {} as HTMLElement,
      gameUi: {},
      parts: {
        ...parts(seen as never),
        ui: () => ({ uiPort: () => ({ markDirty() {}, uiEvent: (n: string) => void forwarded.push(n) }) as never, mount() {}, frame() {}, coversScene: () => false, onFirstInteractiveFrame: (cb) => cb(), dispose() {} }),
      },
    });
    seen.ports!.ui!.uiEvent('adBreak', { placement: 'results' });
    expect(forwarded).toEqual(['adBreak']);
    expect(seen.kernel!.vms['client']!.session['adBreak']).toMatchObject({ state: 'showing', placement: 'results' });
    expect([...seen.kernel!.clock.reasons]).toEqual(['ad']); // the composition wires the channel's hold to the kernel clock
    app.dispose();
    expect(seen.kernel!.vms['client']!.session['adBreak']).toMatchObject({ state: 'skipped', reason: 'disposed' });
    expect(seen.kernel!.clock.running).toBe(true);
  });

  it('headless never installs the page API', async () => {
    const g = globalThis as { window?: unknown };
    g.window = {};
    try {
      await composeGame({ ...base, adBreaks: true, parts: parts() });
      expect((g.window as Record<string, unknown>)['__ssBreak']).toBeUndefined();
    } finally {
      delete g.window;
    }
  });
});
