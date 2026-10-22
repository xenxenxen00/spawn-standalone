// X-24 (docs/architecture.md §2; docs/design/core-runtime.md §10.2-10.3, §16.1 `vm-visibility.test.ts`): `audience: 'local'` rows
// created on the client VM are invisible to platform-VM reads (getObject, query, children) and visible to client-VM and UI reads.
// The live case: the human's body spawns `bp-<Bone>` probe rows parented to a platform enemy (scripts/enemies/probes.js:148), and
// the bots (platform VM) never see them (scripts/enemies/joints.js:180-197), so they fall back to coarse joints (mp §11.7).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getObject, query, visibleTo } from '../../../src/compat/core/query.ts';
import { spawnRow } from '../../../src/compat/core/lifecycle.ts';
import { HUMAN_BODY_ID } from '../../../src/compat/core/ids.ts';
import type { CallerRef, ObjectView } from '../../../src/compat/core/types.ts';
import { world, type World } from './fakes/lifecycle-world.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const BODY = 'scripts/player.js';
const BOT = 'scripts/bots/bot.js';
const ids = (r: unknown[]): string[] => r.map((x) => (typeof x === 'string' ? x : (x as ObjectView).id));

/** a human body (client VM), a bot (platform VM, simulatedBy platform), an enemy (platform VM) and the body's probes on it */
async function scene(): Promise<{ w: World; body: CallerRef; bot: CallerRef }> {
  const w = await world({ modules: { [BODY]: {}, [BOT]: {}, 'templates/player.js': { player: { behavior: [BODY], tags: ['player'] } } } });
  w.k.spawnHuman({ place: 'p1', at: { x: 0, y: 0, z: 0 }, userId: 'u', displayName: 'Op', durableState: {} });
  spawnRow(w.k, { kind: 'sim', sim: w.sim(null) }, 'bot-1', { behavior: BOT, simulatedBy: 'platform', tags: ['bot'], feetPosition: { x: 1, y: 0, z: 0 } });
  spawnRow(w.k, { kind: 'sim', sim: w.sim(null) }, 'z1', { tags: ['enemy'], simulatedBy: 'platform', feetPosition: { x: 5, y: 0, z: 0 } });
  const human = w.ctxOf(HUMAN_BODY_ID);
  for (const bone of ['Head', 'Spine']) {
    human.spawn(`bp-${bone}`, { parent: 'z1', audience: 'local', scope: 'session', tags: ['probe'], attachment: { bone }, visible: false });
  }
  // a client-made row that is not local, and a local row made on the platform VM
  human.spawn('corpse-shared', { tags: ['corpse'], feetPosition: { x: 2, y: 0, z: 0 } });
  spawnRow(w.k, { kind: 'sim', sim: w.sim(null) }, 'platform-local', { audience: 'local', tags: ['corpse'], feetPosition: { x: 2, y: 0, z: 0 } });
  // a local row with children: the whole subtree exists only on the client
  human.spawn('gibs', { audience: 'local', tags: ['gib'], children: [{ id: 'a', tags: ['gib'] }] });
  const row = (id: string) => w.row(id)!;
  return { w, body: { kind: 'row', row: row(HUMAN_BODY_ID), behavior: row(HUMAN_BODY_ID).behaviors[0]! }, bot: { kind: 'row', row: row('bot-1'), behavior: row('bot-1').behaviors[0]! } };
}

describe('X-24: client-VM audience:local rows and the platform VM', () => {
  it('the rows land on the VMs of §10.2: probes are client rows parented to a platform enemy', async () => {
    const { w } = await scene();
    expect(w.row(HUMAN_BODY_ID)!.vm).toBe('client');
    expect(w.row('bot-1')!.vm).toBe('platform');
    expect(w.row('z1')!.vm).toBe('platform');
    expect(w.row('z1/bp-Head')!.vm).toBe('client');
    expect(w.row('z1/bp-Head')!.parentId).toBe('z1');
    expect(w.row('z1/bp-Head')!.spawnerId).toBe(HUMAN_BODY_ID);
    expect(w.row('platform-local')!.vm).toBe('platform');
    expect(w.row('gibs/a')!.vm).toBe('client');
    expect(w.row('gibs/a')!.audience).toBe('local');
  });

  it('platform-VM getObject returns null for them; client-VM and UI getObject see them', async () => {
    const { w, body, bot } = await scene();
    for (const id of ['z1/bp-Head', 'z1/bp-Spine', 'gibs', 'gibs/a']) {
      expect(getObject(w.k, bot, id), id).toBeNull();
      expect(getObject(w.k, { kind: 'sim', sim: w.sim(null) }, id), id).toBeNull();
      expect(getObject(w.k, body, id), id).not.toBeNull();
      expect(getObject(w.k, { kind: 'ui' }, id), id).not.toBeNull();
    }
    for (const id of ['corpse-shared', 'platform-local', 'z1', HUMAN_BODY_ID]) expect(getObject(w.k, bot, id), id).not.toBeNull();
  });

  it('platform-VM query leaves them out; client-VM query lists them', async () => {
    const { w, body, bot } = await scene();
    expect(ids(query(w.k, bot, { tags: ['probe'] }))).toEqual([]);
    expect(ids(query(w.k, body, { tags: ['probe'] }))).toEqual(['z1/bp-Head', 'z1/bp-Spine']);
    expect(ids(query(w.k, bot, { anyTags: ['corpse', 'gib'] }))).toEqual(['corpse-shared', 'platform-local']);
    expect(ids(query(w.k, body, { anyTags: ['corpse', 'gib'] }))).toEqual(['corpse-shared', 'platform-local', 'gibs', 'gibs/a']);
    expect(ids(query(w.k, { kind: 'sim', sim: w.sim(null) }, { radius: 100, center: { x: 0, y: 0, z: 0 }, tags: ['probe'] }))).toEqual([]);
    expect(query(w.k, bot, { tags: ['probe'], select: 'ids' })).toEqual([]);
  });

  it("platform-VM children of the enemy leave the probes out (joints.js reads o.children); the client's list them", async () => {
    const { w, body, bot } = await scene();
    const fromBot = getObject(w.k, bot, 'z1')!;
    const fromBody = getObject(w.k, body, 'z1')!;
    expect(fromBot.children).toEqual([]);
    expect(ids(fromBody.children)).toEqual(['z1/bp-Head', 'z1/bp-Spine']);
    expect(ids(w.k.store.handle(w.row('z1')!, 'ui').children)).toEqual(['z1/bp-Head', 'z1/bp-Spine']);
  });

  it('visibleTo states the rule per realm', async () => {
    const { w } = await scene();
    const probe = w.row('z1/bp-Head')!;
    expect(visibleTo('platform', probe)).toBe(false);
    expect(visibleTo('client', probe)).toBe(true);
    expect(visibleTo('ui', probe)).toBe(true);
    expect(visibleTo('platform', w.row('platform-local')!)).toBe(true);
    expect(visibleTo('platform', w.row('corpse-shared')!)).toBe(true);
  });

  it('the body still destroys its probes and the cascade from the enemy takes them', async () => {
    const { w, body } = await scene();
    w.destroy('z1');
    expect(w.row('z1/bp-Head')).toBeUndefined();
    expect(getObject(w.k, body, 'z1/bp-Head')).toBeNull();
  });
});
