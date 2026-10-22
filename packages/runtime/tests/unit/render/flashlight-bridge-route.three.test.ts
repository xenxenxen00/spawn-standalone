// WP R4: the render bridge drives the owner's beam row through `routeLights` onto the permanent SpotLight.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/compat/core/types.ts';
import { cssToLinear } from '../../../src/render/color/color.ts';
import { createShadowCaster, routeLights } from '../../../src/render/lighting/shadow-caster.ts';
import { createLightTable } from '../../../src/render/lighting/light-table.ts';
import { createSceneRoot } from '../../../src/render/scene/scene-root.ts';
import { rig, TestRow } from './bridge-fakes.ts';

const BEAM = {
  kind: 'spot',
  color: 'oklch(0.97 0.05 85)',
  intensity: 220,
  distance: 25,
  angle: 0.4,
  penumbra: 0.65,
  decay: 2,
  aim: 'forward',
  shadow: true,
};

const near = (a: Vec3, b: Vec3): void => {
  expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), `(${a.x}, ${a.y}, ${a.z}) vs (${b.x}, ${b.y}, ${b.z})`).toBeLessThan(1e-9);
};
const at = (o: { position: Vec3 }): Vec3 => ({ x: o.position.x, y: o.position.y, z: o.position.z });

describe("shadowCaster bridge routing", () => {
  it("updates the permanent light with the player's beam pose and turns it off when the row is removed", () => {
    const root = createSceneRoot();
    const spot = root.lights.shadowCaster;
    const shadowCaster = createShadowCaster({ light: spot });
    const table = createLightTable();
    const r = rig({ lights: routeLights(table, shadowCaster) });
    const body = new TestRow('me', { pos: [0, 0, 0], yaw: 0, props: { physics: { body: 'character' } } });
    const beam = new TestRow('me-flash', { parent: 'me', pos: [0.05, 1.6, -0.9], props: { light: BEAM } });

    r.spawn(body, beam);
    r.frame(1);
    expect(table.size).toBe(0);
    expect(shadowCaster.on).toBe(true);
    expect(spot.intensity).toBe(220);
    expect(spot.distance).toBe(25);
    expect(spot.decay).toBe(2);
    expect(spot.angle).toBeCloseTo(0.4, 12);
    expect(spot.penumbra).toBeCloseTo(0.65, 12);
    const color = cssToLinear(BEAM.color);
    if (color === null) throw new Error('the shadowCaster beam color must be valid');
    expect(spot.color.r).toBeCloseTo(color[0]!, 12);
    expect(spot.color.g).toBeCloseTo(color[1]!, 12);
    expect(spot.color.b).toBeCloseTo(color[2]!, 12);
    near(at(spot), { x: 0.05, y: 1.6, z: -0.9 });
    near(at(spot.target), { x: 0.05, y: 1.6, z: -1.9 });

    body.tick({ yaw: 90 });
    r.feed.change(body, 'rotation');
    r.frame(1);
    expect(table.size).toBe(0);
    expect(spot.intensity).toBe(220);
    near(at(spot), { x: -0.9, y: 1.6, z: -0.05 });
    near(at(spot.target), { x: -1.9, y: 1.6, z: -0.05 });

    r.feed.remove('me-flash');
    r.frame(1);
    expect(shadowCaster.on).toBe(false);
    expect(spot.intensity).toBe(0);
    expect(table.size).toBe(0);
  });
});
