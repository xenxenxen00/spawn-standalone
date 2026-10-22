// The two virtual machines (docs/design/core-runtime.md §10, D-CORE-01; docs/architecture.md X-24): the VM objects, their
// session bags, the assignment rule lifecycle.ts places rows with, the cross-VM counters, and X-24 through the real ctx.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HUMAN_BODY_ID } from '../../../src/compat/core/ids.ts';
import { createNullPorts } from '../../../src/compat/core/null-ports.ts';
import { createVms, VirtualMachineImpl, VM_IDS, vmForSpawn } from '../../../src/compat/core/vm/machine.ts';
import type { VmId } from '../../../src/compat/core/types.ts';
import { ctxWorld, PLAYER_MODULES, type CtxWorld } from './fakes/ctx-world.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const BOT = 'scripts/bots/bot.js';
const TERMINAL = 'scripts/map/terminal.js';
const GORE = 'scripts/gore/gore.js';

async function scene(): Promise<CtxWorld> {
  const w = await ctxWorld({ modules: { ...PLAYER_MODULES, [BOT]: {}, [TERMINAL]: {}, [GORE]: {}, 'scripts/camera.js': {} } });
  w.human('p1');
  w.rig('scripts/camera.js');
  w.spawn('bot-1', { behavior: BOT, simulatedBy: 'platform', place: 'p1' });
  w.spawn('bot-2', { behavior: BOT, simulatedBy: 'platform', place: 'p1' });
  for (const n of [1, 2, 3, 4]) w.spawn(`term-${n}`, { behavior: TERMINAL, place: 'p1' }, { fromScene: { place: 'p1', cell: 'x0z0' } });
  return w;
}

describe('the VM objects', () => {
  it('a kernel has a platform and a client VM, each with its own session, counters and physics world handle', async () => {
    const world = { kind: 'the one world' };
    const ports = createNullPorts();
    const w = await ctxWorld({ modules: {}, ports: { ...ports, physics: { ...ports.physics, vmWorlds: { platform: world, client: world } } } });
    const { platform, client } = w.k.vms;
    expect(VM_IDS).toEqual(['platform', 'client']);
    expect([platform.id, client.id]).toEqual(['platform', 'client']);
    expect(platform).toBeInstanceOf(VirtualMachineImpl);
    expect(platform.session).toEqual({});
    expect(platform.session).not.toBe(client.session);
    expect(platform.counters).toEqual({ crossVmWrites: 0, crossVmReads: 0 });
    expect(platform.counters).not.toBe(client.counters);
    // both handles point at the same world in v1 (motion §5.1); the slot is the VM's own
    expect(platform.physicsWorld).toBe(world);
    expect(client.physicsWorld).toBe(world);
    client.physicsWorld = null;
    expect(platform.physicsWorld).toBe(world);
    expect(Object.isFrozen(w.k.vms)).toBe(true);
    const bare = createVms();
    expect(bare.platform.physicsWorld).toBeNull();
    expect(bare.client.session).not.toBe(bare.platform.session);
  });

  it('ctx.session is the VM\'s: one bag for every platform ctx, one for the body, its local rows and the rig', async () => {
    const w = await scene();
    const body = w.ctx(HUMAN_BODY_ID);
    const gib = w.ctx(body.spawn({ behavior: GORE, tags: ['gib'] }));
    const platform = [w.ctx('bot-1'), w.ctx('bot-2'), w.ctx('term-1'), w.ctx('term-4'), w.simCtx(null), w.simCtx('p2')];
    const client = [body, gib, w.rigCtx()];
    for (const ctx of platform) expect(ctx.session).toBe(w.k.vms.platform.session);
    for (const ctx of client) expect(ctx.session).toBe(w.k.vms.client.session);
    // scripts/map/terminal.js:17-18: one `__termShown` flag for the four terminals of a map
    w.ctx('term-1').session['__termShown'] = true;
    expect(w.ctx('term-3').session['__termShown']).toBe(true);
    expect(body.session['__termShown']).toBeUndefined();
    // the body's bags (`ss` per body, `ssClk`) are the rig's too, and not the bots'
    body.session['ss'] = { [HUMAN_BODY_ID]: { cam: {} } };
    expect(w.rigCtx().session['ss']).toBe(body.session['ss']);
    expect(w.ctx('bot-1').session['ss']).toBeUndefined();
    w.ctx('bot-1').session['ssBot'] = { shared: true };
    expect(w.ctx('bot-2').session['ssBot']).toEqual({ shared: true });
  });
});

describe('vmForSpawn: the assignment rule of core §10.2', () => {
  it('the table', () => {
    const cases: Array<[Parameters<typeof vmForSpawn>[0], VmId]> = [
      [{ simulatedBy: 'platform', spawnerVm: 'client' }, 'platform'],
      [{ simulatedBy: 'platform', spawnerVm: null }, 'platform'],
      [{ simulatedBy: null, spawnerVm: 'client' }, 'client'],
      [{ simulatedBy: null, spawnerVm: 'platform' }, 'platform'],
      [{ spawnerVm: null }, 'platform'], // a sim, a scene row, the kernel
      [{}, 'platform'],
      [{ forced: 'client' }, 'client'], // the human body, the camera rig
      [{ forced: 'client', simulatedBy: 'platform' }, 'client'],
      [{ forced: 'platform', spawnerVm: 'client' }, 'platform'],
    ];
    for (const [input, vm] of cases) expect(vmForSpawn(input), JSON.stringify(input)).toBe(vm);
  });

  it('is what the lifecycle places every row with', async () => {
    const w = await scene();
    const body = w.ctx(HUMAN_BODY_ID);
    const bot = w.ctx('bot-1');
    const rows: Array<[string, VmId]> = [
      [HUMAN_BODY_ID, 'client'],
      ['camera/local', 'client'],
      ['bot-1', 'platform'],
      ['term-1', 'platform'], // a scene row
      [w.simCtx(null).spawn({ tags: ['enemy'] }), 'platform'], // spawned by a sim
      [w.simCtx('p2').spawn({ tags: ['roamer'] }), 'platform'],
      [body.spawn({ tags: ['corpse'] }), 'client'], // spawned by the body: gore, corpses, viewmodel, ordnance, trail
      [body.spawn({ tags: ['hazard'], simulatedBy: 'platform' }), 'platform'],
      [bot.spawn({ tags: ['held'] }), 'platform'], // a bot's held weapon
      [body.spawn({ parent: 'bot-1', tags: ['probe'], audience: 'local' }), 'client'], // a probe on a platform enemy stays a client row
    ];
    for (const [id, vm] of rows) expect(w.row(id).vm, id).toBe(vm);
    // children take their parent's VM unless they say `simulatedBy: "platform"`
    const tree = body.spawn('vm-tree', { tags: ['t'], children: [{ id: 'a' }, { id: 'b', simulatedBy: 'platform', children: [{ id: 'c' }] }] });
    expect([tree, 'vm-tree/a', 'vm-tree/b', 'vm-tree/b/c'].map((id) => w.row(id).vm)).toEqual(['client', 'client', 'platform', 'platform']);
  });
});

describe('cross-VM counters (core §10.4)', () => {
  it('a write through another VM\'s handle counts on the WRITER\'s VM, with the field name', async () => {
    const w = await scene();
    const sim = w.simCtx(null);
    const body = w.ctx(HUMAN_BODY_ID);
    const { platform, client } = w.k.vms;
    // the Director writes `spectating` and `state.*` on the human's player row
    const row = sim.world.players[0]!;
    row.spectating = true;
    row.state['live'] = { alive: false };
    (row.state['live'] as { alive: boolean }).alive = true;
    row.feetPosition = { x: 1, y: 0, z: 1 };
    expect(platform.counters.crossVmWrites).toBe(4);
    expect([...platform.crossVmWriteFields].sort()).toEqual([['feetPosition', 1], ['spectating', 1], ['state', 2]]);
    expect(client.counters.crossVmWrites).toBe(0);
    // the body writes on a bot (a hit landing as state)
    body.getObject('bot-1')!.state['stagger'] = 1;
    expect(client.counters.crossVmWrites).toBe(1);
    expect([...client.crossVmWriteFields]).toEqual([['state', 1]]);
    // own-VM writes and equal writes count nothing
    body.self.state['hp'] = 1;
    sim.getObject('bot-1')!.state['x'] = 1;
    row.spectating = true;
    expect(platform.counters.crossVmWrites).toBe(4);
    expect(client.counters.crossVmWrites).toBe(1);
    expect(w.k.store.counters.crossVmWrites).toBe(5);
  });

  it('a getObject that hands out a row of the other VM counts as a cross-VM read on the reader\'s VM', async () => {
    const w = await scene();
    const { platform, client } = w.k.vms;
    const body = w.ctx(HUMAN_BODY_ID);
    body.getObject('bot-1');
    body.getObject('bot-2');
    body.getObject(HUMAN_BODY_ID);
    body.getObject('missing');
    expect(client.counters.crossVmReads).toBe(2);
    w.simCtx(null).getObject(HUMAN_BODY_ID);
    w.ctx('bot-1').getObject('bot-2');
    expect(platform.counters.crossVmReads).toBe(1);
    w.k.createUiCtx().getObject('bot-1'); // the UI realm is not a VM
    expect(client.counters.crossVmReads).toBe(2);
  });

  it('dev builds also count the rows of the other VM a query returns', async () => {
    const dev = await ctxWorld({ dev: true, modules: { ...PLAYER_MODULES, [BOT]: {} } });
    dev.human('p1');
    for (const n of [1, 2, 3]) dev.spawn(`bot-${n}`, { behavior: BOT, simulatedBy: 'platform', place: 'p1', tags: ['teammate'] });
    dev.ctx(HUMAN_BODY_ID).query({ tags: ['teammate'] });
    expect(dev.k.vms.client.counters.crossVmReads).toBe(3);
    dev.ctx(HUMAN_BODY_ID).query({ tags: ['teammate'], select: 'ids' });
    expect(dev.k.vms.client.counters.crossVmReads).toBe(3);
  });
});

describe('X-24 through the real ctx factories', () => {
  it('the body\'s local probes on a platform enemy: visible to the body and the UI, invisible to bots and the Director', async () => {
    const w = await scene();
    w.simCtx(null).spawn('z1', { tags: ['enemy'], simulatedBy: 'platform', feetPosition: { x: 5, y: 0, z: 0 } });
    const body = w.ctx(HUMAN_BODY_ID);
    const bot = w.ctx('bot-1');
    for (const bone of ['Head', 'Spine']) body.spawn(`bp-${bone}`, { parent: 'z1', audience: 'local', scope: 'session', tags: ['probe'], attachment: { bone }, visible: false });
    const ids = (list: Array<{ id: string }>): string[] => list.map((o) => o.id);
    expect(ids(body.getObject('z1')!.children)).toEqual(['z1/bp-Head', 'z1/bp-Spine']);
    expect(ids(body.query({ tags: ['probe'] }))).toEqual(['z1/bp-Head', 'z1/bp-Spine']);
    expect(body.getObject('z1/bp-Head')).not.toBeNull();
    for (const platform of [bot, w.simCtx(null)]) {
      expect(platform.getObject('z1/bp-Head')).toBeNull();
      expect(platform.getObject('z1')!.children).toEqual([]);
      expect(platform.query({ tags: ['probe'], place: 'p1' })).toEqual([]);
      expect(platform.query({ tags: ['probe'], place: 'p1', select: 'ids' })).toEqual([]);
    }
    expect(w.k.createUiCtx().getObject('z1/bp-Spine')).not.toBeNull();
    // a local row made on the platform VM is an ordinary row for it
    const own = bot.spawn({ audience: 'local', tags: ['probe'] });
    expect(bot.getObject(own)).not.toBeNull();
    expect(w.row(own).vm).toBe('platform');
    // the enemy dies: the cascade takes the body's probes with it
    w.simCtx(null).destroy('z1');
    expect(body.getObject('z1/bp-Head')).toBeNull();
  });
});
