// action-sink (io §4.5, §3.6; core §9.8, §15.7; X-15): sendAction routing and the kernel's InputPort over InputLog + ActionSink.
import { describe, expect, it } from 'vitest';
import type { InputPort } from '../../../src/compat/core/ports.ts';
import { ActionSink, InputPortImpl, createInputPort } from '../../../src/runtime/input/action-sink.ts';
import { InputLog } from '../../../src/runtime/input/input-log.ts';
import { createKernel } from '../../../src/compat/core/kernel.ts';
import type { InputsDef, ModuleRegistry, WorldConfig } from '../../../src/compat/core/types.ts';

const MAP: InputsDef = {
  actions: { ss_req: {}, ss_ui: {}, ss_prefs: {}, ss_seen: {}, fire: { mouse: 'left' }, jump: { keys: ['space'] } },
  axes: { moveX: { keys: 'a/d' } },
};

function rig(): { sink: ActionSink; log: InputLog; locks: string[] } {
  const log = new InputLog({ map: MAP });
  const locks: string[] = [];
  const sink = new ActionSink(log, { requestLock: (o) => void locks.push(o) });
  return { sink, log, locks };
}

describe('ActionSink', () => {
  it('routes every data channel into the log; undeclared names are dropped silently', () => {
    const { sink, log } = rig();
    for (const c of ['ss_req', 'ss_ui', 'ss_prefs', 'ss_seen']) expect(sink.inject(c, { c }), c).toBe(true);
    expect(sink.inject('ghost', {})).toBe(false);
    const s = log.deliver('body');
    expect(Object.keys(s.actionData!).sort()).toEqual(['ss_prefs', 'ss_req', 'ss_seen', 'ss_ui']);
    expect(s.pressed['ghost']).toBeUndefined();
  });

  it('relockPointer requests the lock synchronously (inside the click gesture), origin ui', () => {
    const { sink, locks } = rig();
    sink.inject('ss_ui', { panel: null }, { relockPointer: true });
    expect(locks).toEqual(['ui']);
    sink.inject('ss_ui', { panel: null });
    expect(locks).toEqual(['ui']);
  });

  it('{down} sets and clears a held level as if a key', () => {
    const { sink, log } = rig();
    sink.inject('fire', undefined, { down: true });
    expect(log.deliver('body').held['fire']).toBe(true);
    sink.inject('fire', undefined, { down: false });
    expect(log.deliver('body').released['fire']).toBe(true);
  });

  it('works without a pointer-lock manager', () => {
    const log = new InputLog({ map: MAP });
    const sink = new ActionSink(log);
    expect(sink.inject('ss_req', { op: 'x' }, { relockPointer: true })).toBe(true);
  });
});

describe('InputPortImpl (the kernel InputPort, core §15.7)', () => {
  it('implements InputPort: body = sampleTick, rig = sampleRig, injectAction through the sink', () => {
    const { sink, log } = rig();
    const port: InputPort = new InputPortImpl(log, sink);
    expect(port.declared).toEqual(MAP);
    expect(port.injectAction('ss_req', { op: 'buy' })).toBe(true);
    expect(port.injectAction('nope', {})).toBe(false);
    log.push({ type: 'button', control: 'Space', down: true });
    const t = port.sampleTick();
    expect(t.pressed).toEqual({ ss_req: true, jump: true });
    expect(port.sampleTick().pressed).toEqual({});
    expect(port.sampleRig().pressed).toEqual({ ss_req: true, jump: true });
  });

  it('setBlocked / discardEdges reach the log', () => {
    const { sink, log } = rig();
    const port = new InputPortImpl(log, sink);
    port.setBlocked('body', true);
    log.push({ type: 'button', control: 'Space', down: true });
    port.injectAction('ss_req', { op: 'spectate', dir: 1 });
    expect(port.sampleTick().pressed).toEqual({ ss_req: true });
    port.setBlocked('body', false);
    log.push({ type: 'button', control: 'Space', down: false });
    log.push({ type: 'button', control: 'Space', down: true });
    port.discardEdges();
    expect(port.sampleTick().pressed).toEqual({});
  });

  it('declared follows a rebinding of the log', () => {
    const { sink, log } = rig();
    const port = new InputPortImpl(log, sink);
    log.setMap({ actions: { ...MAP.actions, jump: { keys: ['j'] } }, axes: MAP.axes! });
    expect(port.declared.actions!['jump']).toEqual({ keys: ['j'] });
  });

  it('kernel.sendAction reaches the body delivery through this port (X-15)', () => {
    const io = createInputPort({ map: MAP });
    const registry: ModuleRegistry = {
      knows: () => false,
      get: () => undefined,
      template: () => {
        throw new Error('no templates');
      },
      ensure: async () => {},
      load: async () => {
        throw new Error('no modules');
      },
      lateBinds: 0,
    };
    const worldConfig: WorldConfig = { defaultPlace: 'gallow-farm', player: 'templates/player.js#player', camera: 'templates/camera.js#camera', inputs: MAP };
    const k = createKernel({ seed: 1, ports: { input: io.port }, worldConfig, places: { placeIndex: {}, places: {} }, registry });
    k.sendAction('ss_req', { op: 'buy', item: 'x' });
    k.sendAction('lastshot', {});
    const s = k.ports.input.sampleTick();
    expect(s.pressed).toEqual({ ss_req: true });
    expect(s.actionData).toEqual({ ss_req: { op: 'buy', item: 'x' } });
  });

  it('createInputPort wires a log, a sink and the port over one map', () => {
    const io = createInputPort({ map: MAP });
    expect(io.port.declared).toEqual(MAP);
    io.port.injectAction('ss_seen', { key: 'welcome' });
    expect(io.log.deliver('body').actionData).toEqual({ ss_seen: { key: 'welcome' } });
    expect(io.sink).toBeInstanceOf(ActionSink);
  });
});
