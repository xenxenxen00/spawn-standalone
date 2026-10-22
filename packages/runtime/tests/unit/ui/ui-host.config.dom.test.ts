// UiHostConfig (ui-host-config.ts): the options that let the host serve a game other than PP. A fixture module in the style of
// Crown Riot's scripts/ui.js (root `<div id="cr">`, three exported inline-onclick handlers, no ss* names) renders and its
// handlers answer real inline `onclick`s; PP's fixture, with no config, is unchanged.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autoGlobalNames } from '../../../src/runtime/ui/auto-globals.ts';
import { DEFAULT_UI_HOST_CONFIG, resolveUiHostConfig } from '../../../src/runtime/ui/ui-host-config.ts';
import { UiHost } from '../../../src/runtime/ui/ui-host.ts';
import type { GameUiModule } from '../../../src/runtime/ui/game-ui.d.ts';
import { fakeRuntime, renderString, scriptedUi } from './fakes.ts';

/** vitest's jsdom runs module code against the host global and inline handlers against jsdom's own window (see page-api.dom.test.ts) */
const PAGE: object[] = [globalThis, (globalThis as unknown as { jsdom: { window: object } }).jsdom.window];
let container: HTMLElement;
let host: UiHost | null = null;
const calls: string[] = [];

interface Fixture {
  default: () => string;
  [k: string]: unknown;
}

/** Crown Riot's shape: default render + exported onclick handlers + a lifecycle export; no ss* names */
function crownRiotUi(html: string): Fixture {
  return {
    default: () => html,
    onMount: () => {},
    openLocker: () => calls.push('openLocker'),
    buy: (id: string) => calls.push(`buy:${id}`),
    again: () => calls.push('again'),
    NOT_A_FN: 3,
  };
}

const CR_HTML =
  '<style>#cr{position:fixed;inset:0}</style>' +
  '<div id="cr"><button id="lk" onclick="openLocker()">LOCKER</button><button id="by" onclick="buy(\'skin1\')">BUY</button>' +
  '<button id="ag" onclick="again()">AGAIN</button></div>';

function mount(mod: unknown, config?: ConstructorParameters<typeof UiHost>[2]['config']): UiHost {
  host = new UiHost(container, mod as GameUiModule, { runtime: fakeRuntime(), actions: { inject: () => true }, rewrite: (s) => s, log: () => {}, pageTarget: PAGE, ...(config ? { config } : {}) });
  host.mount();
  host.frame(0);
  return host;
}

const click = (id: string): void => (document.getElementById(id) as HTMLElement).click();
const w = (): Record<string, unknown> => (globalThis as unknown as { jsdom: { window: Record<string, unknown> } }).jsdom.window;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  calls.length = 0;
});

afterEach(() => {
  host?.dispose();
  host = null;
  document.body.replaceChildren();
});

describe('globals: auto (a Crown Riot style module)', () => {
  it('installs every exported function as a page global that inline onclick handlers reach', () => {
    mount(crownRiotUi(CR_HTML), { rootId: 'cr', globals: 'auto' });
    click('lk');
    click('by');
    click('ag');
    expect(calls).toEqual(['openLocker', 'buy:skin1', 'again']);
  });

  it('keeps sendAction runtime-provided and installs no lifecycle export or non-function', () => {
    const mod = { ...crownRiotUi(CR_HTML), sendAction: () => calls.push('mod-sendAction'), spawn: () => {} };
    expect(autoGlobalNames(mod).sort()).toEqual(['again', 'buy', 'openLocker']);
    mount(mod, { rootId: 'cr', globals: 'auto' });
    expect(typeof w()['openLocker']).toBe('function');
    expect(w()['onMount']).toBeUndefined();
    expect(w()['NOT_A_FN']).toBeUndefined();
    expect(w()['sendAction']).not.toBe(mod['sendAction']);
  });

  it('removes the globals on dispose', () => {
    mount(crownRiotUi(CR_HTML), { rootId: 'cr', globals: 'auto' });
    expect(typeof w()['buy']).toBe('function');
    host!.dispose();
    expect(w()['buy']).toBeUndefined();
  });

  it('an explicit list installs only those names', () => {
    mount(crownRiotUi(CR_HTML), { rootId: 'cr', globals: ['again'] });
    expect(typeof w()['again']).toBe('function');
    expect(w()['openLocker']).toBeUndefined();
  });
});

describe('root, blank, style and sprite ids', () => {
  it('splits the custom root and hoists into the custom style and sprite ids', () => {
    const sprite = '<svg width="0" height="0"><defs><symbol id="g-x" viewBox="0 0 1 1"><path d="M0 0"/></symbol></defs></svg>';
    mount(crownRiotUi(`<style>.k{color:red}</style><div id="cr" class="a">${sprite}<p id="m">one</p></div>`), {
      rootId: 'cr',
      styleId: 'cr-style',
      spriteId: 'cr-sprites',
    });
    expect(container.querySelector('#cr-style')?.textContent).toBe('.k{color:red}');
    expect(container.querySelector('#cr-sprites #g-x')).not.toBeNull();
    expect(container.querySelector('#ss-style')).toBeNull();
    expect(container.querySelector('#cr > #m')?.textContent).toBe('one');
  });

  it('morphs single children under the custom root, and scans its [data-modal] and blank selector', () => {
    const mod = crownRiotUi('<div id="cr"><p id="m">one</p></div>');
    const h = mount(mod, { rootId: 'cr', blankSelector: '.menu-bg' });
    let html = '<div id="cr"><p id="m">two</p></div>';
    mod.default = () => html;
    h.frame(100);
    expect(h.stats().childMorphs).toBe(1);
    expect(h.coversScene()).toBe(false);
    html = '<div id="cr"><div class="menu-bg"></div><div data-modal data-panel="shop"></div></div>';
    h.frame(200);
    expect(h.coversScene()).toBe(true);
    expect(h.hasModal()).toBe(true);
    let fired = 0;
    h.onFirstInteractiveFrame(() => fired++);
    expect(fired).toBe(1);
  });

  it('a PP-rooted render is not split under another root id (it renders whole)', () => {
    const h = mount(scriptedUi(renderString({ body: '<p id="m">x</p>' })), { rootId: 'cr' });
    expect(h.stats().childMorphs).toBe(0);
    expect(container.querySelector('#game > #m')).not.toBeNull();
  });

  it('rejects an id that is not a plain element id', () => {
    expect(() => resolveUiHostConfig({ rootId: 'a b' })).toThrow(/rootId/);
    expect(() => resolveUiHostConfig({ styleId: '#x' })).toThrow(/styleId/);
    expect(() => resolveUiHostConfig({ globals: ['ok', '1bad'] })).toThrow(/identifier/);
  });
});

describe('styles', () => {
  it('extra CSS is hoisted before the render style, and alone when the render has none', () => {
    const mod = crownRiotUi('<div id="cr"></div>');
    mount(mod, { rootId: 'cr', styles: ['.x{a:1}', '.y{b:2}'] });
    expect(container.querySelector('#ss-style')?.textContent).toBe('.x{a:1}\n.y{b:2}');
    mod.default = () => '<style>.z{c:3}</style><div id="cr"></div>';
    host!.frame(100);
    expect(container.querySelector('#ss-style')?.textContent).toBe('.x{a:1}\n.y{b:2}\n.z{c:3}');
  });
});

describe('neutral defaults', () => {
 it('discovers game handlers and uses neutral element IDs', () => {
 expect(resolveUiHostConfig(undefined)).toBe(DEFAULT_UI_HOST_CONFIG);
 expect(resolveUiHostConfig({})).toMatchObject({rootId:'game',globals:'auto',gameCss:false,readyWhen:'firstUiRender'});
 const ui = crownRiotUi('<div id="game"><div data-scene-cover></div><div data-modal id="p">menu</div></div>');
 const h=mount(ui);
 expect(h.coversScene()).toBe(true);expect(h.hasModal()).toBe(true);
 expect(container.querySelector('#ss-style')).not.toBeNull();
 });
});
