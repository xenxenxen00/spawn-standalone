import { LEGACY_UI_CONFIG } from './fakes.ts';
// ui-host.morph (io §3.14, §3.4; X-39; WP UI1 acceptance): kept ids keep node identity across renders (identity stands in for "the
// CSS animation keeps running"); a new transient id is a new node; an identical string skips the morph; the style and the sprite
// are hoisted once and `<use href="#pi-…">` still resolves document-wide; only changed top-level children are morphed (counted
// with a MutationObserver); a key change morphs #game whole; a render throw keeps the last DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UiHost } from '../../../src/runtime/ui/ui-host.ts';
import { fakeRuntime, icon, renderString, scriptedUi, spriteSvg, type ScriptedUi } from './fakes.ts';

let container: HTMLElement;
let mount: HTMLElement;
let host: UiHost | null = null;
let ui: ScriptedUi;
let t = 0;

const identity = (s: string): string => s;

function makeHost(extra: Partial<ConstructorParameters<typeof UiHost>[2]> = {}): UiHost {
  host = new UiHost(container, ui, { config: LEGACY_UI_CONFIG,
    runtime: fakeRuntime(),
    actions: { inject: () => true },
    rewrite: identity,
    gameMount: mount,
    log: () => {},
    ...extra,
  });
  host.mount();
  return host;
}

/** one UI frame 20 ms after the previous one (never cadence-limited) */
function frame(h: UiHost = host!): void {
  t += 20;
  h.frame(t);
}

const root = (): HTMLElement => container.querySelector('#ss-root')!;
const ss = (): HTMLElement => document.getElementById('game')!;

beforeEach(() => {
  container = document.createElement('div');
  container.id = 'tome-ui-container';
  mount = document.createElement('div');
  mount.id = 'tome-game-mount';
  document.body.append(container, mount);
  ui = scriptedUi();
  t = 0;
});

afterEach(() => {
  host?.dispose();
  host = null;
  document.body.replaceChildren();
});

describe('DOM structure (io §3.2)', () => {
  it('mount builds #ss-style, #ss-sprites and #ss-root in the container and mounts the game into #tome-game-mount', () => {
    makeHost();
    expect([...container.children].map((e) => e.id)).toEqual(['ss-style', 'ss-sprites', 'ss-root']);
    expect(container.querySelector('#ss-style')!.tagName).toBe('STYLE');
    expect(container.querySelector('#ss-sprites')!.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(ui.mounted).toBe(mount);
  });
});

describe('morph', () => {
  it('a kept id keeps its node; a new transient id is a new node', () => {
    makeHost();
    ui.html = renderString({ body: `<div id="hud"><div id="ann100" class="ann">WAVE 3</div><b>1</b></div>` });
    frame();
    const hud = document.getElementById('hud')!;
    const ann = document.getElementById('ann100')!;
    ui.html = renderString({ body: `<div id="hud"><div id="ann100" class="ann">WAVE 3</div><div id="pop200" class="pop">+50</div><b>2</b></div>` });
    frame();
    expect(document.getElementById('hud')).toBe(hud);
    expect(document.getElementById('ann100')).toBe(ann);
    expect(document.getElementById('pop200')).not.toBeNull();
    expect(hud.querySelector('b')!.textContent).toBe('2');
  });

  it('an identical string skips everything (no render work, no mutation)', () => {
    makeHost();
    ui.html = renderString({ body: `<div id="hud">1</div>` });
    frame();
    const records: MutationRecord[] = [];
    const mo = new MutationObserver((r) => records.push(...r));
    mo.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });
    frame();
    frame();
    records.push(...mo.takeRecords());
    mo.disconnect();
    expect(records).toHaveLength(0);
    expect(host!.stats().morphs).toBe(1);
  });

  it('only changed top-level children are morphed (mutation-observer count)', () => {
    makeHost();
    const body = (n: number): string =>
      `<div id="hud-top"><span>wave</span></div><div id="hud-mid"><span>${n}</span></div><div class="xhair"><i></i></div><div id="feed"><p>k</p></div>`;
    ui.html = renderString({ body: body(1) });
    frame();
    const top = document.getElementById('hud-top')!;
    const mid = document.getElementById('hud-mid')!;
    const feed = document.getElementById('feed')!;
    const xhair = ss().querySelector('.xhair')!;
    const records: MutationRecord[] = [];
    const mo = new MutationObserver((r) => records.push(...r));
    mo.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });
    ui.html = renderString({ body: body(2) });
    frame();
    records.push(...mo.takeRecords());
    mo.disconnect();
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) expect(mid === r.target || mid.contains(r.target)).toBe(true);
    expect(mid.textContent).toBe('2');
    expect([document.getElementById('hud-top'), document.getElementById('feed'), ss().querySelector('.xhair')]).toEqual([top, feed, xhair]);
    expect(host!.stats()).toMatchObject({ fullMorphs: 1, childMorphs: 1 });
  });

  it("#game's own attributes are patched directly without touching its children", () => {
    makeHost();
    ui.html = renderString({ cls: '', scale: 1, body: `<div id="a">x</div>` });
    frame();
    const a = document.getElementById('a')!;
    const records: MutationRecord[] = [];
    const mo = new MutationObserver((r) => records.push(...r));
    mo.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });
    ui.html = renderString({ cls: 'cb menuvid', scale: 1.5, body: `<div id="a">x</div>` });
    frame();
    records.push(...mo.takeRecords());
    mo.disconnect();
    expect(ss().className).toBe('cb menuvid');
    expect(ss().getAttribute('style')).toBe('--ss-scale:1.5');
    expect(records.every((r) => r.target === ss() && r.type === 'attributes')).toBe(true);
    expect(document.getElementById('a')).toBe(a);
  });

  it('a key change (screen change: children added, removed or reordered) morphs #game whole and still keeps kept ids', () => {
    makeHost();
    ui.html = renderString({ body: `<div id="hud">1</div><div id="feed">k</div>` });
    frame();
    const feed = document.getElementById('feed')!;
    ui.html = renderString({ body: `<div id="ss-shop-scrim" data-modal>shop</div><div id="feed">k</div>` });
    frame();
    expect(document.getElementById('hud')).toBeNull();
    expect(document.getElementById('ss-shop-scrim')).not.toBeNull();
    expect(document.getElementById('feed')).toBe(feed);
    expect(host!.stats().fullMorphs).toBe(2);
  });

  it('falls back to a whole morph when the DOM no longer matches the keys (a page global removed a child)', () => {
    makeHost();
    ui.html = renderString({ body: `<div id="ss-welcome-scrim" data-modal>w</div><div id="hud">1</div>` });
    frame();
    document.getElementById('ss-welcome-scrim')!.remove(); // ssWelcomeClose (main.js:223-224)
    ui.html = renderString({ body: `<div id="ss-welcome-scrim" data-modal>w</div><div id="hud">2</div>` });
    frame();
    expect(document.getElementById('ss-welcome-scrim')).not.toBeNull();
    expect(document.getElementById('hud')!.textContent).toBe('2');
  });

  it('a render that throws keeps the last DOM and logs once per distinct message', () => {
    const log = vi.fn();
    makeHost({ log });
    ui.html = renderString({ body: `<div id="hud">kept</div>` });
    frame();
    ui.error = new Error('boom');
    frame();
    frame();
    expect(document.getElementById('hud')!.textContent).toBe('kept');
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toMatch(/boom/);
    ui.error = null;
    ui.html = renderString({ body: `<div id="hud">back</div>` });
    frame();
    expect(document.getElementById('hud')!.textContent).toBe('back');
  });

  it('a render without #game (the error plate, an empty string) replaces the root content', () => {
    makeHost();
    ui.html = renderString({ body: `<div id="hud">1</div>` });
    frame();
    ui.html = `<div style="position:fixed;left:12px">UI error: x</div>`;
    frame();
    expect(document.getElementById('game')).toBeNull();
    expect(root().textContent).toBe('UI error: x');
    ui.html = '';
    frame();
    expect(root().childElementCount).toBe(0);
  });

  it('keeps the value of the range slider the player is dragging (ignoreActiveValue)', () => {
    makeHost();
    const body = (v: number): string => `<div id="set"><input id="ss-pr-vol" type="range" min="0" max="100" value="${v}"></div>`;
    ui.html = renderString({ body: body(40) });
    frame();
    const input = document.getElementById('ss-pr-vol') as HTMLInputElement;
    input.focus();
    input.value = '75';
    ui.html = renderString({ body: body(41) });
    frame();
    expect(document.getElementById('ss-pr-vol')).toBe(input);
    expect(input.value).toBe('75');
  });
});

describe('hoist (X-39)', () => {
  it('moves the style once into #ss-style and replaces it only when it changes', () => {
    makeHost();
    ui.html = renderString({ css: '#game{color:red}', body: `<div id="a">1</div>` });
    frame();
    const style = container.querySelector('#ss-style')!;
    expect(style.textContent).toBe('#game{color:red}');
    expect(root().querySelector('style')).toBeNull();
    const records: MutationRecord[] = [];
    const mo = new MutationObserver((r) => records.push(...r));
    mo.observe(style, { subtree: true, childList: true, characterData: true });
    ui.html = renderString({ css: '#game{color:red}', body: `<div id="a">2</div>` });
    frame();
    records.push(...mo.takeRecords());
    expect(records).toHaveLength(0);
    ui.html = renderString({ css: '#game{color:blue}', body: `<div id="a">2</div>` });
    frame();
    mo.disconnect();
    expect(style.textContent).toBe('#game{color:blue}');
  });

  it('moves every <symbol> sprite (gradients included) once into #ss-sprites; <use href="#pi-…"> resolves document-wide', () => {
    makeHost();
    ui.html = renderString({ sprite: spriteSvg(['pi-cr', 'pi-hp']), body: `<div id="hud">${icon('cr')}</div>` });
    frame();
    const sprites = container.querySelector('#ss-sprites')!;
    expect(root().querySelector('symbol')).toBeNull();
    expect(ss().querySelector('svg:not(.ic)')).toBeNull();
    expect([...sprites.querySelectorAll('symbol')].map((s) => s.id)).toEqual(['pi-cr', 'pi-hp']);
    expect(sprites.querySelector('#ss-sheen')!.localName).toBe('linearGradient');
    const use = ss().querySelector('use')!;
    const target = document.querySelector(use.getAttribute('href')!)!;
    expect(target.localName).toBe('symbol');
    expect(target.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(sprites.contains(target)).toBe(true);
  });

  it('merges symbols by id: the weapon symbols stay once added and are not re-sent to the DOM', () => {
    makeHost();
    ui.html = renderString({ sprite: spriteSvg(['pi-cr', 'pw-m590', 'pw-m1911']), body: `<div id="shop"></div>` });
    frame();
    const sprites = container.querySelector('#ss-sprites')!;
    const m590 = document.getElementById('pw-m590');
    const records: MutationRecord[] = [];
    const mo = new MutationObserver((r) => records.push(...r));
    mo.observe(sprites, { subtree: true, childList: true, attributes: true, characterData: true });
    ui.html = renderString({ sprite: spriteSvg(['pi-cr']), body: `<div id="hud"></div>` }); // the HUD sends no weapon sheet
    frame();
    ui.html = renderString({ sprite: spriteSvg(['pi-cr', 'pw-m590', 'pw-m1911']), body: `<div id="shop"></div>` });
    frame();
    records.push(...mo.takeRecords());
    mo.disconnect();
    expect(records).toHaveLength(0);
    expect(document.getElementById('pw-m590')).toBe(m590);
    expect(sprites.querySelectorAll('symbol')).toHaveLength(3);
  });

  it('a changed sprite does not count as a changed child (the sprite never reaches the morph)', () => {
    makeHost();
    ui.html = renderString({ sprite: spriteSvg(['pi-a']), body: `<div id="hud">1</div>` });
    frame();
    ui.html = renderString({ sprite: spriteSvg(['pi-a', 'pw-x']), body: `<div id="hud">1</div>` });
    frame();
    expect(host!.stats()).toMatchObject({ fullMorphs: 1, childMorphs: 0 });
    expect(document.getElementById('pw-x')).not.toBeNull();
  });
});
