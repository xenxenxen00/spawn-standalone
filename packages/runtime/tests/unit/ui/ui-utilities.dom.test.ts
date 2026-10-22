// UiHostConfig.utilities: the opt-in utility stylesheet Spawn's UI realm provided (fixed, absolute, inset-0, pointer-events-none, ...).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveUiHostConfig, type UiHostConfig } from '../../../src/runtime/ui/ui-host-config.ts';
import { UI_UTILITIES_CSS, UI_UTILITY_CLASSES } from '../../../src/runtime/ui/utilities.ts';
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

const HTML = '<div id="cc" class="fixed inset-0 pointer-events-none"><button id="b" class="absolute pointer-events-auto">go</button><p id="h" class="hidden">x</p></div>';
function mount(config: UiHostConfig): UiHost {
  const mod = { default: () => HTML } as unknown as GameUiModule;
  host = new UiHost(container, mod, { runtime: fakeRuntime(), actions: { inject: () => true }, rewrite: (s) => s, log: () => {}, pageTarget: [globalThis], config: { rootId: 'cc', ...config } });
  host.mount();
  host.frame(0);
  return host;
}

describe('ui.utilities', () => {
  it('on: the HUD root is fixed, covers the page and lets pointers through; its button takes them', () => {
    mount({ utilities: true });
    const root = document.getElementById('cc')!;
    const cs = getComputedStyle(root);
    expect(cs.position).toBe('fixed');
    expect(cs.pointerEvents).toBe('none');
    expect(cs.getPropertyValue('inset')).toBe('0px'); // jsdom keeps the shorthand
    expect(getComputedStyle(document.getElementById('b')!).position).toBe('absolute');
    expect(getComputedStyle(document.getElementById('b')!).pointerEvents).toBe('auto');
    expect(getComputedStyle(document.getElementById('h')!).display).toBe('none');
  });

  it('off (default, PP): none of it is in the page', () => {
    mount({});
    expect(getComputedStyle(document.getElementById('cc')!).position).not.toBe('fixed');
    expect(document.head.innerHTML + container.innerHTML).not.toContain('ss utilities');
  });

  it('comes before the game\'s own styles so the game can override it', () => {
    expect(resolveUiHostConfig({ utilities: true, styles: ['.x{}'] }).styles).toEqual([UI_UTILITIES_CSS, '.x{}']);
    expect(resolveUiHostConfig(undefined).utilities).toBe(false);
    expect(resolveUiHostConfig({}).styles).toEqual([]);
  });

  it('defines the four names the Crown & Clash HUD used, and no duplicate class', () => {
    for (const c of ['fixed', 'absolute', 'inset-0', 'pointer-events-none']) expect(UI_UTILITY_CLASSES).toContain(c);
    expect(new Set(UI_UTILITY_CLASSES).size).toBe(UI_UTILITY_CLASSES.length);
  });
});
