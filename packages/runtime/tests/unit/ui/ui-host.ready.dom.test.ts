// UiHostConfig.readyWhen: when onFirstInteractiveFrame fires (the shell's game_ready). Default 'modal' is PP's [data-modal] rule;
// a game without a modal panel opts into 'firstFrame', 'firstUiRender' or a selector.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveUiHostConfig, type UiHostConfig } from '../../../src/runtime/ui/ui-host-config.ts';
import { UiHost } from '../../../src/runtime/ui/ui-host.ts';
import type { GameUiModule } from '../../../src/runtime/ui/game-ui.d.ts';
import { fakeRuntime } from './fakes.ts';

let container: HTMLElement;
let host: UiHost | null = null;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  host?.dispose();
  host = null;
  document.body.replaceChildren();
});

function setup(html: { v: string }, readyWhen?: UiHostConfig['readyWhen']): { host: UiHost; fired: () => number } {
  const mod = { default: () => html.v } as unknown as GameUiModule;
  host = new UiHost(container, mod, { runtime: fakeRuntime(), actions: { inject: () => true }, rewrite: (s) => s, log: () => {}, pageTarget: [globalThis], config: { rootId: 'cr', ...(readyWhen === undefined ? {} : { readyWhen }) } });
  host.mount();
  let n = 0;
  host.onFirstInteractiveFrame(() => n++);
  return { host, fired: () => n };
}

const HUD = '<div id="cr"><p id="hud">hp</p></div>';
const MODAL = '<div id="cr"><div data-modal data-panel="menu"></div></div>';

describe('readyWhen', () => {
  it('explicit modal: a HUD-only render never reports ready; a [data-modal] panel does, once', () => {
    const html = { v: HUD };
    const s = setup(html, 'modal');
    s.host.frame(0);
    s.host.frame(100);
    expect(s.fired()).toBe(0);
    html.v = MODAL;
    s.host.frame(200);
    s.host.frame(300);
    expect(s.fired()).toBe(1);
  });
  it("'firstFrame': the first UI frame, no panel needed", () => {
    const s = setup({ v: HUD }, 'firstFrame');
    expect(s.fired()).toBe(0);
    s.host.frame(0);
    expect(s.fired()).toBe(1);
    s.host.frame(100);
    expect(s.fired()).toBe(1);
  });
  it("'firstUiRender': waits for a frame that put markup in the DOM", () => {
    const html = { v: '' };
    const s = setup(html, 'firstUiRender');
    s.host.frame(0);
    expect(s.fired()).toBe(0);
    html.v = HUD;
    s.host.frame(100);
    expect(s.fired()).toBe(1);
  });
  it('a selector: ready when it matches inside the root', () => {
    const html = { v: '<div id="cr"></div>' };
    const s = setup(html, '#hud');
    s.host.frame(0);
    expect(s.fired()).toBe(0);
    html.v = HUD;
    s.host.frame(100);
    expect(s.fired()).toBe(1);
  });
  it('resolves: firstUiRender by default, an empty value is refused', () => {
    expect(resolveUiHostConfig(undefined).readyWhen).toBe('firstUiRender');
    expect(resolveUiHostConfig({}).readyWhen).toBe('firstUiRender');
    expect(() => resolveUiHostConfig({ readyWhen: ' ' })).toThrow(/readyWhen/);
  });
});
