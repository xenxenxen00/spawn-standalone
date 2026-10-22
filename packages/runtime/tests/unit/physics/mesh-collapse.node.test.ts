// R-6: scene-baked static MESH colliders that a sim moves and switches off at runtime (Crown Riot's arena ring: eight segments
// that collapse in waves and are restored by `resetCollapse`; collapse.js:19-28, 59). Through the real port on real Rapier:
// pose writes re-seat the mesh, `physics = "none"` switches it off, and the original value switches it back on in place.
import { afterEach, describe, expect, it } from 'vitest';
import { raycast, type RaycastHit } from '../../../src/compat/builtin/physics.ts';
import type { RowRec } from '../../../src/compat/core/types.ts';
import { PhysicsPortImpl } from '../../../src/compat/physics/port.ts';
import { bakeOf, fakeRow, fakeStore, setPhysics, setPos, setRot, yawQuat, type FakeStore } from './port-fixtures.ts';
import { GRAVITY, PLAYER_CAPSULE, TICK, packOf, quadSoup, type Part } from './rapier-fixtures.ts';

const N = 8, MID = 13.7, Y = 20;
const SEG_PHYSICS = { body: 'static', collider: 'mesh' } as const;
const seg = (i: number) => { const m = ((i + 0.5) / N) * Math.PI * 2; return { x: Math.cos(m) * MID, z: Math.sin(m) * MID }; };
const CATCH: Part = { row: 'clouds', box: [60, 0.5, 60], at: [0, -30.5, 0] };
// each segment: a 4 m square top, the mesh in the row's own frame (origin at its feet), baked mutable
const parts: Part[] = [CATCH, ...Array.from({ length: N }, (_, i) => ({ row: `ring-${i}`, tris: quadSoup(2, 0), at: [seg(i).x, Y, seg(i).z] as [number, number, number], mutable: true }))];

let port: PhysicsPortImpl;
let store: FakeStore;
let rows: RowRec[];
afterEach(() => port?.dispose());

function arena(): void {
  store = fakeStore();
  port = new PhysicsPortImpl({ host: { store } });
  port.buildPlace('home', bakeOf(packOf('home', parts)));
  rows = Array.from({ length: N }, (_, i) => {
    const row = store.add(fakeRow(`ring-${i}`, { physics: SEG_PHYSICS, scene: true, pos: { x: seg(i).x, y: Y, z: seg(i).z } }));
    port.rowSpawned(row);
    return row;
  });
  port.step('home', TICK);
}
const ctx = { place: { id: 'home' } };
const top = (i: number): RaycastHit | null => raycast(ctx, { x: seg(i).x, y: Y + 10, z: seg(i).z }, { x: 0, y: -1, z: 0 }, { distance: 80 }) as RaycastHit | null;
const stands = (i: number): boolean => top(i)?.id === `ring-${i}`;
const write = (row: RowRec, value: unknown): void => { setPhysics(row, value); port.onPhysicsWrite(row, value); };

describe('R-6: runtime-mutable static mesh colliders (arena ring)', () => {
  it('the baked mesh segments are solid, each its own row', () => {
    arena();
    for (let i = 0; i < N; i++) expect(stands(i)).toBe(true);
    expect(top(0)!.distance).toBeCloseTo(10, 3);
  });

  it('physics = "none" switches one segment off at once; the neighbours stay solid; the collider is kept', () => {
    arena();
    const handle = port.world('home')!.colliders.ownersOf('ring-3')[0]!.handle;
    write(rows[3]!, 'none');
    port.step('home', TICK);
    expect(top(3)!.id).toBe('clouds');
    for (const i of [0, 1, 2, 4, 5, 6, 7]) expect(stands(i)).toBe(true);
    write(rows[3]!, SEG_PHYSICS);
    port.step('home', TICK);
    expect(stands(3)).toBe(true);
    expect(port.world('home')!.colliders.ownersOf('ring-3')[0]!.handle).toBe(handle);
  });

  it('a bean standing on a segment falls when its physics goes to "none"; neighbours keep a bean up', () => {
    arena();
    const onSeg = (i: number, id: string): RowRec => {
      const row = store.add(fakeRow(id, { physics: { body: 'character', capsule: PLAYER_CAPSULE, autostep: false }, pos: { x: seg(i).x, y: Y + 0.05, z: seg(i).z } }));
      port.rowSpawned(row);
      return row;
    };
    const a = onSeg(0, 'bean-a'), b = onSeg(1, 'bean-b');
    const run = (n: number): void => {
      for (let k = 0; k < n; k++) {
        for (const r of [a, b]) { r.tf.vel = { x: 0, y: r.tf.vel.y + GRAVITY * TICK, z: 0 }; port.setVelocity(r, r.tf.vel); }
        port.step('home', TICK);
      }
    };
    run(15);
    expect(a.tf.pos.y).toBeGreaterThan(Y - 0.05);
    expect(b.tf.pos.y).toBeGreaterThan(Y - 0.05);
    write(rows[0]!, 'none');
    run(30);
    expect(a.tf.pos.y).toBeLessThan(Y - 5);
    expect(b.tf.pos.y).toBeGreaterThan(Y - 0.05);
  });

  it('a moved and tipped segment is re-seated where its row is (the old place is empty); the drop never needs the collider rebuilt by hand', () => {
    arena();
    const row = rows[2]!;
    const p = seg(2);
    for (let k = 1; k <= 5; k++) {
      port.setPosition(row, setPos(row, { x: p.x + 0.3 * k, y: Y - 0.4 * k, z: p.z }));
      port.setRotation(row, setRot(row, yawQuat(10 * k)));
      port.step('home', TICK);
    }
    const h = raycast(ctx, { x: p.x + 1.5, y: Y + 10, z: p.z }, { x: 0, y: -1, z: 0 }, { distance: 80 }) as RaycastHit;
    expect(h.id).toBe('ring-2');
    expect(h.distance).toBeCloseTo(10 + 2, 1);
    // the original centre, minus what the tipped, shifted mesh still covers, is open: far corner of the old footprint
    const old = raycast(ctx, { x: p.x - 1.9, y: Y + 10, z: p.z - 1.9 }, { x: 0, y: -1, z: 0 }, { distance: 80 }) as RaycastHit;
    expect(old.id).toBe('clouds');
  });

  it('a bean standing on a segment goes down with it while the segment drops under it (still solid, pose-driven)', () => {
    arena();
    const bean = store.add(fakeRow('bean', { physics: { body: 'character', capsule: PLAYER_CAPSULE }, pos: { x: seg(6).x, y: Y + 0.05, z: seg(6).z } }));
    port.rowSpawned(bean);
    const step = (): void => {
      bean.tf.vel = { x: 0, y: bean.tf.vel.y + GRAVITY * TICK, z: 0 };
      port.setVelocity(bean, bean.tf.vel);
      port.step('home', TICK);
    };
    for (let k = 0; k < 10; k++) step();
    expect(bean.tf.grounded).toBe(true);
    const p = seg(6), row = rows[6]!;
    const drop = 0.5 * 14;
    for (let k = 1; k <= 25; k++) {
      const t = k * TICK;
      port.setPosition(row, setPos(row, { x: p.x, y: Y - 0.12 - drop * t * t, z: p.z }));
      step();
    }
    // the segment fell about 4 m in 25 ticks; the bean could not stay up and is on or just above the dropping mesh
    expect(bean.tf.pos.y).toBeLessThan(Y - 2);
    expect(bean.tf.pos.y).toBeGreaterThan(row.tf.pos.y - 0.5);
  });

  it('shaking all eight segments every tick (collapse warning) stays cheap', () => {
    arena();
    const t0 = performance.now();
    const ticks = 60;
    for (let k = 0; k < ticks; k++) {
      for (let i = 0; i < N; i++) port.setPosition(rows[i]!, setPos(rows[i]!, { x: seg(i).x + Math.sin(k + i) * 0.03, y: Y, z: seg(i).z + Math.cos(k + i) * 0.03 }));
      port.step('home', TICK);
    }
    const perTick = (performance.now() - t0) / ticks;
    expect(perTick).toBeLessThan(10);
    for (let i = 0; i < N; i++) expect(stands(i)).toBe(true);
  });

  it('resetCollapse: physics, pose and rotation restored; all 8 solid at the baked place again', () => {
    arena();
    const p = seg(5);
    write(rows[5]!, 'none');
    port.setPosition(rows[5]!, setPos(rows[5]!, { x: p.x + 2, y: Y - 8, z: p.z }));
    port.setRotation(rows[5]!, setRot(rows[5]!, yawQuat(60)));
    write(rows[4]!, 'none');
    port.step('home', TICK);
    expect(stands(5)).toBe(false);
    expect(stands(4)).toBe(false);
    // what collapse.js resetCollapse writes for every segment
    for (let i = 0; i < N; i++) {
      const s = seg(i);
      port.setPosition(rows[i]!, setPos(rows[i]!, { x: s.x, y: Y, z: s.z }));
      port.setRotation(rows[i]!, setRot(rows[i]!, yawQuat(0)));
      write(rows[i]!, SEG_PHYSICS);
    }
    port.step('home', TICK);
    for (let i = 0; i < N; i++) {
      expect(stands(i)).toBe(true);
      expect(top(i)!.distance).toBeCloseTo(10, 3);
    }
  });
});
