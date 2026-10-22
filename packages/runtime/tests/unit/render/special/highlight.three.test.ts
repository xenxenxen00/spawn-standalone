// RH1 (docs/architecture.md X-47, §9.3 RH1): src/render/special/highlight.ts, the renderer behind `highlightSet` /
// `highlightClear`, on a real R6 model instance (the fixture GLB of the model tests: skinned, part-masked) and a fake bridge
// node view. The pixels (the silhouette only where a wall hides the body, the pulse, no program after the warm-up) are the
// SwiftShader spec's (tests/e2e/render-rh1.spec.ts); this file holds the state, the scene graph and the material contract.
import { CustomBlending, GreaterDepth, LessEqualDepth, Mesh, Object3D, SkinnedMesh } from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RowNodeView } from '../../../../src/render/bridge/bridge-types.ts';
import { cssToLinear } from '../../../../src/render/color/color.ts';
import { ModelInstance } from '../../../../src/render/models/model-instance.ts';
import { BONE_CLASSES, buildModelTemplate, modelSourceFromGltf, type ModelTemplate } from '../../../../src/render/models/model-template.ts';
import {
  HIGHLIGHT_BODY_ORDER, HIGHLIGHT_KEY, HIGHLIGHT_RENDER_ORDER, HIGHLIGHT_VISIBLE_ORDER, HighlightRenderer, highlightColorOf, type HighlightMarkInput,
} from '../../../../src/render/special/highlight.ts';
import { LOOK_ROW_KEY, lookRow } from '../../../../src/render/surface/look-table.ts';
import { FIXTURE_FACTS, fixtureGlb, parseGlb, testEnv, type TestEnv } from '../models/model-fixtures.ts';

const ALIVE = 'oklch(0.85 0.13 200)';
const DOWN = 'oklch(0.65 0.24 25)';

let env: TestEnv;
let template: ModelTemplate;

beforeAll(async () => {
  env = testEnv();
  template = buildModelTemplate(modelSourceFromGltf('value.00f1c5.glb', await parseGlb(await fixtureGlb()), FIXTURE_FACTS), env);
});

/** a bridge with rows whose models can be set, swapped and removed */
function scene(eye?: { x: number; y: number; z: number }) {
  const rows = new Map<string, { object: Object3D; model: ModelInstance | null }>();
  const logs: string[] = [];
  const view = (id: string): RowNodeView | undefined => {
    const r = rows.get(id);
    return r === undefined ? undefined : { id, object: r.object, model: r.model, world: r.object.matrixWorld.elements, visible: true };
  };
  const hl = new HighlightRenderer({ node: view, look: env.look, ...(eye === undefined ? {} : { eye: () => eye }), log: (m) => logs.push(m) });
  const add = (id: string, withModel = true): { object: Object3D; model: ModelInstance | null } => {
    const object = new Object3D();
    const model = withModel ? new ModelInstance(template, env.look) : null;
    if (model) object.add(model.root);
    const r = { object, model };
    rows.set(id, r);
    return r;
  };
  const setModel = (id: string, model: ModelInstance | null): void => {
    const r = rows.get(id)!;
    r.model?.dispose();
    r.model = model;
    if (model) r.object.add(model.root);
  };
  return { hl, rows, logs, add, setModel, remove: (id: string) => rows.delete(id) };
}

const mark = (color: unknown, style: unknown): HighlightMarkInput => ({ color, style });

/** a TSL node as the graph walk reads it */
interface GraphNode {
  id: number;
  isTextureNode?: boolean;
  value?: unknown;
  getChildren(): Iterable<GraphNode>;
}
/** every node reachable from `root` (three's `Node.getChildren`) */
function nodeGraph(root: GraphNode): GraphNode[] {
  const seen = new Map<number, GraphNode>();
  const walk = (n: GraphNode): void => {
    if (seen.has(n.id)) return;
    seen.set(n.id, n);
    for (const c of n.getChildren()) walk(c);
  };
  walk(root);
  return [...seen.values()];
}
const meshesOf = (o: Object3D): Mesh[] => {
  const out: Mesh[] = [];
  o.traverse((c) => {
    if ((c as Mesh).isMesh === true && c.userData[HIGHLIGHT_KEY] === undefined) out.push(c as Mesh);
  });
  return out;
};

describe('highlight state (the act wiring\'s sink)', () => {
  it('xray: one silhouette on the model, sharing its geometry, skeleton and bind matrix, under the model root', () => {
    const s = scene();
    const bot = s.add('bot-1');
    s.hl.set('bot-1', mark(ALIVE, 'xray'));
    expect(s.hl.overlaysOf('bot-1')).toHaveLength(0); // built in update(), after the bridge
    s.hl.update();
    const [o, ...rest] = s.hl.overlaysOf('bot-1');
    expect(rest).toHaveLength(0);
    const src = bot.model!.opaqueMesh as SkinnedMesh;
    expect(o).toBeInstanceOf(SkinnedMesh);
    const sk = o as SkinnedMesh;
    expect(sk.geometry).toBe(src.geometry);
    expect(sk.skeleton).toBe(src.skeleton);
    expect(sk.bindMatrix.equals(src.bindMatrix)).toBe(true);
    expect(sk.parent).toBe(src.parent);
    expect(sk.material).toBe(s.hl.hidden);
    expect(sk.renderOrder).toBe(HIGHLIGHT_RENDER_ORDER);
    expect(sk.castShadow).toBe(false);
    expect(sk.userData[LOOK_ROW_KEY]).toBe(bot.model!.lookRow);
    const lin = cssToLinear(ALIVE)!;
    const values = sk.userData[HIGHLIGHT_KEY] as { color: { r: number; g: number; b: number }; pulse: number };
    expect([values.color.r, values.color.g, values.color.b]).toEqual(lin);
    expect(values.pulse).toBe(0);
    expect(s.hl.stats()).toEqual({ marks: 1, drawn: 1, overlays: 1, refused: 0 });
  });

  it('the target\'s own meshes draw after the hidden silhouette while marked, and get their order back on clear', () => {
    const s = scene();
    const bot = s.add('bot-1');
    const gear = new Mesh(); // a row hung on the body later (a weapon): caught by the next update
    s.hl.set('bot-1', mark(ALIVE, 'xray'));
    s.hl.update();
    for (const m of meshesOf(bot.object)) expect(m.renderOrder, m.name).toBe(HIGHLIGHT_BODY_ORDER);
    gear.renderOrder = 3;
    bot.object.add(gear);
    s.hl.update();
    expect(gear.renderOrder).toBe(HIGHLIGHT_BODY_ORDER);
    s.hl.clear('bot-1');
    expect(gear.renderOrder).toBe(3);
    for (const m of meshesOf(bot.object)) if (m !== gear) expect(m.renderOrder).toBe(0);
    expect(s.hl.overlaysOf('bot-1')).toHaveLength(0);
    expect(bot.model!.root.children.some((c) => c.userData[HIGHLIGHT_KEY] !== undefined)).toBe(false);
  });

  it('pulse: the hidden silhouette and the visible tint, both pulsing; a change of style rebuilds, a change of colour does not', () => {
    const s = scene();
    s.add('bot-1');
    s.hl.set('bot-1', mark(ALIVE, 'xray'));
    s.hl.update();
    const first = s.hl.overlaysOf('bot-1')[0]!;
    s.hl.set('bot-1', mark(DOWN, 'pulse'));
    s.hl.update();
    const [hidden, visible] = s.hl.overlaysOf('bot-1');
    expect(hidden!.material).toBe(s.hl.hidden);
    expect(visible!.material).toBe(s.hl.visible);
    expect(visible!.renderOrder).toBe(HIGHLIGHT_VISIBLE_ORDER);
    expect(first.parent).toBeNull();
    const values = hidden!.userData[HIGHLIGHT_KEY] as { pulse: number };
    expect(values.pulse).toBe(1);
    expect(visible!.userData[HIGHLIGHT_KEY]).toBe(values);
    // same style, new colour: the same overlays, the per-object value updated
    s.hl.set('bot-1', mark('#00ff00', 'pulse'));
    s.hl.update();
    expect(s.hl.overlaysOf('bot-1')).toEqual([hidden, visible]);
    expect((hidden!.userData[HIGHLIGHT_KEY] as { color: { g: number } }).color.g).toBeCloseTo(1, 6);
  });

  it('a mark set before its row or its model exists waits, and shows once they do (marks sent before the engine)', () => {
    const s = scene();
    s.hl.set('bot-2', mark(ALIVE, 'xray'));
    s.hl.update();
    expect(s.hl.stats()).toMatchObject({ marks: 1, drawn: 0 });
    s.add('bot-2', false); // the row is there, its model still loads
    s.hl.update();
    expect(s.hl.stats()).toMatchObject({ marks: 1, drawn: 0 });
    s.setModel('bot-2', new ModelInstance(template, env.look));
    s.hl.update();
    expect(s.hl.stats()).toMatchObject({ marks: 1, drawn: 1, overlays: 1 });
  });

  it('a model swap moves the silhouette to the new instance; a lost model takes it down until one comes back', () => {
    const s = scene();
    const bot = s.add('bot-1');
    s.hl.set('bot-1', mark(DOWN, 'pulse'));
    s.hl.update();
    const old = bot.model!;
    const next = new ModelInstance(template, env.look);
    s.setModel('bot-1', next);
    s.hl.update();
    const overlays = s.hl.overlaysOf('bot-1');
    expect(overlays).toHaveLength(2);
    for (const o of overlays) {
      expect(o.parent).toBe(next.root);
      expect((o as SkinnedMesh).skeleton).toBe(next.skeleton);
      expect(o.userData[LOOK_ROW_KEY]).toBe(next.lookRow);
    }
    expect(old.root.children.some((c) => c.userData[HIGHLIGHT_KEY] !== undefined)).toBe(false);
    s.setModel('bot-1', null);
    s.hl.update();
    expect(s.hl.stats()).toMatchObject({ marks: 1, drawn: 0, overlays: 0 });
  });

  it('follows the part mask through the look row, not through a program: setParts changes no overlay', () => {
    const s = scene();
    const bot = s.add('bot-1');
    s.hl.set('bot-1', mark(ALIVE, 'xray'));
    s.hl.update();
    const before = s.hl.overlaysOf('bot-1')[0]!;
    bot.model!.setParts({ part_head: { visible: false } });
    bot.model!.setSlot('skin.001', { mode: 'replace', albedo: [1, 0, 0] });
    s.hl.update();
    expect(s.hl.overlaysOf('bot-1')[0]).toBe(before);
    expect(before.material).toBe(s.hl.hidden);
    // the silhouette's position stage is the part-mask factor (look-table.ts partKeepNode)
    expect(s.hl.hidden.positionNode).not.toBeNull();
    // the position graph reads the look table's mask texture and the per-object look row (not a bare positionLocal)
    for (const m of [s.hl.hidden, s.hl.visible]) {
      const graph = nodeGraph(m.positionNode as unknown as GraphNode);
      expect(graph.some((n) => n.isTextureNode === true && n.value === env.look.texture), `${m.name}: reads the look texture`).toBe(true);
      expect(graph.some((n) => n.id === (lookRow as unknown as GraphNode).id), `${m.name}: reads ssLookRow`).toBe(true);
      expect(graph.some((n) => (n as { getAttributeName?: (b: unknown) => string }).getAttributeName?.(null) === 'partPaint'), `${m.name}: reads the ss attribute`).toBe(true);
    }
    expect(before.userData[LOOK_ROW_KEY]).toBe(bot.model!.lookRow);
  });

  it('refuses the styles the game never sends (outline, glow, none) with one log line per style; the target stays unmarked', () => {
    const s = scene();
    s.add('bot-1');
    s.hl.set('bot-1', mark(ALIVE, 'xray'));
    s.hl.update();
    s.hl.set('bot-1', mark(ALIVE, 'outline'));
    s.hl.set('bot-1', mark(ALIVE, 'outline'));
    s.hl.set('bot-1', mark(ALIVE, 'glow'));
    s.hl.set('bot-1', mark(ALIVE, undefined));
    s.hl.update();
    expect(s.hl.styleOf('bot-1')).toBeNull();
    expect(s.hl.stats()).toEqual({ marks: 0, drawn: 0, overlays: 0, refused: 4 });
    expect(s.logs.filter((l) => l.includes("'outline'"))).toHaveLength(1);
    expect(s.logs.filter((l) => l.includes("'glow'"))).toHaveLength(1);
    expect(s.logs.filter((l) => l.includes('undefined'))).toHaveLength(1);
  });

  it('reset replaces the whole table (a renderer attaching, a rebuild); clear of an unknown target is nothing', () => {
    const s = scene();
    s.add('a');
    s.add('b');
    s.add('c');
    s.hl.set('a', mark(ALIVE, 'xray'));
    s.hl.update();
    s.hl.reset(new Map([['b', mark(ALIVE, 'xray')], ['c', mark(DOWN, 'pulse')]]));
    s.hl.update();
    expect(s.hl.styleOf('a')).toBeNull();
    expect(s.hl.overlaysOf('a')).toHaveLength(0);
    expect(s.hl.styleOf('b')).toBe('xray');
    expect(s.hl.styleOf('c')).toBe('pulse');
    expect(s.hl.stats()).toEqual({ marks: 2, drawn: 2, overlays: 3, refused: 0 });
    s.hl.clear('never');
    expect(s.hl.stats().marks).toBe(2);
  });

  it('five outlined teammates: five silhouette draws, two materials for all of them', () => {
    const s = scene();
    for (let i = 0; i < 5; i++) {
      s.add(`bot-${i}`);
      s.hl.set(`bot-${i}`, mark(ALIVE, 'xray'));
    }
    s.hl.update();
    const materials = new Set<unknown>();
    for (let i = 0; i < 5; i++) for (const o of s.hl.overlaysOf(`bot-${i}`)) materials.add(o.material);
    expect(s.hl.stats()).toEqual({ marks: 5, drawn: 5, overlays: 5, refused: 0 });
    expect(materials).toEqual(new Set([s.hl.hidden]));
  });

  it('parses the game\'s colours (oklch, hex, numbers); an unparsable one draws in white with a log line', () => {
    expect(highlightColorOf(DOWN)!.toArray()).toEqual(cssToLinear(DOWN));
    expect(highlightColorOf('#ff0000')!.r).toBeCloseTo(1, 6);
    expect(highlightColorOf(0x00ff00)!.g).toBeCloseTo(1, 6);
    expect(highlightColorOf({})).toBeNull();
    const s = scene();
    s.add('bot-1');
    s.hl.set('bot-1', mark('not a colour', 'xray'));
    s.hl.update();
    const v = s.hl.overlaysOf('bot-1')[0]!.userData[HIGHLIGHT_KEY] as { color: { r: number; g: number; b: number } };
    expect([v.color.r, v.color.g, v.color.b]).toEqual([1, 1, 1]);
    expect(s.logs.some((l) => l.includes('does not parse'))).toBe(true);
  });
});

describe('highlight draw order', () => {
  it('draws the hidden silhouettes far to near (they write no depth): a nearer one lies over a farther one', () => {
    const s = scene({ x: 0, y: 1.7, z: 10 });
    const at = [['near', 8], ['far', -20], ['mid', 0]] as const;
    for (const [id, z] of at) {
      const r = s.add(id);
      r.object.position.set(0, 0, z);
      r.object.updateMatrixWorld(true);
      s.hl.set(id, mark(id === 'mid' ? DOWN : ALIVE, id === 'mid' ? 'pulse' : 'xray'));
    }
    s.hl.update();
    const order = (id: string): number => s.hl.overlaysOf(id)[0]!.renderOrder;
    expect(order('far')).toBeLessThan(order('mid'));
    expect(order('mid')).toBeLessThan(order('near'));
    for (const [id] of at) {
      expect(order(id)).toBeGreaterThanOrEqual(HIGHLIGHT_RENDER_ORDER);
      expect(order(id)).toBeLessThan(HIGHLIGHT_RENDER_ORDER + 0.5);
    }
    // the pulse's visible tint keeps its own order, after the bodies
    expect(s.hl.overlaysOf('mid')[1]!.renderOrder).toBe(HIGHLIGHT_VISIBLE_ORDER);
  });
});

describe('highlight materials and the warm-up', () => {
  it('two materials of one structure: the depth and blend state differ, the program inputs do not', () => {
    const s = scene();
    const { hidden, visible } = s.hl;
    expect(hidden.depthFunc).toBe(GreaterDepth);
    expect(visible.depthFunc).toBe(LessEqualDepth);
    expect(visible.polygonOffset).toBe(true);
    for (const m of [hidden, visible]) {
      // opaque list (between the world and the body), but blended: custom blending keeps the alpha
      expect(m.transparent).toBe(false);
      expect(m.blending).toBe(CustomBlending);
      expect(m.depthWrite).toBe(false);
      expect(m.fog).toBe(false);
      expect(m.colorNode).not.toBeNull();
      expect(m.opacityNode).not.toBeNull();
      expect(m.positionNode).not.toBeNull();
    }
    expect(hidden.colorNode).toBe(visible.colorNode); // the shared per-object colour uniform
  });

  it('warmObjects: per material a plain mesh and one skinned mesh per bone-count class, each with and without uv', () => {
    const s = scene();
    const objects = s.hl.warmObjects();
    expect(objects).toHaveLength(2 * 2 * (1 + BONE_CLASSES.length));
    const skinned = objects.filter((o) => (o as SkinnedMesh).isSkinnedMesh === true) as SkinnedMesh[];
    expect(new Set(skinned.map((o) => o.skeleton.bones.length))).toEqual(new Set(BONE_CLASSES));
    for (const o of objects as Mesh[]) {
      expect([s.hl.hidden, s.hl.visible]).toContain(o.material);
      expect(o.geometry.hasAttribute('partPaint')).toBe(true);
    }
    expect(objects.filter((o) => (o as Mesh).geometry.hasAttribute('uv'))).toHaveLength(objects.length / 2);
  });

  it('dispose takes every overlay down and puts the bodies back', () => {
    const s = scene();
    const bot = s.add('bot-1');
    s.hl.set('bot-1', mark(DOWN, 'pulse'));
    s.hl.update();
    s.hl.dispose();
    expect(bot.model!.root.children.some((c) => c.userData[HIGHLIGHT_KEY] !== undefined)).toBe(false);
    for (const m of meshesOf(bot.object)) expect(m.renderOrder).toBe(0);
    s.hl.set('bot-1', mark(DOWN, 'pulse'));
    s.hl.update();
    expect(s.hl.stats().marks).toBe(0);
  });
});
