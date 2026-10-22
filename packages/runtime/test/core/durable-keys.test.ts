import { describe, expect, it } from 'vitest';
import { createMemorySaveStore } from '../../src/compat/core/null-ports.ts';
import { DurableState } from '../../src/compat/core/save/durable.ts';
import { testWorld } from './world.ts';

const PLAYER = { 'scripts/player.js': {}, 'templates/player.js': { player: { behavior: ['scripts/player.js'], tags: ['player'] } } };
const PIP = ['best', 'unlocked', 'skin', 'disc', 'bestTree', 'settings', 'bestPerfects', 'fireflies'];

async function bound(store: ReturnType<typeof createMemorySaveStore>, opts: ConstructorParameters<typeof DurableState>[1], state?: object) {
  const w = await testWorld({ modules: PLAYER });
  const d = new DurableState(store, { debounceMs: 5, ...opts });
  await d.load();
  const id = w.k.spawnHuman({ place: 'p1', at: { x: 0, y: 0, z: 0 }, userId: 'u', displayName: 'Op', durableState: state ?? d.initialBodyState() });
  d.bindBody(w.k.store.get(id)!, w.k.store);
  const st = (w.ctx(id) as unknown as { self: { state: Record<string, unknown> } }).self.state;
  return { w, d, row: w.k.store.get(id)!, st };
}

describe('G3: configurable durable keys', () => {
  it('default saves every game key under ps without game-specific migrations', async () => {
    const store = createMemorySaveStore();
    const { d, st } = await bound(store, {});
    st['prog'] = { xp: 3 };
    st['best'] = 9;
    await d.flush('manual');
    const doc = JSON.parse(store.get('ss_save_v1')!);
    expect(doc.ps.prog).toEqual({ xp: 3 });
    expect(doc.ps.best).toBe(9);
    expect(doc.prog).toBeUndefined();
  });

  it('explicit key list: round trip under the game key, other keys absent, template merge unaffected', async () => {
    const store = createMemorySaveStore();
    const a = await bound(store, { key: 'pip_save', backupKey: 'pip_bad', durableKeys: PIP });
    a.st['best'] = 1234;
    a.st['unlocked'] = ['a', 'b'];
    a.st['settings'] = { vol: 0.5 };
    a.st['qa'] = true;
    a.st['dbg'] = 1;
    await a.d.flush('manual');
    expect(store.get('ss_save_v1')).toBeNull();
    const doc = JSON.parse(store.get('pip_save')!);
    expect(doc.ps).toEqual({ best: 1234, unlocked: ['a', 'b'], settings: { vol: 0.5 } });
    expect(doc.settings).toEqual({});
    // reload
    const b = await bound(store, { key: 'pip_save', durableKeys: PIP });
    expect(b.row.state['best']).toBe(1234);
    expect(b.row.state['settings']).toEqual({ vol: 0.5 });
    expect(b.row.state['qa']).toBeUndefined();
  });

  it('honours key deletion', async () => {
    const store = createMemorySaveStore();
    const a = await bound(store, { key: 'cc', durableKeys: ['prog', 'glory', 'resume', 'settings'] });
    a.st['resume'] = { fen: 'x' };
    a.st['glory'] = 5;
    await a.d.flush('manual');
    expect(JSON.parse(store.get('cc')!).ps.resume).toEqual({ fen: 'x' });
    delete a.st['resume'];
    await a.d.flush('manual');
    expect(JSON.parse(store.get('cc')!).ps).toEqual({ glory: 5 });
    const b = await bound(store, { key: 'cc', durableKeys: ['prog', 'glory', 'resume', 'settings'] });
    expect(b.row.state['resume']).toBeUndefined();
    expect(b.row.state['glory']).toBe(5);
  });

  it('a write marks the document dirty without a flush call (debounce)', async () => {
    const store = createMemorySaveStore();
    const a = await bound(store, { key: 'cr', durableKeys: ['coins'] });
    a.st['coins'] = 7;
    await new Promise((r) => setTimeout(r, 40));
    expect(JSON.parse(store.get('cr')!).ps).toEqual({ coins: 7 });
  });

  it('backupKey: a corrupt document is kept under it', async () => {
    const store = createMemorySaveStore();
    store.set('cr', 'not json{');
    const d = new DurableState(store, { key: 'cr', backupKey: 'cr_bad', durableKeys: ['coins'], log: { warn() {}, error() {} } });
    await d.load();
    expect(store.get('cr_bad')).toBe('not json{');
    expect(store.get('ss_save_v1_bad')).toBeNull();
  });
});
