// Null ports: every port of docs/architecture.md §3.0 has a null implementation so the kernel runs headless
// (docs/design/core-runtime.md §15).
import { describe, expect, it, vi } from 'vitest';
import {
  createNullPorts,
  emptyInputState,
  emptyPlaceBake,
  withNullPorts,
} from '../../../src/compat/core/null-ports.ts';
import type { KernelPorts } from '../../../src/compat/core/ports.ts';
import type { RowRec } from '../../../src/compat/core/types.ts';

const PORT_KEYS: Array<keyof KernelPorts> = ['physics', 'motion', 'scene', 'attach', 'input', 'camera', 'assets', 'ui', 'platform'];
const row = { id: 'r1' } as RowRec;

describe('createNullPorts', () => {
  it('supplies every port', () => {
    const ports = createNullPorts();
    expect(Object.keys(ports).sort()).toEqual([...PORT_KEYS].sort());
  });

  it('physics: no bodies, no ground, no triggers; both VMs share one world', () => {
    const { physics } = createNullPorts();
    expect(physics.groundY('gallow-farm', 0, 0)).toBe(null);
    const a = physics.drainTriggerEnters();
    expect(a).toEqual([]);
    expect(physics.drainTriggerEnters()).not.toBe(a);
    expect(physics.vmWorlds.platform).toBe(physics.vmWorlds.client);
    expect(() => {
      physics.buildPlace('p', emptyPlaceBake('p'));
      physics.rowSpawned(row);
      physics.onPhysicsWrite(row, 'kinematic');
      physics.setPosition(row, { x: 1, y: 2, z: 3 });
      physics.setRotation(row, { x: 0, y: 0, z: 0, w: 1 });
      physics.setVelocity(row, { x: 0, y: 0, z: 0 });
      physics.setAngularVelocity(row, { x: 0, y: 0, z: 0 });
      physics.setForce(row, 'surge', null);
      physics.setSpectating(row, true);
      physics.applyImpulse('r1', { x: 0, y: 1, z: 0 });
      physics.step('p', 1 / 30);
      physics.setVisualProxies('p', { keys: [], instances: [] });
      physics.rowDestroyed(row);
      physics.disposePlace('p');
    }).not.toThrow();
  });

  it('motion and attachments: nothing to advance, no attachment pose (the parent pose applies)', () => {
    const { motion, attach } = createNullPorts();
    expect(() => motion.advanceTick(1 / 30)).not.toThrow();
    expect(attach.worldPose(row)).toBe(null);
  });

  it('scene: a place build finishes at once with full progress; no bounds, no sockets', async () => {
    const { scene } = createNullPorts();
    const progress = vi.fn();
    await expect(scene.buildPlace('p', [row], emptyPlaceBake('p'), progress)).resolves.toBeUndefined();
    expect(progress).toHaveBeenLastCalledWith(1);
    expect(scene.bounds(row)).toBe(undefined);
    expect(scene.socket('r1', 'muzzle')).toBe(null);
    expect(() => {
      scene.activate('p');
      scene.disposePlace('p');
    }).not.toThrow();
  });

  it('input: empty samples (fresh each time), nothing declared, every sendAction dropped', () => {
    const { input } = createNullPorts();
    const s = input.sampleTick();
    expect(s).toEqual({ axes: {}, held: {}, pressed: {}, released: {}, actions: {} });
    s.axes['moveX'] = 1;
    expect(input.sampleTick().axes).toEqual({});
    expect(input.sampleRig()).toEqual(emptyInputState());
    expect(input.injectAction('ss_req', { op: 'ready' })).toBe(false);
    expect(input.declared).toEqual({});
    expect(() => {
      input.setBlocked('body', true);
      input.discardEdges();
    }).not.toThrow();
  });

  it('camera: no presented camera before a frame, no view, no world camera values', () => {
    const { camera } = createNullPorts();
    expect(camera.presentedCamera()).toBe(null);
    expect(camera.view()).toBe(undefined);
    expect(camera.worldCamera()).toEqual({});
  });

  it('assets: no facts; a place bake with nothing in it', async () => {
    const { assets } = createNullPorts();
    expect(assets.get('cdn/x.glb')).toBe(undefined);
    const bake = await assets.placeBake('gallow-farm');
    expect(bake).toEqual(emptyPlaceBake('gallow-farm'));
    expect(bake.colliders).toEqual({ place: 'gallow-farm', keys: [], instances: [], runtimeKeys: [] });
    expect(bake.navgrid).toBe(null);
    expect(bake.terrain).toBe(null);
  });

  it('ui: markDirty and uiEvent are accepted and do nothing', () => {
    const { ui } = createNullPorts();
    expect(() => {
      ui.markDirty();
      ui.uiEvent('ssBlood', { k: 1 });
    }).not.toThrow();
  });

  it('platform: an in-memory save store and no user', async () => {
    const { platform } = createNullPorts();
    await expect(platform.save.ready).resolves.toBeUndefined();
    expect(platform.save.get('ss_save_v1')).toBe(null);
    platform.save.set('ss_save_v1', '{"v":1}');
    expect(platform.save.get('ss_save_v1')).toBe('{"v":1}');
    platform.save.remove('ss_save_v1');
    expect(platform.save.get('ss_save_v1')).toBe(null);
    await expect(platform.save.flush()).resolves.toBeUndefined();
    await expect(platform.getUser()).resolves.toBe(null);
  });

  it('platform: the save store refuses the empty string the contract forbids (the Bridge would delete the key)', () => {
    const { platform } = createNullPorts();
    platform.save.set('ss_save_v1', '{"v":1}');
    expect(() => platform.save.set('ss_save_v1', '')).toThrow(TypeError);
    expect(platform.save.get('ss_save_v1')).toBe('{"v":1}');
  });

  it('platform: storage, identity and loading work with no host adapter', async () => {
    const { platform } = createNullPorts();
    await expect(platform.init()).resolves.toBeUndefined();
    await expect(platform.getUser()).resolves.toBeNull();
    expect(() => platform.setLoadingProgress(100)).not.toThrow();
    expect(Object.keys(platform).sort()).toEqual(['getUser', 'init', 'on', 'save', 'setLoadingProgress']);
  });

  it('gives each kernel its own instances', () => {
    const a = createNullPorts();
    const b = createNullPorts();
    a.platform.save.set('k', 'a');
    expect(b.platform.save.get('k')).toBe(null);
    expect(a.physics).not.toBe(b.physics);
  });
});

describe('withNullPorts', () => {
  it('keeps the ports it is given and fills the rest', () => {
    const own = createNullPorts();
    const ports = withNullPorts({ input: own.input, platform: own.platform });
    expect(ports.input).toBe(own.input);
    expect(ports.platform).toBe(own.platform);
    for (const k of PORT_KEYS) expect(ports[k], k).toBeDefined();
    expect(ports.physics).not.toBe(own.physics);
  });

  it('treats an explicit undefined (a JS caller) as missing', () => {
    const ports = withNullPorts({ physics: undefined } as unknown as Partial<KernelPorts>);
    expect(ports.physics.groundY('p', 0, 0)).toBe(null);
  });
});
