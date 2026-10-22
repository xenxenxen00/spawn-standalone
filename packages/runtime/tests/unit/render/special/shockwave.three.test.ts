// Synthetic ring payloads exercise growth, fading, pooling and distortion-tier routing.
import { AdditiveBlending, Group, Mesh, MeshBasicNodeMaterial, Scene } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { ringAt, SHOCKWAVE_LOOK, SHOCKWAVE_POOL, shockwaveActOf, ShockwaveRenderer } from '../../../../src/render/special/shockwave.ts';

const PULSE = { position: { x: -2, y: 0.4, z: 5 }, speed: 8, thickness: 0.8, intensity: 0.5 };

describe('the act', () => {
  it('reads a synthetic payload and refuses one without a position', () => {
    expect(shockwaveActOf(PULSE)).toEqual(PULSE);
    expect(shockwaveActOf({ speed: 3 })).toBeNull();
    expect(shockwaveActOf({ position: { x: 0, y: 0 } })).toBeNull();
    expect(shockwaveActOf({ position: { x: 0, y: 0, z: 0 } })).toMatchObject({ speed: 10, thickness: 1, intensity: 1 });
  });

  it('grows at its speed and fades to nothing at the end of its life', () => {
    const act = shockwaveActOf(PULSE)!;
    expect(ringAt(act, 0)).toEqual({ radius: 0, outer: 0.4, gain: 0.5 });
    const half = ringAt(act, 0.25);
    expect(half.radius).toBeCloseTo(2);
    expect(half.outer).toBeCloseTo(2.4);
    expect(half.gain).toBeGreaterThan(0);
    expect(half.gain).toBeLessThan(0.5);
    expect(ringAt(act, SHOCKWAVE_LOOK.lifetimeS).gain).toBe(0);
  });
});

describe('ShockwaveRenderer', () => {
  it('a pooled additive ring at the position, scaled to its outer radius, gone after its lifetime', () => {
    const world = new Group();
    const sw = new ShockwaveRenderer({ world });
    expect(world.children).toHaveLength(SHOCKWAVE_POOL);
    expect(world.children.every((m) => !m.visible)).toBe(true);
    expect(sw.emit(PULSE)).toBe(true);
    const ring = world.children.find((m) => m.visible) as Mesh;
    const material = ring.material as MeshBasicNodeMaterial;
    expect([material.blending, material.depthWrite, material.transparent]).toEqual([AdditiveBlending, false, true]);
    expect(ring.position.x).toBe(-2);
    expect(ring.position.z).toBe(5);
    expect(ring.scale.x).toBeCloseTo(0.4);
    sw.update(0.25);
    expect(ring.scale.x).toBeCloseTo(2.4);
    // a paused or hit-stopped frame (dt 0) holds it
    sw.update(0);
    expect(ring.scale.x).toBeCloseTo(2.4);
    expect(sw.stats()).toMatchObject({ active: 1, emitted: 1 });
    sw.update(SHOCKWAVE_LOOK.lifetimeS);
    expect(ring.visible).toBe(false);
    expect(sw.stats().active).toBe(0);
    sw.dispose();
    expect(world.children).toHaveLength(0);
  });

  it('a full pool takes over its oldest ring', () => {
    const sw = new ShockwaveRenderer({ world: new Group() });
    for (let i = 0; i < SHOCKWAVE_POOL + 1; i++) {
      sw.emit(PULSE);
      sw.update(0.01);
    }
    expect(sw.stats()).toMatchObject({ active: SHOCKWAVE_POOL, emitted: SHOCKWAVE_POOL + 1, replaced: 1 });
    expect(sw.emit({})).toBe(false);
    sw.dispose();
  });

  it('the offset ring goes to the distort scene only while the tier draws that pass', () => {
    const distort = new Scene();
    let on = false;
    const sw = new ShockwaveRenderer({ world: new Group(), distortScene: () => distort, distortEnabled: () => on });
    sw.emit(PULSE);
    expect(distort.children).toHaveLength(0);
    on = true;
    sw.update(0.1);
    expect(distort.children).toHaveLength(1);
    const ring = distort.children[0] as Mesh;
    expect(ring.visible).toBe(true);
    expect((ring.material as MeshBasicNodeMaterial).fog).toBe(false);
    sw.update(SHOCKWAVE_LOOK.lifetimeS);
    expect(distort.children).toHaveLength(0);
    sw.dispose();
  });

  it('warms the scene ring by compiling one pooled ring: every pooled ring has the same material shape', () => {
    const sw = new ShockwaveRenderer({ world: new Group() });
    expect(sw.warmObjects().map((o) => o.name)).toEqual(['ss:shockwave:0']);
    sw.dispose();
    expect(sw.warmObjects()).toEqual([]);
  });

  it('arms an offset ring at zero gain in the distort scene for the closing render, on a tier with the pass only', () => {
    const distort = new Scene();
    let on = false;
    const sw = new ShockwaveRenderer({ world: new Group(), distortScene: () => distort, distortEnabled: () => on });
    const off = sw.armDistortWarm();
    expect(off.armed).toBe(false);
    expect(distort.children).toHaveLength(0);
    on = true;
    const arm = sw.armDistortWarm();
    expect(arm.armed).toBe(true);
    expect(distort.children.map((o) => [o.name, o.visible])).toEqual([['ss:shockwave:distort:0', true]]);
    arm.done();
    expect(distort.children).toHaveLength(0);
    // nothing is armed into a running ring
    sw.dispose();
    expect(sw.armDistortWarm().armed).toBe(false);
  });
});
