import { describe, expect, it } from 'vitest';
import { testWorld } from './world.ts';

const PLAYER = { 'scripts/player.js': {}, 'templates/player.js': { player: { behavior: ['scripts/player.js'], tags: ['player'] } } };

async function setup(changed = true) {
  const w = await testWorld({ modules: PLAYER, ext: { changed } });
  const id = w.k.spawnHuman({ place: 'p1', at: { x: 0, y: 0, z: 0 }, userId: 'u', displayName: 'Op', durableState: { req: { old: true } } });
  const body = w.ctx(id) as any;
  const sim = w.rootSim({});
  return { w, id, body, sim: sim.ctx as any };
}

describe('K4: ctx.changed', () => {
  it('default: throws, as in PP', async () => {
    const { sim } = await setup(false);
    expect(() => sim.changed('world.state.x')).toThrow(/not available/);
  });

  it('a client write is seen once by the sim with path, value and prev; restored state is not a change', async () => {
    const { w, id, body, sim } = await setup();
    const glob = 'place.players.*.state.req';
    expect(sim.changed(glob)).toEqual([]); // baseline: the restored { old: true } is not reported
    body.self.state.req = { cmd: 'a' };
    body.self.state.req = { cmd: 'start' };
    w.ticks(3);
    const rows = sim.changed(glob);
    expect(rows).toEqual([{ path: `place.players.${id}.state.req`, value: { cmd: 'start' }, prev: { old: true } }]);
    expect(rows[0].path.split('.')[2]).toBe(id);
    expect(sim.changed(glob)).toEqual([]); // drained
    body.self.state.req = { cmd: 'start' }; // equal write: no change
    expect(sim.changed(glob)).toEqual([]);
    delete body.self.state.req;
    expect(sim.changed(glob)).toEqual([{ path: `place.players.${id}.state.req`, value: undefined, prev: { cmd: 'start' } }]);
  });

  it('place.state and world.state, including the sim\'s own writes', async () => {
    const { sim } = await setup();
    expect(sim.changed('place.state.bench')).toEqual([]);
    expect(sim.changed('world.state.champions')).toEqual([]);
    sim.place.state.bench = { n: 1 };
    sim.world.state.champions = [{ uid: 'x' }];
    expect(sim.changed('place.state.bench')).toEqual([{ path: 'place.state.bench', value: { n: 1 }, prev: undefined }]);
    expect(sim.changed('world.state.champions')).toHaveLength(1);
    sim.world.state.champions = [{ uid: 'y' }];
    const r = sim.changed('world.state.champions');
    expect(r[0].value).toEqual([{ uid: 'y' }]);
    expect(r[0].prev).toEqual([{ uid: 'x' }]);
  });

  it('cursors are per glob and per ctx; bad input answers []', async () => {
    const { sim, w } = await setup();
    sim.changed('world.state.a');
    sim.changed('world.state.b');
    sim.world.state.a = 1;
    expect(sim.changed('world.state.b')).toEqual([]);
    expect(sim.changed('world.state.a')).toHaveLength(1);
    expect(sim.changed('')).toEqual([]);
    expect(sim.changed(undefined)).toEqual([]);
    expect(sim.changed('nope.state.x')).toEqual([]);
    const other = w.rootSim({}).ctx as any; // replaced root sim has its own cursor
    expect(other.changed('world.state.a')).toEqual([]);
  });
});
