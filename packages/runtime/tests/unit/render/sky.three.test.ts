// WP R4: the sky (render §9.2). A gradient `backgroundNode` for 20 of the 21 places, the night variant for coldwell-station
// (near-black gradient, a hash-placed star field of about 2,000 points, a moon disc emitting 2.5). Node + three's node graph;
// no renderer: what is drawn is the browser spec's part (tests/e2e/render-r4.spec.ts). Here: the selection of the variant,
// the uniforms a place switch writes, the CPU mirror of the shader's formulas, and the star field's count and determinism.
import { Scene } from 'three/webgpu';
import { afterEach, describe, expect, it } from 'vitest';
import { calibration, resetCalibration } from '../../../src/render/calibration.ts';
import {
  MOON_DIRECTION,
  MOON_RADIUS,
  NIGHT_SKY,
  STAR_CELLS,
  STAR_RADIUS,
  createSky,
  moonDisc,
  nightSkyAt,
  skyGradientAt,
  skyMean,
  starAt,
  starField,
  type SkyState,
} from '../../../src/render/atmosphere/sky.ts';
import { skySampler } from '../../../src/render/surface/env-term.ts';

const HORIZON: [number, number, number] = [0.2, 0.1, 0.05];
const ZENITH: [number, number, number] = [0.01, 0.02, 0.08];
const GRADIENT: SkyState = { kind: 'gradient', horizon: HORIZON, zenith: ZENITH };
const NIGHT_PALETTE = { horizon: [0.006, 0.009, 0.016], zenith: [0.0012, 0.002, 0.0055] } as const;
const NIGHT: SkyState = { kind: 'night', stars: true, moon: 2.5, horizon: [...NIGHT_PALETTE.horizon], zenith: [...NIGHT_PALETTE.zenith] };

const target = (): { scene: Scene; setBackgroundNode(node: unknown): void; sets: number } => {
  const scene = new Scene();
  const t = {
    scene,
    sets: 0,
    setBackgroundNode(node: unknown): void {
      t.sets++;
      scene.backgroundNode = node as never;
    },
  };
  return t;
};

afterEach(() => resetCalibration());

describe('the gradient (render §9.2)', () => {
  it('mix(horizon, zenith, pow(max(y, 0), skyK)): the horizon colour at and below the horizon, the zenith colour straight up', () => {
    expect(skyGradientAt(HORIZON, ZENITH, 0, 0.5)).toEqual(HORIZON);
    expect(skyGradientAt(HORIZON, ZENITH, -0.4, 0.5)).toEqual(HORIZON);
    expect(skyGradientAt(HORIZON, ZENITH, -1, 0.5)).toEqual(HORIZON);
    const up = skyGradientAt(HORIZON, ZENITH, 1, 0.5);
    for (let i = 0; i < 3; i++) expect(up[i]).toBeCloseTo(ZENITH[i]!, 12);
    // y = 0.25 with skyK 0.5 is the midpoint
    const mid = skyGradientAt(HORIZON, ZENITH, 0.25, 0.5);
    for (let i = 0; i < 3; i++) expect(mid[i]).toBeCloseTo((HORIZON[i]! + ZENITH[i]!) / 2, 12);
    // the exponent is the calibration's
    const k1 = skyGradientAt(HORIZON, ZENITH, 0.25, 1);
    for (let i = 0; i < 3; i++) expect(k1[i]).toBeCloseTo(HORIZON[i]! + (ZENITH[i]! - HORIZON[i]!) * 0.25, 12);
  });

  it('the mean over the sphere: the lower half is the horizon, the upper half integrates to h + (z − h) / (k + 1)', () => {
    const k = 0.5;
    // numeric integral over y (equal areas on a sphere)
    const n = 200_000;
    const sum = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const y = -1 + (2 * (i + 0.5)) / n;
      const c = skyGradientAt(HORIZON, ZENITH, y, k);
      for (let j = 0; j < 3; j++) sum[j]! += c[j]!;
    }
    const mean = skyMean(HORIZON, ZENITH, k);
    for (let j = 0; j < 3; j++) expect(mean[j]).toBeCloseTo(sum[j]! / n, 6);
  });
});

describe('createSky', () => {
  it('a gradient place: the background node is set, the uniforms hold the place colours, the environment stays null', () => {
    const t = target();
    const sky = createSky(t);
    expect(t.scene.backgroundNode ?? null).toBeNull();
    expect(sky.apply(GRADIENT)).toBe(true);
    expect(sky.kind).toBe('gradient');
    expect(t.scene.backgroundNode).toBe(sky.nodes.gradient);
    expect(t.scene.backgroundNode).not.toBeNull();
    expect(t.scene.environment).toBeNull();
    expect(t.scene.background).toBeNull();
    expect(sky.uniforms.horizon.value.toArray()).toEqual(HORIZON);
    expect(sky.uniforms.zenith.value.toArray()).toEqual(ZENITH);
    expect(sky.uniforms.skyK.value).toBe(0.5);
    const mean = skyMean(HORIZON, ZENITH, 0.5);
    sky.uniforms.mean.value.toArray().forEach((v, i) => expect(v).toBeCloseTo(mean[i]!, 12));
    sky.dispose();
  });

  it('a place switch within the same kind is a data write: the same node object, no second setBackgroundNode', () => {
    const t = target();
    const sky = createSky(t);
    sky.apply(GRADIENT);
    const node = t.scene.backgroundNode;
    expect(sky.apply({ kind: 'gradient', horizon: [0.5, 0.4, 0.3], zenith: [0, 0, 0.1] })).toBe(false);
    expect(t.scene.backgroundNode).toBe(node);
    expect(t.sets).toBe(1);
    expect(sky.uniforms.horizon.value.toArray()).toEqual([0.5, 0.4, 0.3]);
    expect(sky.uniforms.zenith.value.toArray()).toEqual([0, 0, 0.1]);
    sky.dispose();
  });

  it('coldwell-station: the night variant, moon 2.5, stars on; back to a gradient swaps the node once more', () => {
    const t = target();
    const sky = createSky(t);
    sky.apply(GRADIENT);
    expect(sky.apply(NIGHT)).toBe(true);
    expect(sky.kind).toBe('night');
    expect(t.scene.backgroundNode).toBe(sky.nodes.night);
    expect(sky.nodes.night).not.toBe(sky.nodes.gradient);
    expect(sky.uniforms.moon.value).toBe(2.5);
    expect(sky.uniforms.stars.value).toBe(1);
    expect(sky.uniforms.horizon.value.toArray()).toEqual([...NIGHT_PALETTE.horizon]);
    expect(t.scene.environment).toBeNull();
    // stars off and no moon are data too
    expect(sky.apply({ ...NIGHT, stars: false, moon: 0 })).toBe(false);
    expect(sky.uniforms.stars.value).toBe(0);
    expect(sky.uniforms.moon.value).toBe(0);
    expect(sky.apply(GRADIENT)).toBe(true);
    expect(t.scene.backgroundNode).toBe(sky.nodes.gradient);
    expect(t.sets).toBe(3);
    sky.dispose();
  });

  it('reads [CAL skyK] when a place is applied', () => {
    const sky = createSky(target());
    calibration.skyK = 0.8;
    sky.apply(GRADIENT);
    expect(sky.uniforms.skyK.value).toBe(0.8);
    sky.dispose();
  });

  it('hands envTerm a sampler (gradient only) and takes it back on dispose', () => {
    const sky = createSky(target());
    expect(skySampler()).toBe(sky.sampler);
    expect(sky.sampler.mean).toBe(sky.uniforms.mean);
    sky.dispose();
    expect(skySampler()).toBeNull();
  });

  it('the near-black night colours are dark and bluish, the zenith darker than the horizon', () => {
    const { horizon, zenith } = NIGHT_PALETTE;
    for (const c of [horizon, zenith]) {
      expect(Math.max(...c)).toBeLessThan(0.03);
      expect(Math.min(...c)).toBeGreaterThan(0);
      expect(c[2]).toBeGreaterThan(c[0]);
    }
    expect(zenith[0] + zenith[1] + zenith[2]).toBeLessThan(horizon[0] + horizon[1] + horizon[2]);
  });
});

describe('the star field (render §9.2: "a hash-placed star field (about 2,000 points, no twinkle)")', () => {
  it('holds about 2,000 stars, the same ones on every build', () => {
    const a = starField(2000);
    const b = starField(2000);
    expect(a.length).toBeGreaterThanOrEqual(1900);
    expect(a.length).toBeLessThanOrEqual(2100);
    expect(b).toEqual(a);
    // one star per cell at most, each a unit direction with a brightness in (0, 1]
    expect(new Set(a.map((s) => s.cell)).size).toBe(a.length);
    for (const s of a) {
      expect(s.cell).toBeGreaterThanOrEqual(0);
      expect(s.cell).toBeLessThan(STAR_CELLS);
      expect(Math.hypot(...s.direction)).toBeCloseTo(1, 9);
      expect(s.brightness).toBeGreaterThan(0);
      expect(s.brightness).toBeLessThanOrEqual(1);
    }
  });

  it('covers the whole sphere (the station has no ground): every octant holds stars', () => {
    const octants = new Array<number>(8).fill(0);
    for (const s of starField(2000)) octants[(s.direction[0] > 0 ? 1 : 0) | (s.direction[1] > 0 ? 2 : 0) | (s.direction[2] > 0 ? 4 : 0)]!++;
    for (const n of octants) expect(n).toBeGreaterThan(150);
  });

  it('is spread evenly: as dense around the corners of the hash cube as around its face centres', () => {
    const stars = starField(2000);
    const within = (axis: [number, number, number]): number => {
      const l = Math.hypot(...axis);
      return stars.filter((s) => (s.direction[0] * axis[0] + s.direction[1] * axis[1] + s.direction[2] * axis[2]) / l > Math.cos(0.35)).length;
    };
    const faces: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const corners: Array<[number, number, number]> = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) corners.push([x, y, z]);
    const perFace = faces.reduce((n, a) => n + within(a), 0) / faces.length;
    const perCorner = corners.reduce((n, a) => n + within(a), 0) / corners.length;
    // a cap of 0.35 rad holds 3 % of the sphere: about 61 of 2,000 stars (a plain cube grid would put 5 times more at a corner)
    expect(perFace).toBeGreaterThan(45);
    expect(perFace).toBeLessThan(77);
    expect(perCorner / perFace).toBeGreaterThan(0.75);
    expect(perCorner / perFace).toBeLessThan(1.33);
  });

  it('a direction on a star is lit by it, a direction between stars is not', () => {
    const stars = starField(2000);
    const s = stars[100]!;
    const on = starAt(s.direction, STAR_RADIUS, 2000);
    expect(Math.max(...on)).toBeGreaterThan(0);
    expect(Math.max(...on)).toBeCloseTo(s.brightness * Math.max(...s.tint), 6);
    // a point 5 star radii away from this star, inside the same cell or not, is dark unless another star sits there
    const lit = stars.filter((x) => Math.max(...starAt(x.direction, STAR_RADIUS, 2000)) > 0).length;
    expect(lit).toBe(stars.length);
    let dark = 0;
    for (let i = 0; i < 2000; i++) {
      const a = (i * 2.399963) % (2 * Math.PI);
      const y = 1 - (2 * (i + 0.5)) / 2000;
      const r = Math.sqrt(1 - y * y);
      if (Math.max(...starAt([r * Math.cos(a), y, r * Math.sin(a)], STAR_RADIUS, 2000)) === 0) dark++;
    }
    // 2,000 discs of 1.6 mrad cover about 0.04 % of the sphere
    expect(dark).toBeGreaterThan(1990);
  });
});

describe('the moon', () => {
  it('a disc around a fixed unit direction above the horizon, emitting the intensity', () => {
    expect(Math.hypot(...MOON_DIRECTION)).toBeCloseTo(1, 12);
    expect(MOON_DIRECTION[1]).toBeGreaterThan(0.3);
    expect(moonDisc(MOON_DIRECTION)).toBe(1);
    // half a radius off axis: still the full disc; two radii off: nothing
    const off = (angle: number): [number, number, number] => {
      const [x, y, z] = MOON_DIRECTION;
      // rotate toward +Y
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const side = Math.hypot(x, z);
      return [x * c - (x / side) * y * s, y * c + side * s, z * c - (z / side) * y * s];
    };
    expect(moonDisc(off(MOON_RADIUS * 0.5))).toBe(1);
    expect(moonDisc(off(MOON_RADIUS * 2))).toBe(0);
    const centre = nightSkyAt(MOON_DIRECTION, { kind: 'night', stars: false, moon: 2.5, horizon: [...NIGHT_PALETTE.horizon], zenith: [...NIGHT_PALETTE.zenith] }, 0.5, STAR_RADIUS, 2000);
    // HDR: above 1, so the bloom threshold passes it
    expect(Math.min(...centre)).toBeGreaterThan(1.5);
    expect(Math.max(...centre)).toBeLessThanOrEqual(2.5 + 0.03);
    const none = nightSkyAt(MOON_DIRECTION, { kind: 'night', stars: false, moon: 0, horizon: [...NIGHT_PALETTE.horizon], zenith: [...NIGHT_PALETTE.zenith] }, 0.5, STAR_RADIUS, 2000);
    expect(Math.max(...none)).toBeLessThan(0.03);
  });
});
