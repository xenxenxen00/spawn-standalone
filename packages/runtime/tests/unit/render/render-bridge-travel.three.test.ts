// render-bridge.ts `disposePlace` against the place manager's order of travel (core places/manager.ts `#move`; the M1
// defect "the player's own shadowCaster lights nothing"): the travellers (the player's body, the camera rig and their subtrees)
// are moved into the target place first and the old place is unloaded after, while the feed reports the move as a change
// of `place` only at the next drain. A traveller keeps its bridge node, so a light parented to the hidden local body (the
// player's own torch of team-glow.js, its shadowCaster) is posed under the body and reaches the light table, lit (DR-26:
// the player's own torch never loses its slot). Node + three, no renderer.
import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { LightHandle, LightRecord } from '../../../src/render/lighting/light-table.ts';
import { createLightTable } from '../../../src/render/lighting/light-table.ts';
import { rig, TestRow } from './bridge-fakes.ts';

// team-glow.js:10, 55: the torch literal, on the player's own body at (0.12, 1.35, -0.7), dipped 6 degrees
const TORCH = { kind: 'spot', color: '#fff6dc', intensity: 5, distance: 13, angle: 0.6, penumbra: 0.85, decay: 2, aim: 'forward', shadow: false };

function lightsSpy() {
  const table = createLightTable();
  const records = new Map<LightHandle, LightRecord>();
  return {
    table,
    records,
    sink: {
      add: (rec: LightRecord) => {
        const h = table.add(rec);
        records.set(h, { ...rec, position: { ...rec.position } });
        return h;
      },
      remove: (h: LightHandle) => {
        records.delete(h);
        table.remove(h);
      },
      setIntensity: (h: LightHandle, v: number) => table.setIntensity(h, v),
      setColor: (h: LightHandle, c: Parameters<typeof table.setColor>[1]) => table.setColor(h, c),
      setPose: (h: LightHandle, p: { x: number; y: number; z: number }, d?: { x: number; y: number; z: number }) => {
        const r = records.get(h);
        if (r !== undefined) r.position = { ...p };
        table.setPose(h, p, d);
      },
    },
  };
}

describe('render bridge: travel and the unload of the place left', () => {
  it('the player\'s body that moved out before its old place unloaded keeps its node; its own torch is posed under it and lit', () => {
    const spy = lightsSpy();
    const r = rig({ lights: spy.sink });
    r.camera.setHiddenBody('player/local');
    const body = new TestRow('player/local', { place: 'lobby', pos: [0, 0, 0], props: { physics: { body: 'character' } } });
    const rigRow = new TestRow('rig', { place: 'lobby', pos: [0, 1.6, 0] });
    const lobbyLamp = new TestRow('lobby-lamp', { place: 'lobby', pos: [2, 3, 0], props: { light: { kind: 'point', color: '#ffffff', intensity: 2, distance: 6 } } });
    r.spawn(body, rigRow, lobbyLamp);
    expect(r.bridge.node('player/local')).toBeDefined();
    expect(spy.records.size).toBe(1);

    // the match's travel: the body and the rig are moved into the farm and land, then the lobby is unloaded, all before the
    // next drain (the feed holds the two `place` changes and the transform write)
    body.place = 'farm';
    rigRow.place = 'farm';
    body.tick({ pos: [10, 0, -4], yaw: 90 });
    r.feed.change(body, 'place', 'feetPosition', 'rotation').change(rigRow, 'place');
    r.bridge.disposePlace('lobby');
    // what really lived in the lobby is gone, its light with it; the travellers are not
    expect(r.bridge.node('lobby-lamp')).toBeUndefined();
    expect(spy.records.size).toBe(0);
    expect(r.bridge.node('player/local')).toBeDefined();
    expect(r.bridge.node('rig')).toBeDefined();
    r.frame(1);
    r.frame(1);

    // PREP: team-glow spawns the player's own torch as a child of the body
    const torch = new TestRow('player/local/7', { place: 'farm', parent: 'player/local', pos: [0.12, 1.35, -0.7], pitch: -6, tags: ['ss-torch'], props: { light: TORCH } });
    r.spawn(torch);
    r.frame(1);
    expect(r.logs.filter((m) => /light/.test(m))).toEqual([]);
    const spots = [...spy.records.entries()].filter(([, rec]) => rec.kind === 'spot');
    expect(spots, 'the player\'s own torch reaches the light table').toHaveLength(1);
    const [handle, rec] = spots[0]!;
    expect(rec.mobility).toBe('moving');
    // lit: the hidden body draws nothing of its own, but what it carries still lights the world
    expect(spy.table.intensity(handle)).toBe(5);
    // posed under the body: feet (10, 0, -4) turned 90 degrees, the lamp's offset in the body's frame
    const want = new Vector3(0.12, 1.35, -0.7).applyAxisAngle(new Vector3(0, 1, 0), Math.PI / 2).add(new Vector3(10, 0, -4));
    expect(Math.hypot(rec.position.x - want.x, rec.position.y - want.y, rec.position.z - want.z)).toBeLessThan(1e-4);
    // the body itself is presented at its landing
    const w = r.bridge.node('player/local')!.world;
    expect([w[12], w[13], w[14]].map((x) => Math.round(x! * 1e4) / 1e4)).toEqual([10, 0, -4]);
  });

  it('without the move (the body still in the place that unloads) the body is removed, as before', () => {
    const spy = lightsSpy();
    const r = rig({ lights: spy.sink });
    const body = new TestRow('player/local', { place: 'lobby' });
    r.spawn(body);
    r.bridge.disposePlace('lobby');
    expect(r.bridge.node('player/local')).toBeUndefined();
  });
});
