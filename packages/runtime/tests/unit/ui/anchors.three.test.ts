// AnchorProjector maths (io §3.7; spawn-engine-contract.md §14.1-14.2; X-46; WP UI2a): `data-world-anchor` elements are placed
// by projecting the row's anchor point through a three `PerspectiveCamera` built in Node with no renderer. The adapter below is
// render's `project()` maths (render §4.2: `Vector3.project(camera)` → NDC → CSS px of the field). The DOM here is a minimal
// fake (the elements, their attributes and a recording inline style): the projector's DOM contract is three attribute reads
// and six style writes, and the recording style proves it writes nothing else. The real DOM, the game-authored inline style
// and the idiomorph morph are covered in anchors.dom.test.ts (jsdom).
import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/compat/core/types.ts';
import { ANCHOR_MARGIN, AnchorProjector, parseAnchorOffset, type AnchorDeps, type AnchorRow } from '../../../src/runtime/ui/anchors.ts';

const VFOV = 58.72; // render §4.2: the vertical fov of hfov 90 at 16:9 (scripts/camera.js:356-367)
const T = Math.tan(((VFOV / 2) * Math.PI) / 180);

// ── fake DOM ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface FakeStyle {
  transform: string;
  visibility: string;
  position: string;
  left: string;
  top: string;
  opacity: string;
  setProperty(name: string, value: string): void;
  getPropertyValue(name: string): string;
  /** every property assigned or set, in order */
  readonly sets: string[];
}

/** an inline style as the game authored it (hud.js:153): only `opacity`; records every write */
function fakeStyle(): FakeStyle {
  const custom = new Map<string, string>();
  const sets: string[] = [];
  const base = {
    transform: '',
    visibility: '',
    position: '',
    left: '',
    top: '',
    opacity: 'clamp(.35, calc(1.25 - var(--anchor-depth, 0) / 45), 1)',
    sets,
    setProperty(name: string, value: string): void {
      sets.push(name);
      custom.set(name, value);
    },
    getPropertyValue(name: string): string {
      return custom.get(name) ?? '';
    },
  };
  return new Proxy(base, {
    set(target, key, value): boolean {
      sets.push(String(key));
      (target as Record<string, unknown>)[String(key)] = value;
      return true;
    },
  });
}

class FakeEl {
  style: FakeStyle = fakeStyle();
  readonly attrs: Record<string, string>;
  constructor(id: string, offset?: string) {
    this.attrs = { 'data-world-anchor': id, ...(offset !== undefined ? { 'data-anchor-offset': offset } : {}) };
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  /** what a morph that resets the style attribute leaves: the game's inline style only */
  resetStyle(): void {
    this.style = fakeStyle();
  }
}

class FakeRoot {
  els: FakeEl[];
  queries: string[] = [];
  constructor(...els: FakeEl[]) {
    this.els = els;
  }
  querySelectorAll(selector: string): FakeEl[] {
    this.queries.push(selector);
    return this.els;
  }
}

// ── the three side ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface Rig {
  camera: PerspectiveCamera;
  rows: Map<string, AnchorRow>;
  deps: AnchorDeps;
  projector: AnchorProjector;
  /** the points handed to project(), copied */
  projected: Vec3[];
  field: { width: number; height: number; left?: number; top?: number };
}

function rig(opts: { W?: number; H?: number; eye?: Vec3; yaw?: number; pitch?: number } = {}): Rig {
  const W = opts.W ?? 1280;
  const H = opts.H ?? 720;
  const eye = opts.eye ?? { x: 0, y: 1.6, z: 0 };
  const camera = new PerspectiveCamera(VFOV, W / H, 0.1, 2000);
  camera.position.set(eye.x, eye.y, eye.z);
  camera.rotation.set(opts.pitch ?? 0, opts.yaw ?? 0, 0, 'YXZ');
  camera.updateMatrixWorld();
  const rows = new Map<string, AnchorRow>();
  const projected: Vec3[] = [];
  const field: Rig['field'] = { width: W, height: H };
  const v = new Vector3();
  const deps: AnchorDeps = {
    // render §4.2: Vector3.project(camera) → NDC → css px of the active field
    project(p) {
      projected.push({ x: p.x, y: p.y, z: p.z });
      v.set(p.x, p.y, p.z).project(camera);
      return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, depth: v.z, onScreen: Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && Math.abs(v.z) <= 1 };
    },
    camera() {
      const d = camera.getWorldDirection(new Vector3());
      return { eye: { x: camera.position.x, y: camera.position.y, z: camera.position.z }, aim: { x: d.x, y: d.y, z: d.z } };
    },
    getObject: (id) => rows.get(id) ?? null,
    viewport: () => field,
  };
  return { camera, rows, deps, projector: new AnchorProjector(deps), projected, field };
}

const row = (feet: Vec3, top?: number): AnchorRow => ({
  feetPosition: feet,
  worldFeetPosition: feet,
  bounds: top === undefined ? undefined : { min: { x: feet.x - 0.3, y: feet.y, z: feet.z - 0.3 }, max: { x: feet.x + 0.3, y: top, z: feet.z + 0.3 } },
});

const asRoot = (r: FakeRoot): HTMLElement => r as unknown as HTMLElement;

/** the `translate3d(Xpx, Ypx, 0)` an element carries */
function at(el: FakeEl): { x: number; y: number } {
  const m = /^translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\)$/.exec(el.style.transform);
  expect(m, `transform "${el.style.transform}"`).not.toBeNull();
  return { x: Number(m![1]), y: Number(m![2]) };
}

const hidden = (el: FakeEl): boolean => el.style.visibility === 'hidden';

/** the world point that lands at NDC (nx, ny), `dist` metres ahead of a camera at `eye` facing −Z */
const atNdc = (eye: Vec3, nx: number, ny: number, aspect: number, dist = 10): Vec3 => ({ x: eye.x + nx * dist * T * aspect, y: eye.y + ny * dist * T, z: eye.z - dist });

// ── tests ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('projection through a three PerspectiveCamera (fov 58.72°, no renderer)', () => {
  it('a point straight ahead lands on the exact centre of a 1280×720 field', () => {
    const r = rig();
    r.rows.set('npc', row({ x: 0, y: 0, z: -10 }));
    const el = new FakeEl('npc', '0 1.6 0');
    r.projector.project(asRoot(new FakeRoot(el)));
    expect(el.style.transform).toBe('translate3d(640px, 360px, 0)');
    expect(hidden(el)).toBe(false);
  });

  it('and on the centre of an 844×390 field', () => {
    const r = rig({ W: 844, H: 390 });
    r.rows.set('npc', row({ x: 0, y: 0, z: -25 }));
    const el = new FakeEl('npc', '0 1.6 0');
    r.projector.project(asRoot(new FakeRoot(el)));
    expect(el.style.transform).toBe('translate3d(422px, 195px, 0)');
  });

  it('an off-axis point lands on the hand-computed pixel (half height = tan(fov/2), half width = that × aspect)', () => {
    for (const [W, H] of [
      [1280, 720],
      [844, 390],
    ] as const) {
      const r = rig({ W, H });
      // 2 m right, 1 m up, 10 m ahead of the eye
      r.rows.set('npc', row({ x: 2, y: 0, z: -10 }));
      const el = new FakeEl('npc', '0 2.6 0');
      r.projector.project(asRoot(new FakeRoot(el)));
      const want = { x: ((2 / (10 * T * (W / H))) * 0.5 + 0.5) * W, y: (-(1 / (10 * T)) * 0.5 + 0.5) * H };
      const got = at(el);
      expect(got.x).toBeCloseTo(want.x, 1);
      expect(got.y).toBeCloseTo(want.y, 1);
      // right of and above the centre
      expect(got.x).toBeGreaterThan(W / 2);
      expect(got.y).toBeLessThan(H / 2);
    }
  });

  it('a point 45° to the right is on the right edge: hfov is 90° at 16:9', () => {
    const r = rig();
    r.rows.set('npc', row({ x: 10, y: 0, z: -10 }));
    const el = new FakeEl('npc', '0 1.6 0');
    r.projector.project(asRoot(new FakeRoot(el)));
    const got = at(el);
    expect(Math.abs(got.x - 1280)).toBeLessThan(0.1); // 58.72° is the rounded vfov: 1279.94
    expect(got.y).toBeCloseTo(360, 1);
  });

  it('follows the camera conventions: yaw π/2 faces −X, pitch 30° raises the forward to y = 0.5', () => {
    const yawed = rig({ yaw: Math.PI / 2 });
    yawed.rows.set('npc', row({ x: -10, y: 0, z: 0 }));
    const a = new FakeEl('npc', '0 1.6 0');
    yawed.projector.project(asRoot(new FakeRoot(a)));
    expect(at(a).x).toBeCloseTo(640, 1);
    expect(at(a).y).toBeCloseTo(360, 1);

    const pitched = rig({ pitch: Math.PI / 6 });
    pitched.rows.set('npc', row({ x: 0, y: 1.6 + 5, z: -10 * Math.cos(Math.PI / 6) }));
    const b = new FakeEl('npc', '0 0 0');
    pitched.projector.project(asRoot(new FakeRoot(b)));
    expect(at(b).x).toBeCloseTo(640, 1);
    expect(at(b).y).toBeCloseTo(360, 1);
    // and what was straight ahead is now below the centre
    pitched.rows.set('low', row({ x: 0, y: 1.6, z: -10 }));
    const c = new FakeEl('low', '0 0 0');
    pitched.projector.project(asRoot(new FakeRoot(c)));
    expect(at(c).y).toBeGreaterThan(360);
  });

  it('adds the field origin when the stage field does not start at the viewport corner', () => {
    const r = rig();
    r.field.left = 40;
    r.field.top = 12;
    r.rows.set('npc', row({ x: 0, y: 0, z: -10 }));
    const el = new FakeEl('npc', '0 1.6 0');
    r.projector.project(asRoot(new FakeRoot(el)));
    expect(el.style.transform).toBe('translate3d(680px, 372px, 0)');
  });
});

describe('the anchor point (contract §14.1: feet + offset, or the top of the bounds)', () => {
  it('the live offsets: teammate plate 0 2.15 0, terminal marker 0 2.3 0, metres from the feet', () => {
    const r = rig();
    r.rows.set('player/bot1/body', row({ x: 1, y: 0.25, z: -8 }, 1.9));
    r.rows.set('terminal/t1', row({ x: -2, y: 0, z: -12 }, 1.2));
    const plate = new FakeEl('player/bot1/body', '0 2.15 0');
    const term = new FakeEl('terminal/t1', '0 2.3 0');
    r.projector.project(asRoot(new FakeRoot(plate, term)));
    expect(r.projected).toHaveLength(2);
    expect(r.projected[0]!.x).toBe(1);
    expect(r.projected[0]!.y).toBeCloseTo(2.4, 10);
    expect(r.projected[0]!.z).toBe(-8);
    expect(r.projected[1]).toEqual({ x: -2, y: 2.3, z: -12 });
    expect(hidden(plate)).toBe(false);
    expect(hidden(term)).toBe(false);
  });

  it('an offset moves along all three axes', () => {
    const r = rig();
    r.rows.set('npc', row({ x: 1, y: 2, z: -10 }));
    r.projector.project(asRoot(new FakeRoot(new FakeEl('npc', ' 0.5  -1\t2 '))));
    expect(r.projected[0]).toEqual({ x: 1.5, y: 1, z: -8 });
  });

  it('no offset: the X/Z of the feet at the top of the row bounds (bounds.max.y)', () => {
    const r = rig();
    r.rows.set('npc', row({ x: 1, y: 0, z: -10 }, 1.83));
    const el = new FakeEl('npc');
    r.projector.project(asRoot(new FakeRoot(el)));
    expect(r.projected[0]).toEqual({ x: 1, y: 1.83, z: -10 });
    expect(hidden(el)).toBe(false);
  });

  it('no offset and no measured bounds yet: hidden', () => {
    const r = rig();
    r.rows.set('npc', row({ x: 0, y: 0, z: -10 }));
    const el = new FakeEl('npc');
    r.projector.project(asRoot(new FakeRoot(el)));
    expect(hidden(el)).toBe(true);
    expect(el.style.transform).toBe('');
  });

  it('uses the world feet of a parented row, not its local ones', () => {
    const r = rig();
    r.rows.set('child', { feetPosition: { x: 0, y: 0, z: 0 }, worldFeetPosition: { x: 3, y: 0, z: -9 }, bounds: undefined });
    r.rows.set('plain', { feetPosition: { x: -1, y: 0, z: -7 }, bounds: undefined });
    r.projector.project(asRoot(new FakeRoot(new FakeEl('child', '0 1 0'), new FakeEl('plain', '0 1 0'))));
    expect(r.projected).toEqual([
      { x: 3, y: 1, z: -9 },
      { x: -1, y: 1, z: -7 },
    ]);
  });

  it('an unknown id (or an empty one) is hidden', () => {
    const r = rig();
    const a = new FakeEl('nobody', '0 2.15 0');
    const b = new FakeEl('', '0 2.15 0');
    r.projector.project(asRoot(new FakeRoot(a, b)));
    expect(hidden(a)).toBe(true);
    expect(hidden(b)).toBe(true);
    expect(r.projected).toEqual([]);
  });

  it('a malformed offset never throws and counts as no offset (the top of the bounds)', () => {
    for (const bad of ['0 2.15', '0 2.15 0 1', 'a b c', '', '   ', '0 NaN 0', 'Infinity 0 0', '0,2.15,0', '0 2.15px 0']) {
      expect(parseAnchorOffset(bad), JSON.stringify(bad)).toBeNull();
      const r = rig();
      r.rows.set('npc', row({ x: 0, y: 0, z: -10 }, 1.7));
      r.rows.set('bare', row({ x: 0, y: 0, z: -10 }));
      const withBounds = new FakeEl('npc', bad);
      const without = new FakeEl('bare', bad);
      expect(() => r.projector.project(asRoot(new FakeRoot(withBounds, without)))).not.toThrow();
      expect(r.projected, JSON.stringify(bad)).toEqual([{ x: 0, y: 1.7, z: -10 }]);
      expect(hidden(withBounds)).toBe(false);
      expect(hidden(without)).toBe(true);
    }
    expect(parseAnchorOffset('0 2.15 0')).toEqual({ x: 0, y: 2.15, z: 0 });
    expect(parseAnchorOffset('-1.5 .25 1e1')).toEqual({ x: -1.5, y: 0.25, z: 10 });
  });
});

describe('hiding (io §3.7 step 4)', () => {
  it('a point behind the camera is hidden although its mirrored projection falls inside the field', () => {
    const r = rig();
    r.rows.set('behind', row({ x: 0.5, y: 0, z: 10 }));
    r.rows.set('ahead', row({ x: 0.5, y: 0, z: -10 }));
    const behind = new FakeEl('behind', '0 1.6 0');
    const ahead = new FakeEl('ahead', '0 1.6 0');
    r.projector.project(asRoot(new FakeRoot(behind, ahead)));
    expect(hidden(behind)).toBe(true);
    expect(behind.style.transform).toBe('');
    expect(hidden(ahead)).toBe(false);
    // and with the camera turned round, the two swap
    const back = rig({ yaw: Math.PI });
    back.rows.set('behind', row({ x: 0.5, y: 0, z: 10 }));
    back.rows.set('ahead', row({ x: 0.5, y: 0, z: -10 }));
    const b2 = new FakeEl('behind', '0 1.6 0');
    const a2 = new FakeEl('ahead', '0 1.6 0');
    back.projector.project(asRoot(new FakeRoot(b2, a2)));
    expect(hidden(b2)).toBe(false);
    expect(hidden(a2)).toBe(true);
  });

  it('a point in the eye plane (no projection) is hidden', () => {
    const r = rig();
    r.rows.set('side', row({ x: 5, y: 1.6, z: 0 }));
    const el = new FakeEl('side', '0 0 0');
    expect(() => r.projector.project(asRoot(new FakeRoot(el)))).not.toThrow();
    expect(hidden(el)).toBe(true);
  });

  it('the frustum is extended by a 10 % margin on each of the four edges', () => {
    expect(ANCHOR_MARGIN).toBe(0.1);
    const W = 1280;
    const H = 720;
    const eye = { x: 0, y: 1.6, z: 0 };
    // NDC ±1.19 is 9.5 % past the edge (inside the margin), ±1.21 is 10.5 % past it (outside)
    const cases: Array<{ edge: string; nx: number; ny: number; inside: boolean }> = [];
    for (const [edge, ax, ay] of [
      ['right', 1, 0],
      ['left', -1, 0],
      ['top', 0, 1],
      ['bottom', 0, -1],
    ] as const) {
      cases.push({ edge, nx: ax * 1.19, ny: ay * 1.19, inside: true }, { edge, nx: ax * 1.21, ny: ay * 1.21, inside: false });
    }
    for (const c of cases) {
      const r = rig({ W, H, eye });
      r.rows.set('npc', row(atNdc(eye, c.nx, c.ny, W / H)));
      const el = new FakeEl('npc', '0 0 0');
      r.projector.project(asRoot(new FakeRoot(el)));
      const label = `${c.edge} ${c.inside ? 'inside' : 'outside'}`;
      expect(hidden(el), label).toBe(!c.inside);
      if (c.inside) {
        // off the strict screen (render's onScreen is false there) yet placed
        const got = at(el);
        expect(got.x, label).toBeCloseTo((c.nx * 0.5 + 0.5) * W, 1);
        expect(got.y, label).toBeCloseTo((-c.ny * 0.5 + 0.5) * H, 1);
        expect(got.x < 0 || got.x > W || got.y < 0 || got.y > H, label).toBe(true);
      } else {
        expect(el.style.transform, label).toBe('');
      }
    }
  });

  it('before the render engine exists (project → null) every anchor is hidden (X-04)', () => {
    const r = rig();
    r.rows.set('npc', row({ x: 0, y: 0, z: -10 }, 1.8));
    const noEngine = new AnchorProjector({ ...r.deps, project: () => null });
    const a = new FakeEl('npc', '0 2.15 0');
    const b = new FakeEl('npc');
    noEngine.project(asRoot(new FakeRoot(a, b)));
    expect(hidden(a)).toBe(true);
    expect(hidden(b)).toBe(true);
  });

  it('no presented camera yet, or a field without size: hidden', () => {
    const r = rig();
    r.rows.set('npc', row({ x: 0, y: 0, z: -10 }, 1.8));
    const noCamera = new AnchorProjector({ ...r.deps, camera: () => null });
    const a = new FakeEl('npc', '0 2.15 0');
    noCamera.project(asRoot(new FakeRoot(a)));
    expect(hidden(a)).toBe(true);
    const noField = new AnchorProjector({ ...r.deps, viewport: () => ({ width: 0, height: 0 }) });
    const b = new FakeEl('npc', '0 2.15 0');
    noField.project(asRoot(new FakeRoot(b)));
    expect(hidden(b)).toBe(true);
  });

  it('shows an anchor again once it is back in view', () => {
    const r = rig();
    const feet = { x: 0, y: 0, z: 10 };
    r.rows.set('npc', { feetPosition: feet, worldFeetPosition: feet, bounds: undefined });
    const el = new FakeEl('npc', '0 1.6 0');
    const root = new FakeRoot(el);
    r.projector.project(asRoot(root));
    expect(hidden(el)).toBe(true);
    feet.z = -10;
    r.projector.project(asRoot(root));
    expect(el.style.visibility).toBe('');
    expect(el.style.transform).toBe('translate3d(640px, 360px, 0)');
  });
});

describe('--anchor-depth (metres from the presented eye)', () => {
  it('eye (0,1.6,0) → point (0,1.6,−10) is 10', () => {
    const r = rig();
    r.rows.set('npc', row({ x: 0, y: 0, z: -10 }));
    const el = new FakeEl('npc', '0 1.6 0');
    r.projector.project(asRoot(new FakeRoot(el)));
    expect(el.style.getPropertyValue('--anchor-depth')).toBe('10');
  });

  it('is the straight-line distance, not the view depth: a 3-4-5 triangle is 5', () => {
    const r = rig({ eye: { x: 0, y: 0, z: 0 } });
    r.rows.set('npc', row({ x: 3, y: 0, z: -4 }));
    const el = new FakeEl('npc', '0 0 0');
    r.projector.project(asRoot(new FakeRoot(el)));
    expect(hidden(el)).toBe(false);
    expect(el.style.getPropertyValue('--anchor-depth')).toBe('5');
  });

  it('is a unitless number kept to 0.01 m', () => {
    const r = rig({ eye: { x: 0, y: 0, z: 0 } });
    r.rows.set('npc', row({ x: 0, y: 0.2, z: -1.4 })); // √(0.04 + 1.96) = 1.41421…
    r.rows.set('far', row({ x: 0, y: 0, z: -45.678 }));
    const a = new FakeEl('npc', '0 0 0');
    const b = new FakeEl('far', '0 0 0');
    r.projector.project(asRoot(new FakeRoot(a, b)));
    expect(a.style.getPropertyValue('--anchor-depth')).toBe('1.41');
    expect(b.style.getPropertyValue('--anchor-depth')).toBe('45.68');
  });
});

describe('what is written (io §3.7 step 5)', () => {
  it('transform, position:fixed, left/top 0 and --anchor-depth; the game-authored opacity is never touched', () => {
    const r = rig();
    r.rows.set('npc', row({ x: 0, y: 0, z: -10 }));
    const el = new FakeEl('npc', '0 1.6 0');
    const root = new FakeRoot(el);
    r.projector.project(asRoot(root));
    expect(el.style.transform).toBe('translate3d(640px, 360px, 0)');
    expect(el.style.position).toBe('fixed');
    expect(el.style.left).toBe('0px');
    expect(el.style.top).toBe('0px');
    expect(el.style.visibility).toBe('');
    expect(el.style.opacity).toBe('clamp(.35, calc(1.25 - var(--anchor-depth, 0) / 45), 1)');
    const allowed = new Set(['transform', 'visibility', 'position', 'left', 'top', '--anchor-depth']);
    for (const k of el.style.sets) expect(allowed.has(k), k).toBe(true);
    expect(el.style.sets).not.toContain('opacity');
    expect(el.style.sets).not.toContain('cssText');
    expect(root.queries).toEqual(['[data-world-anchor]']);
  });

  it('a hidden anchor gets visibility:hidden and nothing else', () => {
    const r = rig();
    const el = new FakeEl('nobody', '0 2.15 0');
    r.projector.project(asRoot(new FakeRoot(el)));
    expect(el.style.sets).toEqual(['visibility']);
  });
});

describe('across frames and morphs', () => {
  it('follows a moving row', () => {
    const r = rig();
    const feet = { x: 0, y: 0, z: -10 };
    r.rows.set('npc', { feetPosition: feet, worldFeetPosition: feet, bounds: undefined });
    const el = new FakeEl('npc', '0 1.6 0');
    const root = new FakeRoot(el);
    r.projector.project(asRoot(root));
    const first = at(el);
    feet.x = 2;
    feet.z = -20;
    r.projector.project(asRoot(root));
    const second = at(el);
    expect(second.x).toBeGreaterThan(first.x);
    expect(second.x).toBeCloseTo(((2 / (20 * T * (16 / 9))) * 0.5 + 0.5) * 1280, 1);
    expect(Number(el.style.getPropertyValue('--anchor-depth'))).toBeCloseTo(Math.hypot(2, 20), 2);
  });

  it('rewrites everything in the frame after a morph reset the style attribute', () => {
    const r = rig();
    r.rows.set('npc', row({ x: 0, y: 0, z: -10 }));
    const el = new FakeEl('npc', '0 1.6 0');
    const root = new FakeRoot(el);
    r.projector.project(asRoot(root));
    el.resetStyle(); // idiomorph set the style attribute back to the render string's
    expect(el.style.transform).toBe('');
    r.projector.project(asRoot(root));
    expect(el.style.transform).toBe('translate3d(640px, 360px, 0)');
    expect(el.style.position).toBe('fixed');
    expect(el.style.left).toBe('0px');
    expect(el.style.top).toBe('0px');
    expect(el.style.getPropertyValue('--anchor-depth')).toBe('10');
  });

  it('a morph that reset the style of a hidden anchor: hidden again in the same frame', () => {
    const r = rig();
    const el = new FakeEl('nobody', '0 1.6 0');
    const root = new FakeRoot(el);
    r.projector.project(asRoot(root));
    el.resetStyle();
    r.projector.project(asRoot(root));
    expect(hidden(el)).toBe(true);
  });

  it('a node re-created with the same id is placed; nodes added and removed between frames are followed', () => {
    const r = rig();
    r.rows.set('a', row({ x: 0, y: 0, z: -10 }));
    r.rows.set('b', row({ x: 0, y: 0, z: -20 }));
    const a1 = new FakeEl('a', '0 1.6 0');
    const root = new FakeRoot(a1);
    r.projector.project(asRoot(root));
    // the whole screen was morphed: a new node for the same row, and a second anchor
    const a2 = new FakeEl('a', '0 1.6 0');
    const b = new FakeEl('b', '0 1.6 0');
    root.els = [a2, b];
    const stale = [...a1.style.sets];
    r.projector.project(asRoot(root));
    expect(a2.style.transform).toBe('translate3d(640px, 360px, 0)');
    expect(b.style.getPropertyValue('--anchor-depth')).toBe('20');
    expect(a1.style.sets).toEqual(stale); // the detached node is not written to
    root.els = [b];
    r.projector.project(asRoot(root));
    root.els = [];
    expect(() => r.projector.project(asRoot(root))).not.toThrow();
  });

  it('an element whose anchor id changed follows the new row', () => {
    const r = rig();
    r.rows.set('a', row({ x: 0, y: 0, z: -10 }));
    r.rows.set('b', row({ x: 0, y: 0, z: -30 }));
    const el = new FakeEl('a', '0 1.6 0');
    const root = new FakeRoot(el);
    r.projector.project(asRoot(root));
    el.attrs['data-world-anchor'] = 'b';
    el.attrs['data-anchor-offset'] = '0 1.6 0';
    r.projector.project(asRoot(root));
    expect(el.style.getPropertyValue('--anchor-depth')).toBe('30');
  });
});

describe('robustness (a throw would drop every anchor of the frame)', () => {
  it('a row accessor that throws hides that anchor only', () => {
    const r = rig();
    r.rows.set('good', row({ x: 0, y: 0, z: -10 }));
    r.rows.set('bad', {
      get feetPosition(): Vec3 {
        throw new Error('row is gone');
      },
      get worldFeetPosition(): Vec3 {
        throw new Error('row is gone');
      },
      bounds: undefined,
    });
    const bad = new FakeEl('bad', '0 1.6 0');
    const good = new FakeEl('good', '0 1.6 0');
    expect(() => r.projector.project(asRoot(new FakeRoot(bad, good)))).not.toThrow();
    expect(hidden(bad)).toBe(true);
    expect(good.style.transform).toBe('translate3d(640px, 360px, 0)');
  });

  it('a registry, camera, viewport or projector that throws hides instead of throwing', () => {
    const r = rig();
    r.rows.set('npc', row({ x: 0, y: 0, z: -10 }));
    const boom = (): never => {
      throw new Error('boom');
    };
    for (const broken of [{ getObject: boom }, { camera: boom }, { viewport: boom }, { project: boom }] as Array<Partial<AnchorDeps>>) {
      const p = new AnchorProjector({ ...r.deps, ...broken });
      const el = new FakeEl('npc', '0 1.6 0');
      expect(() => p.project(asRoot(new FakeRoot(el)))).not.toThrow();
      expect(hidden(el)).toBe(true);
    }
  });

  it('non-finite row data is hidden, not written as NaN', () => {
    const r = rig();
    r.rows.set('npc', row({ x: Number.NaN, y: 0, z: -10 }));
    const el = new FakeEl('npc', '0 1.6 0');
    r.projector.project(asRoot(new FakeRoot(el)));
    expect(hidden(el)).toBe(true);
    expect(el.style.transform).toBe('');
  });
});
