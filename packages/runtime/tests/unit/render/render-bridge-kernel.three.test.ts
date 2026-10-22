// Synthetic scripted rows exercise kernel-feed interpolation and child disposal through the render bridge.
import { Euler, Group, Matrix4, Quaternion, Vector3, WebGLCoordinateSystem } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { BehaviorCtx, Vec3 } from '../../../src/compat/core/types.ts';
import { createRenderBridge } from '../../../src/render/bridge/render-bridge.ts';
import type { FrameInfo } from '../../../src/render/engine/render-loop.ts';
import { PrimitiveBuckets } from '../../../src/render/geometry/primitives.ts';
import { createLightTable, type LightHandle } from '../../../src/render/lighting/light-table.ts';
import { createViewmodelProjection, createViewmodelRenderer, registerViewmodelStage } from '../../../src/render/models/viewmodel-renderer.ts';
import { createCameraPresenter, lookDirection } from '../../../src/render/scene/camera-presenter.ts';
import { SurfaceVariant as V } from '../../../src/render/surface/surface-material.ts';
import { createViewmodelContent } from '../../../src/render/bridge/attach.ts';
import { ctxWorld } from '../core/fakes/ctx-world.ts';
import { matrixDiff } from './bridge-fakes.ts';
import { testEnv } from './models/model-fixtures.ts';

const DEG = Math.PI / 180;
const TICK_MS = 1000 / 30;
const trs = (pos: [number, number, number], yaw = 0, pitch = 0): Matrix4 =>
  new Matrix4().compose(new Vector3(...pos), new Quaternion().setFromEuler(new Euler(pitch * DEG, yaw * DEG, 0, 'YXZ')), new Vector3(1, 1, 1));

// Synthetic parent light and child geometry use independent, asymmetric transforms.
const TORCH = { kind: 'spot', color: '#38bdf8', intensity: 2.5, distance: 8, angle: 0.4, penumbra: 0.3, decay: 1.5, aim: 'forward', shadow: false };
const haze = (r: number, opacity: number): Record<string, unknown> => ({
  primitive: { kind: 'cylinder', radiusTop: r, radiusBottom: 0.1, height: 3, openEnded: true, radialSegments: 12 },
  material: { color: '#5566aa', opacity, transparent: true, depthWrite: false, side: 'double', roughness: 1, metalness: 0 },
  castShadow: false,
  receiveShadow: false,
});
const CONES = [haze(0.3, 0.2), haze(0.8, 0.1)];

/** yaw the body is turned by per tick, degrees */
const TURN = 12;

const MODULES = {
  // A rotating fixture owns a light and two transparent children.
  'scripts/turner.js': {
    onSpawn(ctx: BehaviorCtx) {
      const id = ctx.self.id;
      const lamp = ctx.spawn({ parent: id, audience: 'local', scope: 'session', tags: ['fixture-light'], feetPosition: { x: 0.4, y: 0.8, z: -0.2 }, rotation: { pitch: 15 }, light: TORCH });
      const cones = CONES.map((c) => ctx.spawn({ parent: lamp, audience: 'local', scope: 'session', tags: ['fixture-child'], feetPosition: { x: 0, y: 0, z: 0 }, rotation: { pitch: -60 }, ...c }));
      ctx.state = { lamp, cones, yaw: 0, removeLight: false };
    },
    update(ctx: BehaviorCtx) {
      const s = ctx.state as { lamp: string | null; yaw: number; removeLight: boolean };
      s.yaw += TURN;
      ctx.self.rotation = { yaw: s.yaw };
      // Destroying the parent must cascade through both child rows.
      if (s.removeLight && s.lamp !== null) {
        ctx.destroy(s.lamp);
        s.lamp = null;
      }
    },
  },
  // A synthetic camera-attached row moves once per tick.
  'scripts/vm.js': {
    update(ctx: BehaviorCtx) {
      const s = ctx.state as { x: number };
      s.x += 0.01;
      ctx.self.feetPosition = { attach: 'camera', x: s.x, y: -0.2, depth: 0.5, fov: 55 };
    },
  },
};

async function scene() {
  const cw = await ctxWorld({ modules: MODULES, places: ['arena'] });
  const k = cw.k;
  const env = testEnv();
  const world = new Group();
  const camera = createCameraPresenter({ coordinateSystem: () => WebGLCoordinateSystem });
  camera.setViewport(640, 360);
  camera.apply({ eye: { x: 0, y: 1.6, z: 6 }, yaw: 0, pitch: 0, roll: 0, vfovDeg: 58.72 });
  const projection = createViewmodelProjection();
  registerViewmodelStage(env.materials, projection);
  const vm = createViewmodelRenderer({ camera, projection, coordinateSystem: () => WebGLCoordinateSystem, materials: env.materials });
  const lights = createLightTable();
  const poses = new Map<LightHandle, { p: Vec3; d: Vec3 | undefined }>();
  const counts = { add: 0, remove: 0 };
  const buckets = new PrimitiveBuckets({ script: { lighting: (_s, l) => l.ambient }, parent: world, capacity: 4, log: () => undefined });
  const logs: string[] = [];
  const bridge = createRenderBridge({
    world,
    camera,
    primitives: buckets,
    viewmodel: vm,
    viewmodelContent: createViewmodelContent({ materials: env.materials }),
    lights: {
      add: (rec) => {
        counts.add++;
        const h = lights.add(rec);
        poses.set(h, { p: { ...rec.position }, d: rec.direction && { ...rec.direction } });
        return h;
      },
      remove: (h) => {
        counts.remove++;
        poses.delete(h);
        lights.remove(h);
      },
      setIntensity: (h, v) => lights.setIntensity(h, v),
      setColor: (h, c) => lights.setColor(h, c),
      setPose: (h, p, d) => {
        poses.set(h, { p: { ...p }, d: d && { ...d } });
        lights.setPose(h, p, d);
      },
    },
    log: (m) => logs.push(m),
  });
  // the renderer attaches after the kernel has run: the feed has accumulated (X-04)
  bridge.attach(k.feed);
  let frameIndex = 0;
  /** one animation frame of `realDtMs`: the kernel advances, the bridge presents the alpha it returns */
  const frame = (realDtMs: number): { ticks: number; alpha: number } => {
    const step = k.advance(realDtMs);
    const info: FrameInfo = { now: frameIndex * 16, dt: realDtMs / 1000, realDt: realDtMs / 1000, alpha: step.alpha, frameIndex: frameIndex++, paused: !k.clock.running };
    bridge.update(info);
    return step;
  };
  const instances = (): number => buckets.buckets().reduce((n, b) => n + b.count, 0);
  return { cw, k, bridge, lights, poses, counts, buckets, vm, camera, logs, frame, instances };
}

describe('render bridge: the kernel drives a scripted scene', () => {
  it('the first drain delivers the rows the kernel already has; the torch lights along the body\'s interpolated facing and the cones follow', async () => {
    const s = await scene();
    s.cw.spawn('bot', { place: 'arena', behavior: 'scripts/turner.js', feetPosition: { x: 2, y: 0, z: -1 } });
    s.cw.spawn('wall', { place: 'arena', feetPosition: { x: 0, y: 0, z: -8 }, primitive: { kind: 'box', width: 12, height: 4, depth: 0.2 }, material: { color: 'oklch(0.7 0.02 90)', roughness: 0.9 } });
    s.cw.spawn('hidden', { place: 'arena', feetPosition: { x: 4, y: 0, z: 0 }, visible: false, primitive: { kind: 'box', size: 1 }, material: { color: '#ff0000' } });
    s.cw.spawn('ranged', { place: 'arena', feetPosition: { x: 0, y: 0, z: -40 }, visibleRange: { max: 30 }, primitive: { kind: 'sphere', radius: 0.5 }, material: { color: '#00ff00' } });
    s.cw.ticks(3); // the game ran before the renderer existed
    const state = s.cw.row('bot').state as { lamp: string; cones: string[]; yaw: number };
    expect(state.yaw).toBe(3 * TURN);

    // frame 1: nothing has been drained yet; every live row arrives as added
    const first = s.frame(0);
    expect(first.ticks).toBe(0);
    expect(s.bridge.stats().rows).toBe(7); // bot, lamp, two cones, wall, hidden, ranged
    expect(s.counts.add).toBe(1);
    // the wall and the two cones draw; the hidden row and the row beyond its range do not
    expect(s.instances()).toBe(3);

    // half a tick later the kernel has run no new tick: alpha 0.5 between the last two
    let yaw = state.yaw;
    const check = (alpha: number, from: number, to: number): void => {
      const at = from + (to - from) * alpha;
      const torch = trs([2, 0, -1], at).multiply(trs([0.4, 0.8, -0.2], 0, 15));
      const [pose] = [...s.poses.values()];
      const p = new Vector3().setFromMatrixPosition(torch);
      expect(Math.hypot(pose!.p.x - p.x, pose!.p.y - p.y, pose!.p.z - p.z)).toBeLessThan(1e-9);
      const f = lookDirection(at * DEG, 15 * DEG);
      expect(Math.hypot(pose!.d!.x + f.x, pose!.d!.y + f.y, pose!.d!.z + f.z), `direction at yaw ${at}`).toBeLessThan(1e-9);
      const cone = s.buckets.buckets().find((b) => b.key.startsWith('cylinder:1:0.125:12:open'))!;
      const want = torch.clone().multiply(trs([0, 0, 0], 0, -60)).multiply(new Matrix4().makeScale(0.8, 3, 0.8));
      expect(matrixDiff(cone.matrices.subarray(0, 16), want.elements)).toBeLessThan(1e-5);
    };
    // run frames at 4 per tick: each new tick turns the body by TURN, and the frames between present the turn in quarters
    const seenAlphas = new Set<string>();
    let ticked = false;
    for (let i = 0; i < 24; i++) {
      const step = s.frame(TICK_MS / 4);
      if (step.ticks > 0) yaw += TURN * step.ticks;
      ticked ||= step.ticks > 0;
      expect((s.cw.row('bot').state as { yaw: number }).yaw).toBe(yaw);
      // a row the bridge has just been given presents its current value until a tick has replaced it
      if (ticked) check(step.alpha, yaw - TURN, yaw);
      else check(1, yaw - TURN, yaw);
      seenAlphas.add(step.alpha.toFixed(2));
    }
    // the frames really did fall between ticks
    expect([...seenAlphas].some((a) => a !== '0.00' && a !== '1.00')).toBe(true);
    // 24 frames, 6 ticks: no light was added or removed, only posed
    expect([s.counts.add, s.counts.remove]).toEqual([1, 0]);
    expect(s.logs).toEqual([]);

    // The fixture requests parent removal; both children leave in the same drain.
    (s.cw.row('bot').state as { removeLight: boolean }).removeLight = true;
    while (s.frame(TICK_MS / 2).ticks === 0);
    expect([s.counts.remove, s.lights.size, s.instances()]).toEqual([1, 0, 1]);
    expect(s.bridge.stats().rows).toBe(4);

    // the ranged row comes into range when the camera does
    s.camera.apply({ eye: { x: 0, y: 1.6, z: -20 }, yaw: 0, pitch: 0, roll: 0, vfovDeg: 58.72 });
    s.frame(1);
    expect(s.instances()).toBe(2);
    // and the hidden row draws once the game shows it
    const hidden = s.k.store.handle(s.cw.row('hidden'), 'platform');
    hidden.visible = true;
    s.frame(TICK_MS);
    expect(s.instances()).toBe(3);
  });

  it('a camera-attached row the game writes every tick is interpolated in camera space by the alpha of kernel.advance', async () => {
    const s = await scene();
    s.cw.spawn('gun', { place: 'arena', behavior: 'scripts/vm.js', tags: ['ss-vm'], state: { x: 0.1 }, feetPosition: { attach: 'camera', x: 0.1, y: -0.2, depth: 0.5, fov: 55 }, primitive: { kind: 'box', width: 0.1, height: 0.1, depth: 0.4 }, material: { color: '#888888' } });
    s.frame(0);
    expect(s.vm.has('gun')).toBe(true);
    // the content draws through the viewmodel projection
    const root = s.vm.root('gun')!;
    let mesh: { material: { variant: number } } | null = null;
    root.traverse((o) => {
      if ((o as { isMesh?: boolean }).isMesh === true) mesh = o as never;
    });
    expect(mesh!.material.variant & V.VIEWMODEL).toBe(V.VIEWMODEL);
    let x = 0.1;
    let between = 0;
    for (let i = 0; i < 16; i++) {
      const step = s.frame(TICK_MS / 4);
      x += 0.01 * step.ticks;
      const o = s.vm.presented('gun')!;
      // the first tick after the spawn has nothing to interpolate from; after it, prev → cur by alpha
      if (step.alpha > 0 && step.alpha < 1 && x > 0.115) {
        expect(o.x).toBeCloseTo(x - 0.01 + 0.01 * step.alpha, 9);
        between++;
      }
      expect(o.depth).toBe(0.5);
    }
    expect(between).toBeGreaterThan(4);
    // the gun leaves with its row
    s.k.store.handle(s.cw.row('gun'), 'platform');
    s.cw.ctx('gun').destroy('gun');
    while (s.frame(TICK_MS / 2).ticks === 0);
    s.frame(1);
    expect(s.vm.has('gun')).toBe(false);
  });
});
