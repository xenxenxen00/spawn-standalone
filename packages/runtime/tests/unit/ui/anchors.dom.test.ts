import { LEGACY_UI_CONFIG } from './fakes.ts';
// AnchorProjector on the real DOM (io §3.7; WP UI2a): the live markup of scripts/ui/hud.js:153,159 in jsdom, alone and through
// the UiHost and its idiomorph morph. The projection maths is anchors.three.test.ts; here the projection is a fixed pinhole
// written out by hand (no three), because what is under test is the DOM: the game-authored inline style survives, a morph that
// resets the style attribute or replaces the node is repaired in the same frame, and an unchanged render string still projects.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/compat/core/types.ts';
import { AnchorProjector, type AnchorDeps, type AnchorRow } from '../../../src/runtime/ui/anchors.ts';
import { UiHost } from '../../../src/runtime/ui/ui-host.ts';
import { fakeRuntime, renderString, scriptedUi, type ScriptedUi } from './fakes.ts';

const W = 1280;
const H = 720;
const EYE: Vec3 = { x: 0, y: 1.6, z: 0 };

/** a camera at EYE facing −Z with a 90° horizontal fov: x = W/2 · (1 + dx/dist), y = H/2 − (W/2) · dy/dist */
function pinhole(rows: Map<string, AnchorRow>): AnchorDeps {
  return {
    project(p) {
      const dist = EYE.z - p.z;
      return { x: (W / 2) * (1 + (p.x - EYE.x) / dist), y: H / 2 - ((W / 2) * (p.y - EYE.y)) / dist };
    },
    camera: () => ({ eye: EYE, aim: { x: 0, y: 0, z: -1 } }),
    getObject: (id) => rows.get(id) ?? null,
    viewport: () => ({ width: W, height: H }),
  };
}

const feetRow = (feet: Vec3): AnchorRow => ({ feetPosition: feet, worldFeetPosition: feet, bounds: undefined });

// scripts/ui/hud.js:153 (teammate plate) and :159 (terminal marker), as the render emits them
const plate = (bodyId: string, name: string): string =>
  `<div class="abs" data-world-anchor="${bodyId}" data-anchor-offset="0 2.15 0" style="opacity:clamp(.35, calc(1.25 - var(--anchor-depth, 0) / 45), 1)"><div style="transform:translate(-50%,-100%)"><div class="np"><span class="nm">${name}</span></div></div></div>`;
const marker = (termId: string): string =>
  `<div id="ss-anchor" class="abs" data-world-anchor="${termId}" data-anchor-offset="0 2.3 0" style="opacity:clamp(.4, calc(1.2 - var(--anchor-depth, 0) / 40), 1)"><div style="transform:translate(-50%,-100%)"><div class="box"><span class="l">SUPPLY</span></div></div></div>`;

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

const anchorEl = (sel: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(sel);
  expect(el, sel).not.toBeNull();
  return el!;
};

describe('on real elements', () => {
  it('places the live teammate plate and keeps its game-authored inline style', () => {
    const rows = new Map([['player/bot1/body', feetRow({ x: 2, y: -0.55, z: -10 })]]);
    container.innerHTML = plate('player/bot1/body', 'VEGA');
    const el = anchorEl('[data-world-anchor]');
    new AnchorProjector(pinhole(rows)).project(container);
    // feet (2, −0.55, −10) + 2.15 up = eye height: 640 · (1 + 2/10) = 768, 360
    expect(el.style.transform).toMatch(/^translate3d\(768px, 360px, 0(px)?\)$/);
    expect(el.style.position).toBe('fixed');
    expect(el.style.left).toBe('0px');
    expect(el.style.top).toBe('0px');
    expect(el.style.visibility).toBe('');
    expect(el.style.getPropertyValue('--anchor-depth')).toBe(String(Math.round(Math.hypot(2, 10) * 100) / 100));
    // the opacity fade the game wrote is still in the attribute, and the inner plate keeps its own centring transform
    expect(el.getAttribute('style')).toContain('var(--anchor-depth, 0) / 45');
    expect(el.getAttribute('style')).toContain('opacity');
    expect((el.firstElementChild as HTMLElement).getAttribute('style')).toBe('transform:translate(-50%,-100%)');
    expect(el.querySelector('.nm')!.textContent).toBe('VEGA');
  });

  it('hides an anchor whose row is unknown and leaves its content alone', () => {
    container.innerHTML = marker('terminal/none');
    const el = anchorEl('#ss-anchor');
    new AnchorProjector(pinhole(new Map())).project(container);
    expect(el.style.visibility).toBe('hidden');
    expect(el.getAttribute('style')).toContain('var(--anchor-depth, 0) / 40');
    expect(el.textContent).toBe('SUPPLY');
  });

  it('an element without any anchor in the root costs nothing and throws nothing', () => {
    container.innerHTML = '<div id="hud">x</div>';
    expect(() => new AnchorProjector(pinhole(new Map())).project(container)).not.toThrow();
    expect(container.innerHTML).toBe('<div id="hud">x</div>');
  });
});

describe('through the UiHost (frame step 8: anchors after the morph)', () => {
  let ui: ScriptedUi;
  let rows: Map<string, AnchorRow>;
  let feet: Vec3;

  function mount(): UiHost {
    host = new UiHost(container, ui, { config: LEGACY_UI_CONFIG,
      runtime: fakeRuntime(),
      actions: { inject: () => true },
      rewrite: (s) => s,
      log: (m) => {
        throw new Error(`unexpected host log: ${m}`);
      },
      anchors: new AnchorProjector(pinhole(rows)),
    });
    host.mount();
    return host;
  }

  beforeEach(() => {
    feet = { x: 0, y: -0.55, z: -10 };
    rows = new Map([
      ['player/bot1/body', feetRow(feet)],
      ['terminal/t1', feetRow({ x: -5, y: -0.7, z: -20 })],
    ]);
    ui = scriptedUi(renderString({ body: `<div id="hud">${plate('player/bot1/body', 'VEGA')}${marker('terminal/t1')}</div>` }));
  });

  it('one frame writes the transform of every anchor of the render', () => {
    const h = mount();
    h.frame(0);
    expect(anchorEl('.abs[data-world-anchor="player/bot1/body"]').style.transform).toMatch(/^translate3d\(640px, 360px, 0(px)?\)$/);
    // terminal: feet (−5, −0.7, −20) + 2.3 up: 640 · (1 − 5/20) = 480, 360
    expect(anchorEl('#ss-anchor').style.transform).toMatch(/^translate3d\(480px, 360px, 0(px)?\)$/);
    expect(anchorEl('#ss-anchor').style.getPropertyValue('--anchor-depth')).toBe(String(Math.round(Math.hypot(5, 20) * 100) / 100));
  });

  it('a second frame with the identical render string still projects (the row moved, the DOM did not)', () => {
    const h = mount();
    h.frame(0);
    const el = anchorEl('.abs[data-world-anchor="player/bot1/body"]');
    feet.x = 5; // 640 · (1 + 5/10)
    h.frame(20);
    expect(h.stats().morphs).toBe(1);
    expect(container.querySelector('.abs[data-world-anchor="player/bot1/body"]')).toBe(el);
    expect(el.style.transform).toMatch(/^translate3d\(960px, 360px, 0(px)?\)$/);
  });

  it('a morph that rewrites the plate (and resets its style attribute) leaves it placed at the end of the frame', () => {
    const h = mount();
    h.frame(0);
    ui.html = renderString({ body: `<div id="hud">${plate('player/bot1/body', 'VEGA [DOWN]').replace('/ 45', '/ 50')}${marker('terminal/t1')}</div>` });
    h.frame(20);
    const el = anchorEl('.abs[data-world-anchor="player/bot1/body"]');
    expect(el.querySelector('.nm')!.textContent).toBe('VEGA [DOWN]');
    expect(el.getAttribute('style')).toContain('/ 50'); // the morph took the new game style
    expect(el.style.transform).toMatch(/^translate3d\(640px, 360px, 0(px)?\)$/);
    expect(el.style.position).toBe('fixed');
    expect(el.style.getPropertyValue('--anchor-depth')).toBe('10');
  });

  it('a screen change (whole-root morph) that re-creates the anchors: the new nodes are placed, removed ones are forgotten', () => {
    const h = mount();
    h.frame(0);
    const before = anchorEl('#ss-anchor');
    // another screen without anchors, then the HUD again with one anchor fewer
    ui.html = renderString({ body: '<div class="scrim" id="ss-shop-scrim" data-modal>shop</div>' });
    h.frame(20);
    expect(container.querySelectorAll('[data-world-anchor]')).toHaveLength(0);
    ui.html = renderString({ body: `<div id="hud2">${marker('terminal/t1')}</div>` });
    h.frame(40);
    const after = anchorEl('#ss-anchor');
    expect(after).not.toBe(before);
    expect(after.style.transform).toMatch(/^translate3d\(480px, 360px, 0(px)?\)$/);
    expect(before.isConnected).toBe(false);
  });

  it('a row that disappears hides its plate on the next frame, and it returns when the row does', () => {
    const h = mount();
    h.frame(0);
    const el = anchorEl('.abs[data-world-anchor="player/bot1/body"]');
    const gone = rows.get('player/bot1/body')!;
    rows.delete('player/bot1/body');
    h.frame(20);
    expect(el.style.visibility).toBe('hidden');
    rows.set('player/bot1/body', gone);
    h.frame(40);
    expect(el.style.visibility).toBe('');
  });
});
