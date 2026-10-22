// physics/spec.ts and physics/liquid.ts (motion §4.1-§4.2, §5.9, D-MPN-08/09; WP PH3): pure, no Rapier.
import { describe, expect, it } from 'vitest';
import type { AssetFactsPort } from '../../../src/compat/core/ports.ts';
import { DEG, KCC_DEFAULTS } from '../../../src/compat/physics/defaults.ts';
import { SWIM_DEPTH_SHARE, floatLine, liquidState, liquidVolumes, surfaceAt, swimVelocity } from '../../../src/compat/physics/liquid.ts';
import { bodyKindOf, normalizeBody, packedGroups, worldCapsule } from '../../../src/compat/physics/spec.ts';
import { fakeRow } from './port-fixtures.ts';

const row = fakeRow('r');
const facts: AssetFactsPort = {
  get: (ref) => (ref === 'zed.glb' ? { bounds: { center: [0, 1.1, 0], min: [-0.4, 0, -0.3], max: [0.4, 2.2, 0.3], size: [0.8, 2.2, 0.6] } } : undefined),
  placeBake: () => Promise.reject(new Error('unused')),
};

describe('normalizeBody', () => {
  it('no body: omitted, "none", false, null and unknown kinds; the numeric defaults are still filled in', () => {
    for (const spec of [undefined, null, false, 'none', 'ghost', { body: 'none' }, { body: false }, {}, 7]) {
      const b = normalizeBody(spec, row, null);
      expect(b.kind, JSON.stringify(spec)).toBeNull();
      expect(bodyKindOf(spec)).toBeNull();
      expect(b.capsule).toBeUndefined();
      expect(b.kcc).toBeUndefined();
    }
    expect(normalizeBody('none', row, null)).toEqual({
      kind: null, sensor: false, collider: { kind: 'auto' }, mass: 1, friction: 0.5, restitution: 0, linearDamping: 0, angularDamping: 0,
      gravityScale: 1, groups: { membership: 0xffff, filter: 0xffff },
    });
  });

  it('the string and the object form name the same body', () => {
    for (const kind of ['static', 'kinematic', 'dynamic', 'character'] as const) {
      expect(normalizeBody(kind, row, null)).toEqual(normalizeBody({ body: kind }, row, null));
      expect(bodyKindOf({ body: kind })).toBe(kind);
    }
  });

  it('the live player: capsule 1.9 × 0.35, autostep 0.4 / 0.2, climb 52°, slide 62°, snap 0.3; degrees become radians once', () => {
    const b = normalizeBody({
      body: 'character', capsule: { height: 1.9, radius: 0.35 }, autostep: { maxHeight: 0.4, minWidth: 0.2 }, maxSlopeClimbAngle: 52,
      minSlopeSlideAngle: 62, snapToGroundDistance: 0.3,
    }, row, null);
    expect(b.kind).toBe('character');
    expect(b.capsule).toEqual({ height: 1.9, radius: 0.35 });
    expect(b.kcc).toEqual({
      offset: 0.01, autostep: { maxHeight: 0.4, minWidth: 0.2, includeDynamic: false }, maxSlopeClimb: 52 * DEG, minSlopeSlide: 62 * DEG, slide: true,
      snapToGround: 0.3, normalNudge: 1e-4,
    });
    // characters are members of group 0x0004 only (D-MPN-09)
    expect(b.groups).toEqual({ membership: 0x0004, filter: 0xffff });
    expect(packedGroups(b)).toBe(0x0004ffff);
  });

  it('a character that sets nothing gets Spawn\'s working values, not Rapier\'s (D-MPN-08); the capsule height falls back to the model bounds', () => {
    const b = normalizeBody('character', row, null);
    expect(b.kcc).toEqual({ ...KCC_DEFAULTS, autostep: { ...KCC_DEFAULTS.autostep! } });
    expect(b.capsule).toEqual({ height: 1.9, radius: 0.35 });
    const zed = fakeRow('zed', { model: 'zed.glb' });
    expect(normalizeBody('character', zed, facts).capsule).toEqual({ height: 2.2, radius: 0.35 });
    expect(normalizeBody({ body: 'character', capsule: { radius: 0.5 } }, zed, facts).capsule).toEqual({ height: 2.2, radius: 0.5 });
    expect(normalizeBody({ body: 'character', capsule: { height: 1.2 } }, zed, facts).capsule).toEqual({ height: 1.2, radius: 0.35 });
    expect(normalizeBody('character', fakeRow('x', { model: 'missing.glb' }), facts).capsule!.height).toBe(1.9);
  });

  it('controller switches: autostep false, snap false, slide off, offset and nudge', () => {
    const b = normalizeBody({ body: 'character', autostep: false, snapToGroundDistance: false, slideEnabled: false, offset: 0.02, normalNudgeFactor: 1e-3, characterMass: 80, applyImpulsesToDynamicBodies: true }, row, null);
    expect(b.kcc).toMatchObject({ autostep: null, snapToGround: null, slide: false, offset: 0.02, normalNudge: 1e-3 });
    expect(normalizeBody({ body: 'character', autostep: { maxHeight: 0.6, minWidth: 0.1, includeDynamic: true } }, row, null).kcc!.autostep).toEqual({ maxHeight: 0.6, minWidth: 0.1, includeDynamic: true });
  });

  it('the live gib: dynamic, sphere, mass, damping, groups {0x0008, 0xfffb} that never meet a character', () => {
    const b = normalizeBody({
      body: 'dynamic', collider: 'sphere', mass: 0.5, restitution: 0.22, friction: 0.9, linearDamping: 0.08, angularDamping: 0.55,
      collisionGroups: { membership: 0x0008, filter: 0xfffb }, lockedAxes: ['rx'],
    }, row, null);
    expect(b).toEqual({
      kind: 'dynamic', sensor: false, collider: { kind: 'sphere' }, mass: 0.5, friction: 0.9, restitution: 0.22, linearDamping: 0.08, angularDamping: 0.55,
      gravityScale: 1, groups: { membership: 0x0008, filter: 0xfffb }, lockedAxes: ['rx'],
    });
    expect(packedGroups(b)).toBe(0x0008fffb);
  });

  it('trigger, collider forms and bad numbers', () => {
    expect(normalizeBody({ body: 'static', trigger: true }, row, null).sensor).toBe(true);
    expect(normalizeBody({ body: 'static', trigger: 1 }, row, null).sensor).toBe(false);
    expect(normalizeBody({ body: 'static', collider: { kind: 'box', size: [1, 2, 3] } }, row, null).collider).toEqual({ kind: 'box', dims: [1, 2, 3] });
    expect(normalizeBody({ body: 'static', collider: { kind: 'sphere', radius: 0.4 } }, row, null).collider).toEqual({ kind: 'sphere', dims: [0.4] });
    expect(normalizeBody({ body: 'static', collider: 'trimesh-of-something' }, row, null).collider).toEqual({ kind: 'auto' });
    const b = normalizeBody({ body: 'dynamic', mass: -1, friction: Number.NaN, restitution: 'x', gravityScale: 0 }, row, null);
    expect([b.mass, b.friction, b.restitution, b.gravityScale]).toEqual([1, 0.5, 0, 0]);
  });
});

describe('worldCapsule', () => {
  it('height × scale.y, radius × max(scale.x, scale.z); the half segment is h/2 - r, clamped at a ball', () => {
    expect(worldCapsule({ height: 1.9, radius: 0.35 }, { x: 1, y: 1, z: 1 })).toEqual({ height: 1.9, radius: 0.35, halfSegment: 0.6 });
    const big = worldCapsule({ height: 1.8, radius: 0.34 }, { x: 1.5, y: 2, z: 1.2 });
    expect(big.height).toBeCloseTo(3.6, 12);
    expect(big.radius).toBeCloseTo(0.51, 12);
    expect(big.halfSegment).toBeCloseTo(1.29, 12);
    // a boss row of 0.9 m with radius 0.6: the radius cannot exceed half the height
    expect(worldCapsule({ height: 0.9, radius: 0.6 }, { x: 1, y: 1, z: 1 })).toEqual({ height: 0.9, radius: 0.45, halfSegment: 0 });
  });
});

describe('liquid', () => {
  const MIRE = { kind: 'heightmap', marks: { sea: { kind: 'sea', level: 0 }, 'mi-clear-trail': { kind: 'clear-scatter', center: { x: 0, z: 0 } } } };

  it('the sea marks of a place config; a place without one has no liquid', () => {
    expect(liquidVolumes(MIRE)).toEqual([{ id: 'sea', kind: 'sea', level: 0 }]);
    expect(liquidVolumes({ kind: 'off' })).toEqual([]);
    expect(liquidVolumes(undefined)).toEqual([]);
    expect(liquidVolumes({ marks: { pond: { kind: 'sea', level: 2.5 }, low: { kind: 'sea' } } })).toEqual([{ id: 'pond', kind: 'sea', level: 2.5 }, { id: 'low', kind: 'sea', level: 0 }]);
    expect(surfaceAt(liquidVolumes(MIRE))).toBe(0);
    expect(surfaceAt([])).toBeNull();
    expect(surfaceAt([{ id: 'a', kind: 'sea', level: -1 }, { id: 'b', kind: 'sea', level: 3 }])).toBe(3);
  });

  it('a character floats with 0.72 of its height under water: the move that would end deeper ends on the float line', () => {
    expect(SWIM_DEPTH_SHARE).toBe(0.72);
    const line = floatLine(0, 1.9);
    expect(line).toBeCloseTo(-1.368, 12);
    const dt = 1 / 30;
    // above the line: untouched, also while wading
    expect(swimVelocity(1, -5, dt, 0, 1.9)).toBe(-5);
    expect(swimVelocity(-1, -3, dt, 0, 1.9)).toBe(-3);
    // the step that would cross it lands exactly on it
    const vy = swimVelocity(-1.3, -6, dt, 0, 1.9);
    expect(-1.3 + vy * dt).toBeCloseTo(line, 12);
    // on the line: the downward part is removed, an upward one is kept
    expect(swimVelocity(line, -8, dt, 0, 1.9)).toBeCloseTo(0, 9);
    expect(swimVelocity(line, 4, dt, 0, 1.9)).toBe(4);
    // deeper (a teleport): up to the line in one tick
    expect(-4 + swimVelocity(-4, -1, dt, 0, 1.9) * dt).toBeCloseTo(line, 12);
  });

  it('the state a behaviour reads (`ctx.self.liquid`)', () => {
    expect(liquidState(2, 1.9, null)).toEqual({ in: false, level: null, swimming: false });
    expect(liquidState(0.5, 1.9, 0)).toEqual({ in: false, level: 0, swimming: false });
    expect(liquidState(-0.5, 1.9, 0)).toEqual({ in: true, level: 0, swimming: false });
    expect(liquidState(-1.368, 1.9, 0)).toEqual({ in: true, level: 0, swimming: true });
    expect(liquidState(-1.3675, 1.9, 0).swimming).toBe(true);
    expect(liquidState(-1.36, 1.9, 0).swimming).toBe(false);
  });
});
