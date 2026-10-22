// Property channels (docs/design/core-runtime.md §5.3, §5.6; docs/architecture.md X-13; motion §3.5.2, §13 #1).
//
// X-13 every-write delivery: `anim`, `mixer` and `ik` are channels registered with `everyWrite` + `sync`, so every assignment
// reaches the owning channel synchronously inside the writer's stack, equal or not (a repeated `once` write restarts the
// viewmodel clip, scripts/player/viewmodel.js:451; the store's equal-write dedupe would otherwise freeze it). Every other field
// keeps the dedupe: an equal write is free, and a deferred channel hears one notification per row and field until its owner
// flushes it.
import { describe, expect, it, vi } from 'vitest';
import { ChannelRegistry } from '../../../src/compat/core/store/channels.ts';
import type { PathSegment, PropChannel, RowRec, VmId } from '../../../src/compat/core/types.ts';
import { storeFixture } from './store-fixture.ts';

type Write = { row: string; value: unknown; prev: unknown; path: readonly PathSegment[] };

function recorder(): { calls: Write[]; onWrite: NonNullable<PropChannel['onWrite']> } {
  const calls: Write[] = [];
  return { calls, onWrite: (row, value, prev, path) => calls.push({ row: row.id, value, prev, path: [...path] }) };
}

describe('X-13: every write of anim / mixer / ik reaches its channel synchronously', () => {
  it('delivers a repeated equal `once` write each time, inside the writer’s stack', () => {
    const f = storeFixture();
    const anim = recorder();
    f.store.channels.register({ field: 'anim', everyWrite: true, sync: true, onWrite: anim.onWrite });
    const gun = f.add({ id: 'player/local/vm', vm: 'client' });
    const h = f.store.handle(gun, 'client') as Record<string, any>;
    const fire = { clip: 'fire', loop: 'once', speed: 1, weight: 1, blendIn: 0.06 };
    // scripts/player/viewmodel.js:472, the same write on three consecutive shots
    for (let shot = 1; shot <= 3; shot++) {
      h.anim.action = fire;
      expect(anim.calls.length, `delivered before the statement after write ${shot}`).toBe(shot);
    }
    expect(anim.calls.map((c) => c.path)).toEqual([['action'], ['action'], ['action']]);
    for (const c of anim.calls) expect(c.value).toEqual(fire);
    expect(anim.calls[0]!.prev).toBe(undefined);
    expect(anim.calls[1]!.prev).toEqual(fire);
    // the store recorded the first write only: equal writes change nothing
    expect(gun.propVer).toBe(1);
  });

  it('delivers a stored copy: the writer mutating its object afterwards does not reach the channel', () => {
    const f = storeFixture();
    const anim = recorder();
    f.store.channels.register({ field: 'anim', everyWrite: true, sync: true, onWrite: anim.onWrite });
    const h = f.store.handle(f.add({ id: 'bot-1' }), 'platform') as Record<string, any>;
    const loco = { clip: 'cdn/clip-walk-loop.glb', loop: 'loop', speed: 1.2, weight: 1, blendIn: 0.18 };
    h.anim.loco = loco;
    loco.speed = 9;
    expect((anim.calls[0]!.value as { speed: number }).speed).toBe(1.2);
  });

  it('delivers channel clears and whole-bag writes: `anim.act = null`, `ik = { ...ik, feet: false }`', () => {
    const f = storeFixture();
    const anim = recorder();
    const ik = recorder();
    f.store.channels.register({ field: 'anim', everyWrite: true, sync: true, onWrite: anim.onWrite });
    f.store.channels.register({ field: 'ik', everyWrite: true, sync: true, onWrite: ik.onWrite });
    const h = f.store.handle(f.add({ id: 'player/local', vm: 'client' }), 'client') as Record<string, any>;
    h.anim.act = { clip: 'cdn/clip-punch.glb', loop: 'once' };
    h.anim.act = null;
    h.anim.act = null;
    // scripts/humanoid-locomotion.js:172 and scripts/bots/runtime.js:455
    h.ik = { ...(h.ik ?? {}), feet: false };
    h.ik = { ...(h.ik ?? {}), feet: false };
    h.ik.rightArm = null;
    expect(anim.calls.map((c) => [c.path, c.value])).toEqual([
      [['act'], { clip: 'cdn/clip-punch.glb', loop: 'once' }],
      [['act'], null],
      [['act'], null],
    ]);
    expect(ik.calls.map((c) => [c.path, c.value])).toEqual([
      [[], { feet: false }],
      [[], { feet: false }],
      [['rightArm'], null],
    ]);
  });

  it('mixer and ik are delivered the same way when registered with everyWrite + sync', () => {
    const f = storeFixture();
    const seen: string[] = [];
    for (const field of ['mixer', 'ik'] as const) {
      f.store.channels.register({ field, everyWrite: true, sync: true, onWrite: (_r, _v, _p, path) => seen.push(`${field}:${path.join('.')}`) });
    }
    const h = f.store.handle(f.add({ id: 'bot-2' }), 'platform') as Record<string, any>;
    h.mixer.sit = { clip: 'sit' };
    h.mixer.sit = { clip: 'sit' };
    h.ik.leftArm = { target: { x: 0, y: 1, z: 0 }, weight: 1, blendIn: 0.12 };
    h.ik.leftArm = { target: { x: 0, y: 1, z: 0 }, weight: 1, blendIn: 0.12 };
    expect(seen).toEqual(['mixer:sit', 'mixer:sit', 'ik:leftArm', 'ik:leftArm']);
  });

  it('a channel read serves the views: reads are fresh snapshots, `anim.walk.speed = 0` does nothing (AGENTS.md:139)', () => {
    const f = storeFixture();
    const anim = recorder();
    const table = new Map<string, Record<string, unknown>>();
    f.store.channels.register({
      field: 'anim',
      everyWrite: true,
      sync: true,
      onWrite: (row, value, prev, path) => {
        anim.onWrite(row, value, prev, path);
        if (path.length === 1 && value && typeof value === 'object') table.set(String(path[0]), { ...(value as object), elapsed: 0.5, duration: 1 });
      },
      read: (_row: RowRec, _vm: VmId | 'ui') => Object.fromEntries([...table].map(([k, v]) => [k, { ...v }])),
    });
    const h = f.store.handle(f.add({ id: 'enemy-1' }), 'platform') as Record<string, any>;
    h.anim.walk = { clip: 'walk', loop: 'loop', speed: 1 };
    expect(h.anim.walk).toEqual({ clip: 'walk', loop: 'loop', speed: 1, elapsed: 0.5, duration: 1 });
    expect(h.anim.walk).not.toBe(h.anim.walk);
    h.anim.walk.speed = 0;
    expect(anim.calls.length).toBe(1);
    expect(h.anim.walk.speed).toBe(1);
    expect(Object.keys(h.anim)).toEqual(['walk']);
    expect(h.anim.run).toBe(undefined);
  });

  it('without a registered channel (headless) the writes still land in the row and read back', () => {
    const f = storeFixture();
    const h = f.store.handle(f.add({ id: 'enemy-2' }), 'platform') as Record<string, any>;
    h.anim.loco = { clip: 'walk', loop: 'loop' };
    h.ik.rightArm = { target: { x: 1, y: 2, z: 3 }, weight: 1 };
    expect(h.anim.loco).toEqual({ clip: 'walk', loop: 'loop' });
    expect(h.ik).toEqual({ rightArm: { target: { x: 1, y: 2, z: 3 }, weight: 1 } });
  });

  it('without a channel read, anim / mixer / ik reads are still fresh snapshots: a nested write through one does nothing', () => {
    const f = storeFixture();
    const anim = recorder();
    // a channel that only listens (no `read`): the store serves the reads from the row
    f.store.channels.register({ field: 'anim', everyWrite: true, sync: true, onWrite: anim.onWrite });
    const row = f.add({ id: 'enemy-5' });
    const h = f.store.handle(row, 'platform') as Record<string, any>;
    h.anim.walk = { clip: 'walk', loop: 'loop', speed: 1 };
    h.mixer.sit = { clip: 'sit' };
    h.ik.leftArm = { target: { x: 0, y: 1, z: 0 }, weight: 1 };
    // AGENTS.md:139: "Setting `.speed = 0` on the live channel does nothing"
    h.anim.walk.speed = 0;
    h.mixer.sit.clip = 'stand';
    h.ik.leftArm.target.y = 9;
    delete h.anim.walk.loop;
    expect(h.anim.walk).not.toBe(h.anim.walk);
    expect(row.props.anim).toEqual({ walk: { clip: 'walk', loop: 'loop', speed: 1 } });
    expect(row.props.mixer).toEqual({ sit: { clip: 'sit' } });
    expect(row.props.ik).toEqual({ leftArm: { target: { x: 0, y: 1, z: 0 }, weight: 1 } });
    expect(anim.calls.length).toBe(1);
    // top-level keys of the bag still write (scripts/bots/runtime.js `ik.rightArm = null`)
    h.ik.leftArm = null;
    expect(row.props.ik).toEqual({ leftArm: null });
  });

  it('a sync channel that throws never breaks the writer', () => {
    const f = storeFixture();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.store.channels.register({
      field: 'anim',
      everyWrite: true,
      sync: true,
      onWrite: () => {
        throw new Error('mixer bug');
      },
    });
    const row = f.add({ id: 'enemy-3' });
    const h = f.store.handle(row, 'platform') as Record<string, any>;
    expect(() => (h.anim.act = { clip: 'roar' })).not.toThrow();
    expect(row.props.anim).toEqual({ act: { clip: 'roar' } });
    expect(f.store.channels.errors).toBe(1);
    err.mockRestore();
  });

  it('unregistering stops delivery', () => {
    const f = storeFixture();
    const anim = recorder();
    const off = f.store.channels.register({ field: 'anim', everyWrite: true, sync: true, onWrite: anim.onWrite });
    const h = f.store.handle(f.add({ id: 'enemy-4' }), 'platform') as Record<string, any>;
    h.anim.act = { clip: 'a' };
    off();
    off();
    h.anim.act = { clip: 'b' };
    expect(anim.calls.length).toBe(1);
  });
});

describe('fields without everyWrite keep the dedupe', () => {
  it('an equal write is free: no notification, no version bump, no change record', () => {
    const f = storeFixture();
    const light = recorder();
    f.store.channels.register({ field: 'light', sync: true, onWrite: light.onWrite });
    const row = f.add({ id: 'gf-lamp-1', props: { light: { kind: 'point', intensity: 2 } } });
    const h = f.store.handle(row, 'platform') as Record<string, any>;
    h.light = { kind: 'point', intensity: 2 };
    expect(light.calls.length).toBe(0);
    expect(row.propVer).toBe(0);
    expect(f.store.takeChanges()).toEqual([]);
    h.light = { ...h.light, intensity: 1 };
    expect(light.calls.length).toBe(1);
    expect(row.propVer).toBe(1);
  });

  it('a deferred channel hears one notification per row and field per flush, in first-write order, with the value before the first write', () => {
    const f = storeFixture();
    const phys = recorder();
    f.store.channels.register({ field: 'physics', onWrite: phys.onWrite });
    const a = f.add({ id: 'door-a', props: { physics: 'kinematic' } });
    const b = f.add({ id: 'door-b', props: { physics: 'kinematic' } });
    const ha = f.store.handle(a, 'platform') as Record<string, any>;
    const hb = f.store.handle(b, 'platform') as Record<string, any>;
    hb.physics = 'static';
    ha.physics = { body: 'dynamic', mass: 2 };
    ha.physics.mass = 3;
    hb.physics = 'kinematic';
    expect(phys.calls).toEqual([]);
    expect(f.store.channels.pending).toBe(2);
    expect(f.store.channels.flush(['physics'])).toBe(2);
    expect(phys.calls).toEqual([
      { row: 'door-b', value: 'kinematic', prev: 'kinematic', path: [] },
      { row: 'door-a', value: { body: 'dynamic', mass: 3 }, prev: 'kinematic', path: [] },
    ]);
    expect(f.store.channels.flush()).toBe(0);
    ha.physics.mass = 4;
    f.store.channels.flush();
    expect(phys.calls[2]).toEqual({ row: 'door-a', value: { body: 'dynamic', mass: 4 }, prev: { body: 'dynamic', mass: 3 }, path: ['mass'] });
  });

  it('flush(fields) delivers only those fields and keeps the rest queued; a destroyed row’s queue is dropped', () => {
    const f = storeFixture();
    const audio = recorder();
    const light = recorder();
    f.store.channels.register({ field: 'audio', onWrite: audio.onWrite });
    f.store.channels.register({ field: 'light', onWrite: light.onWrite });
    const bed = f.add({ id: 'music/bed', props: { audio: { clip: 'a', gain: 0 } } });
    const lamp = f.add({ id: 'lamp', props: { light: { intensity: 1 } } });
    (f.store.handle(bed, 'client') as Record<string, any>).audio.gain = 0.5;
    (f.store.handle(lamp, 'platform') as Record<string, any>).light.intensity = 0;
    expect(f.store.channels.flush(['audio'])).toBe(1);
    expect(audio.calls.length).toBe(1);
    expect(light.calls.length).toBe(0);
    f.store.detach('lamp');
    expect(f.store.channels.flush()).toBe(0);
    expect(light.calls.length).toBe(0);
  });

  it('an everyWrite channel that is not sync queues every write until the flush', () => {
    const f = storeFixture();
    const anim = recorder();
    f.store.channels.register({ field: 'anim', everyWrite: true, onWrite: anim.onWrite });
    const h = f.store.handle(f.add({ id: 'e' }), 'platform') as Record<string, any>;
    h.anim.act = { clip: 'x' };
    h.anim.act = { clip: 'x' };
    expect(anim.calls.length).toBe(0);
    expect(f.store.channels.flush()).toBe(2);
    expect(anim.calls.map((c) => c.path)).toEqual([['act'], ['act']]);
  });
});

describe('ChannelRegistry rules', () => {
  it('one derived read per field', () => {
    const reg = new ChannelRegistry(() => undefined);
    reg.register({ field: 'anim', read: () => ({}) });
    expect(() => reg.register({ field: 'anim', read: () => ({}) })).toThrow(/one channel may serve reads/);
    expect(() => reg.register({ field: '' })).toThrow(TypeError);
  });

  it('reports which fields bypass the equal-write dedupe', () => {
    const reg = new ChannelRegistry(() => undefined);
    expect(reg.hasEveryWrite('anim')).toBe(false);
    const off = reg.register({ field: 'anim', everyWrite: true, sync: true, onWrite: () => {} });
    reg.register({ field: 'light', onWrite: () => {} });
    expect(reg.hasEveryWrite('anim')).toBe(true);
    expect(reg.hasEveryWrite('light')).toBe(false);
    off();
    expect(reg.hasEveryWrite('anim')).toBe(false);
  });
});
