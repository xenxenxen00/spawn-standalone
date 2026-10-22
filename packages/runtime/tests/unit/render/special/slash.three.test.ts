// K8 `slash` (engine api-reference.md:665): the payload (every spelling of the docs' unions, their defaults), the ribbon
// geometry per shape, the pool, the placement from rotation / velocity / scaleVelocity, and the end.
import { Group } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  SLASH_GLOW_GAIN, SLASH_POOL, SLASH_SHAPES, SLASH_TIMING_S, SlashRenderer, slashActOf, slashGeometry, slashHead, type SlashShape,
} from '../../../../src/render/special/slash.ts';

const at = { position: { x: 1, y: 2, z: 3 } };

describe('slash payload', () => {
  it('refuses a payload without a position', () => {
    expect(slashActOf({})).toBeNull();
    expect(slashActOf({ position: { x: 1, y: 2 } })).toBeNull();
    expect(slashActOf(7)).toBeNull();
  });

  it('defaults every optional field', () => {
    const a = slashActOf(at)!;
    expect(a).toMatchObject({ shape: 'crescent', noise: 'none', glow: 'medium', timing: 'standard', duration: 0.3, size: 1.5, outwardGlow: 0, scaleVelocity: 0 });
    expect(a.rotation).toEqual({ yaw: 0, pitch: 0, roll: 0 });
    expect(a.velocity).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('accepts every documented enum value and falls back on a stranger', () => {
    for (const shape of Object.keys(SLASH_SHAPES)) expect(slashActOf({ ...at, shape })!.shape).toBe(shape);
    for (const timing of Object.keys(SLASH_TIMING_S)) expect(slashActOf({ ...at, timing })!.timing).toBe(timing);
    for (const glow of Object.keys(SLASH_GLOW_GAIN)) expect(slashActOf({ ...at, glow })!.glow).toBe(glow);
    for (const noise of ['none', 'forward', 'backward', 'stableDissolve']) expect(slashActOf({ ...at, noise })!.noise).toBe(noise);
    const odd = slashActOf({ ...at, shape: 'zigzag', timing: 'instant', glow: 'x', noise: 'y', toString: 1 })!;
    expect(odd).toMatchObject({ shape: 'crescent', timing: 'standard', glow: 'medium', noise: 'none' });
    expect(slashActOf({ ...at, shape: 'toString' })!.shape).toBe('crescent');
  });

  it('reads colours with their alphas', () => {
    const a = slashActOf({ ...at, edgeColor: '#ff0000', edgeAlpha: 0.5, bodyColor1: '#00ff00', bodyColor1Alpha: 0.2, bodyColor3: '#0000ff' })!;
    expect(a.edgeColor.r).toBeCloseTo(1, 6);
    expect(a.edgeAlpha).toBe(0.5);
    expect(a.bodyColors[0].g).toBeCloseTo(1, 6);
    expect(a.bodyAlphas[0]).toBe(0.2);
    expect(a.bodyColors[2].b).toBeCloseTo(1, 6);
  });

  it('timing orders quick < standard < slow < verySlow, and glow grows', () => {
    expect(SLASH_TIMING_S.quick).toBeLessThan(SLASH_TIMING_S.standard);
    expect(SLASH_TIMING_S.standard).toBeLessThan(SLASH_TIMING_S.slow);
    expect(SLASH_TIMING_S.slow).toBeLessThan(SLASH_TIMING_S.verySlow);
    const g = ['none', 'light', 'medium', 'intense', 'max'].map((k) => SLASH_GLOW_GAIN[k as keyof typeof SLASH_GLOW_GAIN]);
    expect([...g].sort((x, y) => x - y)).toEqual(g);
  });

  it('the cut runs along the arc over the first part of the life', () => {
    expect(slashHead(0, 1)).toBe(0);
    expect(slashHead(0.3, 1)).toBeCloseTo(0.5, 12);
    expect(slashHead(0.9, 1)).toBe(1);
  });
});

describe('slash geometry', () => {
  const widthAt = (shape: SlashShape, i: number): number => {
    const g = slashGeometry(shape);
    const p = g.getAttribute('position');
    return Math.hypot(p.getX(i * 2) - p.getX(i * 2 + 1), p.getY(i * 2) - p.getY(i * 2 + 1));
  };
  const last = (shape: SlashShape): number => slashGeometry(shape).getAttribute('position').count / 2 - 1;

  it('an arc strip with uv along and across', () => {
    const g = slashGeometry('crescent');
    const uv = g.getAttribute('uv');
    expect(uv.getX(0)).toBe(0);
    expect(uv.getY(0)).toBe(1);
    expect(uv.getY(1)).toBe(0);
    expect(uv.getX(uv.count - 1)).toBe(1);
    expect(g.index!.count).toBe((uv.count / 2 - 1) * 6);
  });

  it('uniform keeps its width, widening grows, a crescent closes at both tips', () => {
    const n = last('tightUniform');
    expect(widthAt('tightUniform', 0)).toBeCloseTo(widthAt('tightUniform', n / 2), 6);
    expect(widthAt('tightWidening', n)).toBeGreaterThan(widthAt('tightWidening', Math.floor(n / 4)));
    expect(widthAt('crescent', 0)).toBeCloseTo(0, 6);
    expect(widthAt('crescent', n)).toBeCloseTo(0, 6);
    expect(widthAt('crescent', n / 2)).toBeCloseTo(SLASH_SHAPES.crescent.width, 6);
    expect(widthAt('broadUniform', 3)).toBeGreaterThan(widthAt('tightUniform', 3));
  });

  it('a longer crescent sweeps further; the circle closes', () => {
    const span = (shape: SlashShape): number => {
      const p = slashGeometry(shape).getAttribute('position');
      const a0 = Math.atan2(p.getY(0), p.getX(0));
      const a1 = Math.atan2(p.getY((p.count / 2 - 1) * 2), p.getX((p.count / 2 - 1) * 2));
      return Math.abs(a1 - a0);
    };
    expect(span('longCrescent')).toBeGreaterThan(span('crescent'));
    const c = slashGeometry('circle').getAttribute('position');
    const k = c.count / 2 - 1;
    expect(c.getX(k * 2)).toBeCloseTo(c.getX(0), 6);
    expect(c.getY(k * 2)).toBeCloseTo(c.getY(0), 6);
  });
});

describe('SlashRenderer', () => {
  it('places a ribbon, moves it by velocity, grows it by scaleVelocity, and removes it at the end of its timing', () => {
    const world = new Group();
    const s = new SlashRenderer({ world });
    expect(s.emit({ nothing: true })).toBe(false);
    expect(s.emit({ ...at, size: 2, timing: 'slow', velocity: { x: 2 }, scaleVelocity: 1, rotation: { yaw: 90 } })).toBe(true);
    const m = s.meshes.find((x) => x.visible)!;
    expect(m.position.toArray()).toEqual([1, 2, 3]);
    expect(m.scale.x).toBe(2);
    s.update(0.25);
    expect(m.position.x).toBeCloseTo(1.5, 12);
    expect(m.scale.x).toBeCloseTo(2.25, 12);
    // a quarter turn about Y takes the strip's +Z normal to +X
    const n = { x: 0, y: 0, z: 1 };
    const q = m.quaternion;
    const nx = 2 * (q.x * q.z + q.w * q.y) * n.z;
    expect(nx).toBeCloseTo(1, 9);
    expect(s.stats().active).toBe(1);
    s.update(0.3);
    expect(s.stats().active).toBe(0);
    expect(m.visible).toBe(false);
  });

  it('takes over the oldest ribbon when the pool is full, and swaps geometry per shape', () => {
    const s = new SlashRenderer({ world: new Group() });
    for (let i = 0; i < SLASH_POOL; i++) {
      s.emit({ ...at, shape: i % 2 === 0 ? 'circle' : 'tightUniform' });
      s.update(0.01);
    }
    expect(s.stats()).toMatchObject({ active: SLASH_POOL, replaced: 0 });
    s.emit({ ...at, shape: 'longCrescent' });
    expect(s.stats().replaced).toBe(1);
    expect(new Set(s.meshes.map((m) => m.geometry)).size).toBeGreaterThanOrEqual(3);
  });

  it('draws one program for every shape and setting: the material graph does not change with the payload', () => {
    const s = new SlashRenderer({ world: new Group() });
    const keys = new Set(s.meshes.map((m) => (m.material as { customProgramCacheKey(): string }).customProgramCacheKey()));
    s.emit({ ...at, shape: 'circle', noise: 'forward', glow: 'max' });
    const after = new Set(s.meshes.map((m) => (m.material as { customProgramCacheKey(): string }).customProgramCacheKey()));
    expect(after).toEqual(keys);
    expect(s.warmObjects()).toHaveLength(1);
    s.dispose();
    expect(s.warmObjects()).toEqual([]);
  });
});
