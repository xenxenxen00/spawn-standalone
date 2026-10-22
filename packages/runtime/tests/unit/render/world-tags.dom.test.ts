// World tags (render/special/world-tags.ts): a `ui` row with facing="player" is HTML anchored to its row. A fixture row's tag lands
// at the row's projected screen position (a pinhole written out by hand), scales to its width in metres, hides behind the camera,
// follows the row when it moves, and goes with the row. Negative: a panel-style `ui` string is not a tag.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RowSnapshot } from '../../../src/compat/core/ports.ts';
import { isFacingPlayerUi, tagWidthM, WorldTags, type TagNode } from '../../../src/render/special/world-tags.ts';

const W = 1280;
const H = 720;
const EYE = { x: 0, y: 1.6, z: 0 };
/** 90° horizontal fov camera at EYE looking down -Z */
const pinhole = (p: { x: number; y: number; z: number }) => {
  const dist = EYE.z - p.z;
  return { x: (W / 2) * (1 + (p.x - EYE.x) / dist), y: H / 2 - ((W / 2) * (p.y - EYE.y)) / dist };
};

const TAG = '<div facing="player" width="1.8m" class="flex justify-center"><div style="font:900 150px sans-serif">BOT · PIP</div></div>';
const nodeAt = (x: number, y: number, z: number): TagNode & { elements: number[] } => {
  const elements = new Array<number>(16).fill(0);
  elements[0] = elements[5] = elements[10] = elements[15] = 1;
  elements[12] = x;
  elements[13] = y;
  elements[14] = z;
  return { matrixWorld: { elements }, elements };
};
const row = (id: string, ui: unknown): RowSnapshot => ({ id, phase: 'alive', props: { ui } }) as unknown as RowSnapshot;

let container: HTMLElement;
let tags: WorldTags;
const NATURAL = 900;
const make = (): WorldTags =>
  new WorldTags({
    container,
    camera: () => ({ eye: EYE, aim: { x: 0, y: 0, z: -1 } }),
    project: pinhole,
    viewport: () => ({ width: W, height: H }),
    pxPerMetre: (depth) => (W / 2) / depth,
    measure: () => NATURAL,
  });

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  tags = make();
});
afterEach(() => {
  tags.dispose();
  document.body.replaceChildren();
});

const tagEl = (id: string): HTMLElement => container.querySelector(`[data-world-tag="${id}"]`) as HTMLElement;
const translate = (el: HTMLElement): [number, number] => {
  const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px, 0\)/.exec(el.style.transform)!;
  return [Number(m[1]), Number(m[2])];
};

describe('markup helpers', () => {
  it('facing="player" on the first element, and its width in metres', () => {
    expect(isFacingPlayerUi(TAG)).toBe(true);
    expect(tagWidthM(TAG)).toBe(1.8);
    expect(isFacingPlayerUi("<div facing='player'>x</div>")).toBe(true);
  });
  it('negative: a face panel, other facings, no markup', () => {
    expect(isFacingPlayerUi('<div face="front" width="2m">SHOP</div>')).toBe(false);
    expect(isFacingPlayerUi('<div facing="camera">x</div>')).toBe(false);
    expect(isFacingPlayerUi('<p>x</p><div facing="player"></div>')).toBe(false);
    expect(isFacingPlayerUi(undefined)).toBe(false);
    expect(tagWidthM('<div facing="player">x</div>')).toBeNull();
  });
});

describe('WorldTags', () => {
  it('projects a tag to its row, near the screen position of the row', () => {
    const node = nodeAt(2, 1.75, -10);
    expect(tags.extension(row('bot-1/tag', TAG), node)).not.toBeNull();
    tags.frame();
    const el = tagEl('bot-1/tag');
    const want = pinhole({ x: 2, y: 1.75, z: -10 });
    const [x, y] = translate(el);
    expect(Math.abs(x - want.x)).toBeLessThan(1);
    expect(Math.abs(y - want.y)).toBeLessThan(1);
    expect(el.style.visibility).toBe('');
    expect(el.style.position).toBe('fixed');
    expect(el.querySelector('div > div')?.textContent).toContain('BOT · PIP');
  });
  it('scales the content so width="1.8m" spans 1.8 m on screen at that depth', () => {
    tags.extension(row('t', TAG), nodeAt(0, 1.6, -10));
    tags.frame();
    const depth = Number(tagEl('t').style.getPropertyValue('--anchor-depth'));
    expect(depth).toBeCloseTo(10, 1);
    const want = (1.8 * (W / 2 / depth)) / NATURAL;
    const content = tagEl('t').firstElementChild as HTMLElement;
    expect(content.style.transform).toBe(`translate(-50%, -50%) scale(${Math.round(want * 1000) / 1000})`);
    // a tag twice as far is half the size
    const far = nodeAt(0, 1.6, -20);
    tags.extension(row('far', TAG), far);
    tags.frame();
    const k = (id: string) => Number(/scale\(([\d.]+)\)/.exec((tagEl(id).firstElementChild as HTMLElement).style.transform)![1]);
    expect(k('far') / k('t')).toBeCloseTo(0.5, 2);
  });
  it('follows a moving row and hides behind the camera', () => {
    const node = nodeAt(0, 1.6, -10);
    tags.extension(row('t', TAG), node);
    tags.frame();
    const before = translate(tagEl('t'));
    node.elements[12] = 3;
    tags.frame();
    expect(translate(tagEl('t'))[0]).toBeGreaterThan(before[0] + 50);
    node.elements[14] = 5; // behind the eye
    tags.frame();
    expect(tagEl('t').style.visibility).toBe('hidden');
  });
  it('an update rewrites the markup; dispose of the binding removes the tag', () => {
    const b = tags.extension(row('t', TAG), nodeAt(0, 1.6, -10))!;
    b.update!(row('t', TAG.replace('BOT · PIP', 'BOT · ZED')));
    expect(tagEl('t').textContent).toContain('ZED');
    b.dispose();
    expect(tagEl('t')).toBeNull();
    expect(tags.stats().tags).toBe(0);
  });
  it('negative: a panel string is not taken (the bridge falls back to the canvas panel)', () => {
    expect(tags.extension(row('sign', '<div face="front" width="2m">SHOP</div>'), nodeAt(0, 0, -5))).toBeNull();
    expect(container.children).toHaveLength(0);
  });
});
