// K13b: `highlightSet { style: "outline", width, duration, intensity }` (engine api-reference.md:654, :678; Crown & Clash hover on
// decorations, `chess-input.js:135`). Opt-in: PP refuses the style, and `HighlightHost.outline` turns it on. The pixels are the
// browser spec's; this file holds the state, the scene graph and the material contract on a real model instance.
import { BackSide, LessEqualDepth, Object3D } from 'three/webgpu';
import type { Mesh } from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RowNodeView } from '../../../../src/render/bridge/bridge-types.ts';
import { ModelInstance } from '../../../../src/render/models/model-instance.ts';
import { buildModelTemplate, modelSourceFromGltf, type ModelTemplate } from '../../../../src/render/models/model-template.ts';
import { HIGHLIGHT_BODY_ORDER, HIGHLIGHT_KEY, HIGHLIGHT_VISIBLE_ORDER, HighlightRenderer, type HighlightMarkInput } from '../../../../src/render/special/highlight.ts';
import { OUTLINE_DEFAULT_ALPHA, OUTLINE_DEFAULT_WIDTH_PX, outlineNdcPerPixel } from '../../../../src/render/special/highlight-outline.ts';
import { FIXTURE_FACTS, fixtureGlb, parseGlb, testEnv, type TestEnv } from '../models/model-fixtures.ts';

let env: TestEnv;
let template: ModelTemplate;

beforeAll(async () => {
  env = testEnv();
  template = buildModelTemplate(modelSourceFromGltf('value.00f1c5.glb', await parseGlb(await fixtureGlb()), FIXTURE_FACTS), env);
});

function scene(outline: boolean) {
  const rows = new Map<string, { object: Object3D; model: ModelInstance }>();
  const logs: string[] = [];
  const view = (id: string): RowNodeView | undefined => {
    const r = rows.get(id);
    return r === undefined ? undefined : { id, object: r.object, model: r.model, world: r.object.matrixWorld.elements, visible: true };
  };
  const hl = new HighlightRenderer({ node: view, look: env.look, log: (m) => logs.push(m), ...(outline ? { outline: true } : {}) });
  const add = (id: string): ModelInstance => {
    const object = new Object3D();
    const model = new ModelInstance(template, env.look);
    object.add(model.root);
    rows.set(id, { object, model });
    return model;
  };
  return { hl, logs, add };
}

const mark = (style: unknown, extra: Partial<HighlightMarkInput> = {}): HighlightMarkInput => ({ color: 'oklch(0.8 0.15 60)', style, ...extra });

describe('outline is opt-in', () => {
  it('control: without the switch the style is refused with one log line, as in PP', () => {
    const s = scene(false);
    s.add('a');
    s.hl.set('a', mark('outline', { width: 2 }));
    s.hl.set('a', mark(undefined));
    s.hl.update();
    expect(s.hl.styleOf('a')).toBeNull();
    expect(s.hl.stats()).toEqual({ marks: 0, drawn: 0, overlays: 0, refused: 2 });
    expect(s.logs.filter((l) => l.includes("'outline'"))).toHaveLength(1);
    expect(s.hl.outlineMaterial).toBeNull();
  });

  it('with the switch the style is drawn, and a mark with no style is an outline (the engine default)', () => {
    const s = scene(true);
    s.add('a');
    s.add('b');
    s.hl.set('a', mark('outline'));
    s.hl.set('b', mark(undefined));
    s.hl.update();
    expect(s.hl.styleOf('a')).toBe('outline');
    expect(s.hl.styleOf('b')).toBe('outline');
    expect(s.hl.stats()).toEqual({ marks: 2, drawn: 2, overlays: 2, refused: 0 });
    expect(s.logs).toEqual([]);
  });

  it('glow and unknown styles are still refused', () => {
    const s = scene(true);
    s.add('a');
    s.hl.set('a', mark('glow'));
    s.hl.set('a', mark('sparkle'));
    expect(s.hl.stats().refused).toBe(2);
    expect(s.hl.styleOf('a')).toBeNull();
  });
});

describe('the outline overlay', () => {
  it('is one back-face hull after the body, depth tested, sharing the model geometry', () => {
    const s = scene(true);
    const model = s.add('a');
    s.hl.set('a', mark('outline'));
    s.hl.update();
    const [hull] = s.hl.overlaysOf('a') as Mesh[];
    expect(s.hl.overlaysOf('a')).toHaveLength(1);
    expect(hull!.geometry).toBe((model.opaqueMesh as Mesh).geometry);
    expect(hull!.parent).toBe((model.opaqueMesh as Mesh).parent);
    expect(hull!.renderOrder).toBe(HIGHLIGHT_VISIBLE_ORDER);
    expect(HIGHLIGHT_BODY_ORDER).toBeLessThan(hull!.renderOrder);
    const m = hull!.material as Mesh['material'] & { side: number; depthFunc: number; depthWrite: boolean; vertexNode: unknown };
    expect(m).toBe(s.hl.outlineMaterial);
    expect(m.side).toBe(BackSide);
    expect(m.depthFunc).toBe(LessEqualDepth);
    expect(m.depthWrite).toBe(false);
    expect(m.vertexNode).not.toBeNull();
    // the body's own mesh is moved one order later, as for the other styles
    expect((model.opaqueMesh as Mesh).renderOrder).toBe(HIGHLIGHT_BODY_ORDER);
  });

  it('takes width (default 2), intensity (default 1) and the colour as per-object values', () => {
    const s = scene(true);
    s.add('a');
    s.add('b');
    s.hl.set('a', mark('outline'));
    s.hl.set('b', mark('outline', { width: 5, intensity: 0.4 }));
    s.hl.update();
    const va = s.hl.overlaysOf('a')[0]!.userData[HIGHLIGHT_KEY];
    const vb = s.hl.overlaysOf('b')[0]!.userData[HIGHLIGHT_KEY];
    expect(va.width).toBe(OUTLINE_DEFAULT_WIDTH_PX);
    expect(OUTLINE_DEFAULT_WIDTH_PX).toBe(2);
    expect(va.alpha).toBe(OUTLINE_DEFAULT_ALPHA);
    expect(vb.width).toBe(5);
    expect(vb.alpha).toBeCloseTo(0.4, 12);
    expect(vb.color).not.toBe(va.color);
    // junk falls back to the defaults
    s.hl.set('a', mark('outline', { width: -3, intensity: 'x' }));
    expect(s.hl.overlaysOf('a')[0]!.userData[HIGHLIGHT_KEY].width).toBe(2);
  });

  it('one pixel of a 1080p picture is 2/1080 of the NDC height', () => {
    expect(outlineNdcPerPixel() * 1080).toBeCloseTo(2, 12);
  });

  it('a mark replaced by another style rebuilds its overlays; xray and pulse are unaffected by the switch', () => {
    const s = scene(true);
    s.add('a');
    s.hl.set('a', mark('outline'));
    s.hl.update();
    expect(s.hl.overlaysOf('a')).toHaveLength(1);
    s.hl.set('a', mark('pulse'));
    s.hl.update();
    expect(s.hl.overlaysOf('a')).toHaveLength(2);
    expect(s.hl.overlaysOf('a')[0]!.material).toBe(s.hl.hidden);
    s.hl.set('a', mark('xray'));
    s.hl.update();
    expect(s.hl.overlaysOf('a')).toHaveLength(1);
    expect(s.hl.overlaysOf('a')[0]!.material).toBe(s.hl.hidden);
  });
});

describe('duration', () => {
  it('a timed outline clears itself after its seconds of presentation time; an untimed one stays; dt 0 holds it', () => {
    const s = scene(true);
    s.add('timed');
    s.add('forever');
    s.hl.set('timed', mark('outline', { duration: 0.5 }));
    s.hl.set('forever', mark('outline'));
    s.hl.update(0.3);
    expect(s.hl.styleOf('timed')).toBe('outline');
    s.hl.update(0);
    expect(s.hl.styleOf('timed')).toBe('outline');
    s.hl.update(0.3);
    expect(s.hl.styleOf('timed')).toBeNull();
    expect(s.hl.overlaysOf('timed')).toHaveLength(0);
    expect(s.hl.styleOf('forever')).toBe('outline');
  });

  it('a new mark restarts the clock', () => {
    const s = scene(true);
    s.add('a');
    s.hl.set('a', mark('outline', { duration: 0.5 }));
    s.hl.update(0.4);
    s.hl.set('a', mark('outline', { duration: 0.5 }));
    s.hl.update(0.4);
    expect(s.hl.styleOf('a')).toBe('outline');
    s.hl.update(0.2);
    expect(s.hl.styleOf('a')).toBeNull();
  });
});

describe('the warm-up', () => {
  it('lists the outline stand-ins only when the switch is on', () => {
    const off = scene(false).hl.warmObjects();
    const on = scene(true).hl.warmObjects();
    expect(on.length).toBeGreaterThan(off.length);
    expect(on.filter((o) => o.name.includes('outline')).length).toBe(on.length - off.length);
    expect(off.every((o) => !o.name.includes('outline'))).toBe(true);
  });
});
