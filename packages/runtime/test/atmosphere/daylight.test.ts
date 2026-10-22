// K14 daylight atmosphere: config -> sky / sun / fill numbers (daylight.ts), the controller driving the root's permanent lights
// (atmosphere.ts), and the node graphs building in three's GLSL node builder. The negative control throughout is PP's default:
// the same config under the default model leaves every daylight value where PP had it.
import { GLSLNodeBuilder, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, PerspectiveCamera, PlaneGeometry, Scene } from 'three/webgpu';
import type { DirectionalLight } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { createAtmosphere } from '../../src/render/atmosphere/atmosphere.ts';
import { daylightFor, sunDirectionAt } from '../../src/render/atmosphere/daylight.ts';
import { FADE_S, createFlashGuard } from '../../src/render/lighting/flash-guard.ts';
import { DERIVED_AMBIENT_MAX, DERIVED_HEMISPHERE_MAX, MIN_CYCLE_PERIOD_MS, SUN_PEAK_INTENSITY } from '../../src/render/atmosphere/daylight.ts';
import { cssToLinear } from '../../src/render/color/color.ts';
import { createSceneRoot } from '../../src/render/scene/scene-root.ts';

const DAY = { sky: { kind: 'realistic', model: 'hosek' }, timeOfDay: 12 };
const DUSK = { sky: { kind: 'realistic', model: 'hosek' }, timeOfDay: 18 };
const NIGHT = { sky: { kind: 'realistic', model: 'hosek' }, timeOfDay: 0 };

const make = (model?: 'night' | 'daylight', rootOpts = {}) => {
  const root = createSceneRoot(rootOpts);
  const atm = createAtmosphere({ root, warn: () => undefined, ...(model === undefined ? {} : { model }) });
  return { root, atm };
};

describe('K14 daylight model (pure numbers)', () => {
  it('the sun is up at noon, on the horizon at 06:00 and 18:00, below it at midnight', () => {
    expect(sunDirectionAt(12)[1]).toBeCloseTo(Math.sin(Math.PI / 3), 6);
    expect(Math.abs(sunDirectionAt(6)[1])).toBeLessThan(1e-9);
    expect(Math.abs(sunDirectionAt(18)[1])).toBeLessThan(1e-9);
    expect(sunDirectionAt(0)[1]).toBeLessThan(-0.8);
    const d = sunDirectionAt(9);
    expect(Math.hypot(...d)).toBeCloseTo(1, 9);
  });

  it('noon and dusk differ in sun intensity, colour, sky, fill and elevation; midnight has no sun', () => {
    const noon = daylightFor(DAY);
    const dusk = daylightFor(DUSK);
    const night = daylightFor(NIGHT);
    expect(noon.sunIntensity).toBeGreaterThan(2.5);
    expect(dusk.sunIntensity).toBeLessThan(0.5);
    expect(night.sunIntensity).toBe(0);
    expect(noon.sunColor[2]).toBeGreaterThan(dusk.sunColor[2]); // warmer at dusk
    expect(noon.zenith[2]).toBeGreaterThan(noon.zenith[0] * 3); // blue overhead
    expect(noon.zenith[2]).toBeGreaterThan(night.zenith[2] * 50);
    expect(noon.hemisphere.intensity).toBeGreaterThan(dusk.hemisphere.intensity);
    expect(dusk.hemisphere.intensity).toBeGreaterThan(night.hemisphere.intensity);
    expect(noon.elevation).toBeGreaterThan(dusk.elevation);
    expect(noon.horizon[0]).not.toBe(dusk.horizon[0]);
  });

  it('overrides: sky.top / sky.bottom replace zenith / horizon; sun.intensity / sun.color replace the peak and the colour', () => {
    const top = cssToLinear('#ff0000')!;
    const bottom = cssToLinear('#00ff00')!;
    const d = daylightFor({ ...DAY, sky: { top: '#ff0000', bottom: '#00ff00' }, sun: { intensity: 1.25, color: '#0000ff' } });
    expect(d.zenith).toEqual(top);
    expect(d.horizon).toEqual(bottom);
    expect(d.sunIntensity).toBeCloseTo(1.25, 6);
    expect(d.sunColor).toEqual(cssToLinear('#0000ff'));
    // the engine's own shape, sun.light.*
    expect(daylightFor({ ...DAY, sun: { light: { intensity: 2 } } }).sunIntensity).toBeCloseTo(2, 6);
    // an override does not light the night
    expect(daylightFor({ ...NIGHT, sun: { intensity: 9 } }).sunIntensity).toBe(0);
    // an unreadable colour is ignored
    expect(daylightFor({ ...DAY, sky: { top: 'not a colour' } }).zenith).toEqual(daylightFor(DAY).zenith);
  });

  it('sun.rotation pins the direction; clouds exist only when enabled', () => {
    const d = daylightFor({ ...DAY, sun: { rotation: { pitch: 30, yaw: 90 } } });
    expect(d.sunDirection[1]).toBeCloseTo(0.5, 6);
    expect(d.sunDirection[0]).toBeGreaterThan(0.8);
    expect(daylightFor(DAY).clouds).toBeNull();
    expect(daylightFor({ ...DAY, clouds: { enabled: false } }).clouds).toBeNull();
    const c = daylightFor({ ...DAY, clouds: { enabled: true, density: 0.35, opacity: 0.85, altitude: 400, thickness: 600 } }).clouds!;
    expect(c).toMatchObject({ density: 0.35, opacity: 0.85 });
    expect(c.color[0]).toBeGreaterThan(daylightFor({ ...NIGHT, clouds: { enabled: true } }).clouds!.color[0]);
  });
});

describe('K14 daylight model (the controller on a scene root)', () => {
  it('noon lights the first permanent directional light as the sun; dusk dims it; the light set never changes', () => {
    const { root, atm } = make('daylight');
    const before = root.scene.children.length;
    const lights = root.lights.all.map((l) => l.id);
    atm.load(DAY);
    const sun = root.lights.directionals[0];
    expect(atm.model).toBe('daylight');
    expect(atm.state.sky.kind).toBe('daylight');
    expect(sun.intensity).toBeGreaterThan(2.5);
    expect(sun.position.y).toBeGreaterThan(50);
    expect(atm.sky.kind).toBe('daylight');
    expect(root.scene.backgroundNode).toBe(atm.sky.nodes.daylight);
    const noonSun = sun.intensity;
    atm.load(DUSK);
    expect(sun.intensity).toBeLessThan(noonSun / 4);
    atm.load(NIGHT);
    expect(sun.intensity).toBe(0);
    expect(root.scene.children.length).toBe(before);
    expect(root.lights.all.map((l) => l.id)).toEqual(lights);
    // the second slot is untouched
    expect(root.lights.directionals[1].intensity).toBe(0);
  });

  it('derives the hemisphere and ambient fill from the hour when the config authors none, and honours authored ones', () => {
    const { root, atm } = make('daylight');
    atm.load(DAY);
    const noonFill = root.lights.hemisphere.intensity;
    expect(noonFill).toBeGreaterThan(0.4);
    expect(root.lights.ambient.intensity).toBeGreaterThan(0.1);
    atm.load(DUSK);
    expect(root.lights.hemisphere.intensity).toBeLessThan(noonFill);
    atm.load({ ...DAY, hemisphere: { skyColor: '#ffffff', groundColor: '#000000', intensity: 0.2 }, ambient: { light: { intensity: 0.7 } } });
    expect(root.lights.hemisphere.intensity).toBeCloseTo(0.2, 6);
    expect(root.lights.ambient.intensity).toBeCloseTo(0.7, 6);
    atm.load({ ...DAY, hemisphere: null });
    expect(root.lights.hemisphere.intensity).toBe(0);
  });

  it('live writes: timeOfDay moves the sun, cycle.frozen pins it, a running cycle advances it, sun.intensity overrides', () => {
    const { root, atm } = make('daylight');
    atm.load(DAY);
    const sun = root.lights.directionals[0];
    const noonY = sun.position.y;
    atm.onWrite('timeOfDay', 17);
    atm.update({ now: 0, dt: 0.016 });
    expect(sun.position.y).toBeLessThan(noonY);
    expect(atm.daylight!.hour).toBe(17);
    atm.onWrite('cycle', { frozen: 12 });
    atm.update({ now: 1000, dt: 0.016 });
    expect(atm.daylight!.hour).toBe(12);
    expect(sun.position.y).toBeCloseTo(noonY, 6);
    atm.onWrite('cycle', { periodMs: 60_000, epoch: 0 });
    atm.update({ now: 2500, dt: 0.016 }); // one hour on from 17
    expect(atm.daylight!.hour).toBeCloseTo(18, 1);
    atm.onWrite('cycle', undefined);
    atm.onWrite('timeOfDay', 12);
    atm.onWrite('sun.intensity', 1);
    atm.update({ now: 2000, dt: 0.016 });
    expect(sun.intensity).toBeCloseTo(1, 6);
  });

  it('a gradient sky that names top / bottom stays a gradient with those colours, still lit by the sun', () => {
    const { root, atm } = make('daylight');
    atm.load({ sky: { kind: 'gradient', top: '#102040', bottom: '#306090' }, timeOfDay: 12 });
    expect(atm.state.sky.kind).toBe('gradient');
    expect(atm.state.sky.zenith).toEqual(cssToLinear('#102040'));
    expect(atm.state.sky.horizon).toEqual(cssToLinear('#306090'));
    expect(root.lights.directionals[0].intensity).toBeGreaterThan(2.5);
    expect(root.scene.backgroundNode).toBe(atm.sky.nodes.gradient);
  });

  it('the colour of a fog that names none follows the daylight horizon', () => {
    const { atm } = make('daylight');
    atm.load({ ...DAY, fog: { kind: 'exp2', density: 0.01 } });
    expect(atm.state.fog.color).toEqual(atm.state.sky.horizon);
  });

  it('setSunFocus moves the sun and its target together', () => {
    const { root, atm } = make('daylight');
    atm.load(DAY);
    const sun = root.lights.directionals[0];
    const rel = sun.position.clone().sub(sun.target.position);
    atm.setSunFocus(10, 0, -20);
    expect(sun.target.position.toArray()).toEqual([10, 0, -20]);
    expect(sun.position.clone().sub(sun.target.position).distanceTo(rel)).toBeLessThan(1e-9);
  });

  it('control: the default model ignores timeOfDay / sun / clouds / top / bottom and keeps PP exactly (night sky, dark moons, no fill)', () => {
    for (const model of [undefined, 'night'] as const) {
      const { root, atm } = make(model);
      atm.load({ ...DAY, sun: { intensity: 5, color: '#ff0000' }, clouds: { enabled: true }, sky: { kind: 'realistic', top: '#ff0000' } });
      expect(atm.model).toBe('night');
      expect(atm.daylight).toBeNull();
      expect(atm.state.sky.kind).toBe('night');
      expect(root.scene.backgroundNode).toBe(atm.sky.nodes.night);
      expect(root.lights.directionals[0].intensity).toBe(0);
      expect(root.lights.directionals[1].intensity).toBe(0);
      expect(root.lights.ambient.intensity).toBe(0);
      expect(root.lights.hemisphere.intensity).toBe(0);
      atm.onWrite('timeOfDay', 3);
      atm.onWrite('sun.intensity', 9);
      atm.update({ now: 0, dt: 0.016 });
      expect(root.lights.directionals[0].intensity).toBe(0);
      atm.setSunFocus(5, 5, 5);
      expect(root.lights.directionals[0].target.position.toArray()).toEqual([0, 0, 0]);
      // a gradient sky under the default model ignores top / bottom (PP never read them)
      atm.load({ sky: { kind: 'gradient', top: '#ff0000', bottom: '#00ff00' } });
      expect(atm.state.sky.zenith).toEqual([0, 0, 0]);
    }
  });

  it('sun shadow is opt-in: off on a default root, on with sensible defaults when asked, and the light set keeps its size', () => {
    const plain = createSceneRoot();
    expect(plain.lights.directionals.every((m: DirectionalLight) => !m.castShadow)).toBe(true);
    const lit = createSceneRoot({ sunShadow: true });
    const sun = lit.lights.directionals[0];
    expect(sun.castShadow).toBe(true);
    expect(lit.lights.directionals[1].castShadow).toBe(false);
    expect(sun.shadow.mapSize.x).toBe(2048);
    expect(sun.shadow.camera.right).toBe(40);
    expect(sun.shadow.bias).toBeLessThan(0);
    expect(lit.lights.all.length).toBe(plain.lights.all.length);
    const second = createSceneRoot({ sunShadow: { slot: 1, mapSize: 1024, extent: 25 } });
    expect(second.lights.directionals[1].castShadow).toBe(true);
    expect(second.lights.directionals[1].shadow.mapSize.x).toBe(1024);
    expect(second.lights.directionals[0].castShadow).toBe(false);
  });
});

/** the fragment shader three's GLSL node builder produces for a mesh and its material */
function fragmentOf(mesh: Mesh, scene: Scene): string {
  const renderer = {
    debug: { diagnostics: { keywords: false } },
    backend: { capabilities: { getUniformBufferLimit: () => 65_536 } },
    coordinateSystem: 2000,
    getRenderTarget: () => null,
    getMRT: () => null,
    toneMapping: 0,
    outputColorSpace: 'srgb',
    library: { fromMaterial: (m: unknown) => m },
    contextNode: { isContextNode: true, getFlowContextData: () => ({}) },
    shadowMap: { enabled: false },
    lighting: { enabled: false },
  };
  const b = new GLSLNodeBuilder(mesh as never, renderer as never) as unknown as {
    scene: unknown;
    camera: unknown;
    material: unknown;
    build(): void;
    fragmentShader: string;
  };
  b.scene = scene;
  b.camera = new PerspectiveCamera();
  b.material = mesh.material;
  b.build();
  return b.fragmentShader;
}

describe('K14 daylight materials build in three node builder', () => {
  it('the daylight sky graph (gradient, sun, noise clouds) compiles to a fragment shader with its uniforms', () => {
    const { atm } = make('daylight');
    const scene = new Scene();
    const mesh = new Mesh(new PlaneGeometry(1, 1), new MeshBasicNodeMaterial({ colorNode: atm.sky.nodes.daylight as never }));
    scene.add(mesh);
    const fs = fragmentOf(mesh, scene);
    for (const name of ['ssSkySunDir', 'ssSkyCloud', 'ssSkyHorizon', 'ssSkyZenith']) expect(fs, name).toContain(name);
    // negative control: the night graph has none of the sun's or clouds' uniforms
    const night = new Mesh(new PlaneGeometry(1, 1), new MeshBasicNodeMaterial({ colorNode: atm.sky.nodes.night as never }));
    const nfs = fragmentOf(night, scene);
    expect(nfs).not.toContain('ssSkySunDir');
    expect(nfs).not.toContain('ssSkyCloud');
  });

  it('a standard material lit by the daylight scene builds', () => {
    const { root, atm } = make('daylight', { sunShadow: true });
    atm.load(DAY);
    const mesh = new Mesh(new PlaneGeometry(1, 1), new MeshStandardNodeMaterial({ color: 0x55aa55 }));
    root.scene.add(mesh);
    expect(fragmentOf(mesh, root.scene).length).toBeGreaterThan(100);
  });
});

describe('K14 daylight FlashGuard (sun channel, authored bases)', () => {
  const guarded = (on: boolean) => {
    const guard = createFlashGuard();
    guard.setEnabled(on);
    const root = createSceneRoot({});
    const atm = createAtmosphere({ root, warn: () => undefined, model: 'daylight', flashGuard: guard });
    return { root, atm, guard };
  };
  /** snaps noon -> midnight -> noon every 50 ms for 3 s; returns the sun intensity per frame */
  const strobe = (on: boolean): number[] => {
    const { root, atm } = guarded(on);
    atm.load(DAY, DAY);
    const out: number[] = [];
    for (let i = 0; i < 60; i++) {
      atm.onWrite('timeOfDay', i % 2 === 0 ? 0 : 12);
      atm.update({ now: i * 50, dt: 0.05 });
      out.push(root.lights.directionals[0].intensity);
    }
    return out;
  };
  const reversals = (v: number[]): number => {
    let n = 0;
    let dir = 0;
    for (let i = 1; i < v.length; i++) {
      const d = Math.sign(v[i]! - v[i - 1]!);
      if (d !== 0 && d !== dir) {
        if (dir !== 0) n++;
        dir = d;
      }
    }
    return n;
  };

  it('a snapping hour is limited by the guard to the flash limits; with the guard off the jump passes through', () => {
    const on = strobe(true);
    const off = strobe(false);
    expect(Math.max(...off) - Math.min(...off)).toBeCloseTo(SUN_PEAK_INTENSITY, 3); // negative control: full swing each frame
    expect(reversals(off)).toBeGreaterThan(40);
    const maxStep = Math.max(...on.slice(1).map((x, i) => Math.abs(x - on[i]!)));
    expect(maxStep).toBeLessThanOrEqual((SUN_PEAK_INTENSITY / FADE_S) * 0.05 + 1e-9);
    expect(reversals(on)).toBeLessThanOrEqual(Math.ceil(3 * 3) + 1); // 3 s at <= 3 reversals/s
  });

  it('a tiny cycle period is clamped: the day cannot run faster than MIN_CYCLE_PERIOD_MS', () => {
    const { atm } = guarded(false);
    atm.load(DAY, DAY);
    atm.onWrite('cycle', { periodMs: 10, epoch: 0 });
    atm.update({ now: 1000, dt: 0.016 });
    const advanced = (atm.daylight!.hour - 12 + 24) % 24;
    expect(advanced).toBeCloseTo((1000 / MIN_CYCLE_PERIOD_MS) * 24, 3);
  });

  it('writing a large ambient or hemisphere value does not raise the guard base', () => {
    const { root, atm } = guarded(true);
    atm.load(DAY, DAY);
    atm.update({ now: 0, dt: 0.016 });
    const a0 = root.lights.ambient.intensity;
    const h0 = root.lights.hemisphere.intensity;
    atm.onWrite('ambient.light.intensity', 50);
    atm.onWrite('hemisphere', { skyColor: '#ffffff', groundColor: '#000000', intensity: 50 });
    for (let i = 1; i < 200; i++) {
      atm.update({ now: i * 100, dt: 0.1 });
      expect(root.lights.ambient.intensity).toBeLessThanOrEqual(DERIVED_AMBIENT_MAX + 1e-9);
      expect(root.lights.hemisphere.intensity).toBeLessThanOrEqual(DERIVED_HEMISPHERE_MAX + 1e-9);
    }
    expect(root.lights.ambient.intensity).toBeGreaterThanOrEqual(a0);
    expect(root.lights.hemisphere.intensity).toBeGreaterThanOrEqual(h0);
    // negative control: guard off, the write passes
    const off = guarded(false);
    off.atm.load(DAY, DAY);
    off.atm.onWrite('ambient.light.intensity', 50);
    off.atm.update({ now: 0, dt: 0.016 });
    expect(off.root.lights.ambient.intensity).toBe(50);
  });
});
