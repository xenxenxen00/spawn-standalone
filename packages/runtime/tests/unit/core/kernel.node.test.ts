// Kernel skeleton (docs/design/core-runtime.md §3.7, §20 C0; docs/architecture.md §3.0, §9.3 C0): the composition root with
// what C0 can wire (ports with null defaults, the injected registry, world state, metrics, KernelEvents, sendAction, the room
// RNG, rules); every member a later package wires fails loudly and names its module.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KernelNotWiredError,
  createKernel,
  createKernelMetrics,
  createRoomRng,
  type KernelOptions,
} from '../../../src/compat/core/kernel.ts';
import { createNullPorts } from '../../../src/compat/core/null-ports.ts';
import { ENGINE_RULES } from '../../../src/compat/core/rules.ts';
import { RowStoreImpl } from '../../../src/compat/core/store/rows.ts';
import type { CompiledPlaceIndex, ModuleRegistry, ObjectSpec, RowRec, WorldConfig } from '../../../src/compat/core/types.ts';

const registry: ModuleRegistry = {
  knows: () => false,
  get: () => undefined,
  template: (ref: string): Readonly<ObjectSpec> => {
    throw Object.assign(new Error(`spawn refused: template not loaded: ${ref}`), { name: 'SpawnRefused' });
  },
  ensure: async () => {},
  load: async (path: string) => {
    throw new Error(`unknown module ${path}`);
  },
  lateBinds: 0,
};
const worldConfig: WorldConfig = { defaultPlace: 'gallow-farm', player: 'templates/player.js#player', camera: 'templates/camera.js#camera', inputs: {} };
const places: CompiledPlaceIndex = { placeIndex: {}, places: {} };
const options = (extra: Partial<KernelOptions> = {}): KernelOptions => ({ seed: 7, ports: {}, worldConfig, places, registry, ...extra });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createKernel: an empty kernel', () => {
  it('fills missing ports with null implementations and keeps the given ones', () => {
    const own = createNullPorts();
    const k = createKernel(options({ ports: { input: own.input } }));
    expect(k.ports.input).toBe(own.input);
    for (const key of ['physics', 'motion', 'scene', 'attach', 'input', 'camera', 'assets', 'ui', 'platform'] as const) {
      expect(k.ports[key], key).toBeDefined();
    }
    expect(k.ports.physics.groundY('gallow-farm', 0, 0)).toBe(null);
  });

  it('holds the injected registry, the options and a fresh world state per kernel', () => {
    const a = createKernel(options());
    const b = createKernel(options());
    expect(a.registry).toBe(registry);
    expect(a.worldConfig).toBe(worldConfig);
    expect(a.placeIndex).toBe(places);
    expect(a.seed).toBe(7);
    expect(a.dev).toBe(false);
    expect(createKernel(options({ dev: true })).dev).toBe(true);
    expect(a.worldState).toEqual({});
    a.worldState['ss'] = { phase: 'LOBBY' };
    expect(b.worldState).toEqual({});
  });

  it('starts every metric at zero, per kernel', () => {
    const k = createKernel(options());
    expect(k.metrics).toEqual(createKernelMetrics());
    for (const [name, v] of Object.entries(k.metrics)) expect(v, name).toBe(0);
    k.metrics.droppedTicks++;
    expect(createKernel(options()).metrics.droppedTicks).toBe(0);
  });

  it('takes ENGINE_RULES with per-kernel overrides', () => {
    expect(createKernel(options()).rules).toEqual(ENGINE_RULES);
    expect(createKernel(options({ rules: { spawnerOwnership: 'off' } })).rules.spawnerOwnership).toBe('off');
    expect(ENGINE_RULES.spawnerOwnership).toBe('cascade');
  });

  it('takes a uint32 seed and refuses anything else (the room RNG reads 32 bits, so other values would collide)', () => {
    for (const seed of [0, 1, 0xffffffff, Date.now() >>> 0]) expect(createKernel(options({ seed })).seed).toBe(seed);
    for (const seed of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, 2 ** 32, '1' as unknown as number]) {
      expect(() => createKernel(options({ seed })), String(seed)).toThrow(TypeError);
    }
  });
});

describe('KernelEvents: on / notify', () => {
  const rec = { id: 'player/local' } as RowRec;

  it('delivers to every subscriber in subscription order with the arguments', () => {
    const k = createKernel(options());
    const seen: string[] = [];
    k.on('placeActive', (p, prev) => seen.push(`a:${p}:${prev}`));
    k.on('placeActive', (p) => seen.push(`b:${p}`));
    k.on('tickEnd', (t) => seen.push(`tick:${t}`));
    k.notify('placeActive', 'gallow-farm', null);
    k.notify('tickEnd', 3);
    expect(seen).toEqual(['a:gallow-farm:null', 'b:gallow-farm', 'tick:3']);
  });

  it('unsubscribes for real, idempotently', () => {
    const k = createKernel(options());
    const fn = vi.fn();
    const off = k.on('rowSpawned', fn);
    k.notify('rowSpawned', rec);
    off();
    off();
    k.notify('rowSpawned', rec);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(rec);
  });

  it('keeps one subscription per function, and a stale unsubscribe never removes a later subscription', () => {
    const k = createKernel(options());
    const fn = vi.fn();
    const offA = k.on('tickEnd', fn);
    const offB = k.on('tickEnd', fn);
    k.notify('tickEnd', 1);
    expect(fn).toHaveBeenCalledTimes(1);
    offB();
    k.notify('tickEnd', 2);
    expect(fn).toHaveBeenCalledTimes(1);
    const offC = k.on('tickEnd', fn);
    offA();
    offB();
    k.notify('tickEnd', 3);
    expect(fn).toHaveBeenCalledTimes(2);
    offC();
    k.notify('tickEnd', 4);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('delivers one notification to the subscribers present when it starts', () => {
    const k = createKernel(options());
    const late = vi.fn();
    const second = vi.fn();
    let offSecond = (): void => {};
    k.on('placeBuilt', () => {
      k.on('placeBuilt', late);
      offSecond();
    });
    offSecond = k.on('placeBuilt', second);
    k.notify('placeBuilt', 'p');
    expect(late).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    k.notify('placeBuilt', 'p');
    expect(late).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('keeps delivering when a subscriber throws, and counts and reports it', () => {
    const k = createKernel(options());
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    k.on('paused', () => {
      throw new Error('boom');
    });
    k.on('paused', after);
    k.notify('paused', true, new Set(['boot']));
    expect(after).toHaveBeenCalledWith(true, new Set(['boot']));
    expect(k.metrics.listenerErrors).toBe(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(String(report.mock.calls[0]?.[0])).toContain('paused');
  });
});

describe('sendAction (X-15: forwarded to the input port)', () => {
  it('hands name, payload and options to ports.input.injectAction', () => {
    const own = createNullPorts();
    const inject = vi.spyOn(own.input, 'injectAction');
    const k = createKernel(options({ ports: { input: own.input } }));
    k.sendAction('ss_req', { op: 'ready', slot: 0 }, { relockPointer: true });
    k.sendAction('ss_seen');
    expect(inject.mock.calls).toEqual([
      ['ss_req', { op: 'ready', slot: 0 }, { relockPointer: true }],
      ['ss_seen', undefined, undefined],
    ]);
  });
});

describe('kernel.store (WP C1a)', () => {
  it('is a row store per kernel over the kernel’s ports and dev flag', () => {
    const own = createNullPorts();
    const k = createKernel(options({ ports: { physics: own.physics }, dev: true }));
    expect(k.store).toBeInstanceOf(RowStoreImpl);
    expect(k.store).toBe(k.store);
    expect(k.store.ports).toBe(k.ports);
    expect(k.store.ports.physics).toBe(own.physics);
    expect(k.store.dev).toBe(true);
    expect(k.store.count).toBe(0);
    expect(createKernel(options()).store).not.toBe(k.store);
  });
});

describe('the room RNG (core §7.1, contract §5.12)', () => {
  it('is deterministic per seed, in [0, 1), and differs between seeds', () => {
    const a = createRoomRng(42);
    const b = createRoomRng(42);
    const seqA = Array.from({ length: 2000 }, () => a());
    expect(Array.from({ length: 2000 }, () => b())).toEqual(seqA);
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
    const c = createRoomRng(43);
    expect(Array.from({ length: 8 }, () => c())).not.toEqual(seqA.slice(0, 8));
  });

  it('is roughly uniform', () => {
    const r = createRoomRng(7);
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 20000; i++) buckets[Math.floor(r() * 10)]!++;
    for (const n of buckets) expect(n).toBeGreaterThan(1800);
    for (const n of buckets) expect(n).toBeLessThan(2200);
  });

  it('is the kernel stream behind rng(), seeded from KernelOptions.seed', () => {
    const k1 = createKernel(options({ seed: 99 }));
    const k2 = createKernel(options({ seed: 99 }));
    const ref = createRoomRng(99);
    const s1 = [k1.rng(), k1.rng(), k1.rng()];
    expect([k2.rng(), k2.rng(), k2.rng()]).toEqual(s1);
    expect([ref(), ref(), ref()]).toEqual(s1);
  });
});

describe('members wired by later packages', () => {
  // clock, bus, feed, acts, advance, runTicks: wired by WP C2 (tests/unit/core/kernel-time.node.test.ts)
  // places: wired by WP C4 (tests/unit/core/places.node.test.ts)
  // spawnHuman: wired by WP C1b (tests/unit/core/lifecycle.node.test.ts)
  // vms, stepRig, createUiCtx: wired by WP C5 (tests/unit/core/vm-machine, ctx-rig, ui-ctx .node.test.ts)
  it('vms, stepRig and createUiCtx answer on an empty kernel', () => {
    const k = createKernel(options());
    expect(Object.keys(k.vms).sort()).toEqual(['client', 'platform']);
    expect(k.stepRig(1 / 60, createNullPorts().input.sampleRig())).toEqual({ wrote: new Set(), deleted: new Set() });
    expect(k.createUiCtx().kind).toBe('ui');
  });

  it('a member that is not wired names its module and package (KernelNotWiredError; test kernels shadow `places` with it)', () => {
    const err = new KernelNotWiredError('places', 'places/manager.ts', 'C4');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('KernelNotWiredError');
    expect(err.member).toBe('places');
    expect(err.message).toContain('kernel.places');
    expect(err.message).toContain('src/compat/core/places/manager.ts (WP C4)');
  });
});
