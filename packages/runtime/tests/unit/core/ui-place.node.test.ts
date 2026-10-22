// ext.uiPlace: the UI ctx gets a read-only `ctx.place` (state, players) for the viewer's place; off by default (PP).
import { describe, expect, it } from 'vitest';
import { resolveExtensions } from '../../../src/compat/core/ext.ts';
import { HUMAN_BODY_ID } from '../../../src/compat/core/ids.ts';
import { ctxWorld, PLAYER_MODULES } from './fakes/ctx-world.ts';

async function scene(uiPlace: boolean) {
  const w = await ctxWorld({ modules: { ...PLAYER_MODULES }, dev: true });
  w.human('p1', {});
  if (uiPlace) Object.defineProperty(w.k, 'ext', { value: resolveExtensions({ uiPlace: true }), configurable: true });
  return w;
}

describe('ext.uiPlace', () => {
  it('is absent by default (PP)', async () => {
    const w = await scene(false);
    expect(w.k.createUiCtx().place).toBeUndefined();
  });

  it('reads the place state the sim wrote and lists the local player only', async () => {
    const w = await scene(true);
    w.ctx(HUMAN_BODY_ID).place.state['round'] = { n: 3 };
    const ctx = w.k.createUiCtx();
    expect(ctx.place?.state['round']).toEqual({ n: 3 });
    expect(ctx.place?.players.map((p) => p.id)).toEqual([HUMAN_BODY_ID]);
  });

  it('ignores writes through the UI view', async () => {
    const w = await scene(true);
    w.ctx(HUMAN_BODY_ID).place.state['round'] = { n: 3 };
    const ctx = w.k.createUiCtx();
    ctx.place!.state['round'].n = 9;
    ctx.place!.state['other'] = 1;
    (ctx as unknown as { place: unknown }).place = null;
    expect(ctx.place).toBeDefined();
    expect(w.ctx(HUMAN_BODY_ID).place.state['round']).toEqual({ n: 3 });
    expect(w.ctx(HUMAN_BODY_ID).place.state['other']).toBeUndefined();
  });
});
