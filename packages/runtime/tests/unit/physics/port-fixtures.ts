// Row records and a row store for the port tests that run without a kernel (WP PH3): just the fields the physics port reads,
// and an `engineWriteTransform` that behaves like the store's (it replaces the transform objects, as every write does).
import type { ColliderPack, PlaceBake } from '../../../src/compat/core/ports.ts';
import type { Quat, RowRec, Vec3 } from '../../../src/compat/core/types.ts';
import type { PhysicsRowStore } from '../../../src/compat/physics/port.ts';

let serial = 0;

export interface FakeRowInit {
  place?: string | null;
  physics?: unknown;
  primitive?: unknown;
  model?: unknown;
  pos?: Vec3;
  rot?: Quat;
  scale?: Vec3;
  vel?: Vec3;
  tags?: string[];
  parentId?: string | null;
  spectating?: boolean;
  /** a scene row: its spec as authored carries the same `physics` */
  scene?: boolean;
}

export function fakeRow(id: string, init: FakeRowInit = {}): RowRec {
  const props: Record<string, unknown> = {};
  if (init.physics !== undefined) props['physics'] = init.physics;
  if (init.primitive !== undefined) props['primitive'] = init.primitive;
  if (init.model !== undefined) props['model'] = init.model;
  const pos = init.pos ?? { x: 0, y: 0, z: 0 }, rot = init.rot ?? { x: 0, y: 0, z: 0, w: 1 };
  const row = {
    id, serial: serial++, vm: 'platform', place: init.place === undefined ? 'home' : init.place, explicitPlace: false,
    parentId: init.parentId ?? null, spawnerId: null, name: null, tags: Object.freeze([...(init.tags ?? [])]), template: null,
    spec: init.scene && init.physics !== undefined ? { physics: init.physics } : {}, state: {}, props,
    tf: { pos, rot, scale: init.scale ?? { x: 1, y: 1, z: 1 }, vel: init.vel ?? { x: 0, y: 0, z: 0 }, angVel: { x: 0, y: 0, z: 0 }, grounded: false, prevPos: pos, prevRot: rot, worldCacheTick: -1 },
    behaviors: [], audience: 'near', scope: 'session', visibility: null, simulatedBy: null, lifetimeS: null, expiresAtTick: null, phase: 'alive',
    pendingSpawnHooks: false, player: null, spectating: init.spectating === true, rig: null,
    fromScene: init.scene ? { place: init.place === undefined ? 'home' : init.place, cell: 'x0z0' } : null, stateVer: 0, propVer: 0, handles: {},
  };
  return row as unknown as RowRec;
}

export interface FakeStore extends PhysicsRowStore {
  readonly rows: Map<string, RowRec>;
  /** writebacks, in order */
  readonly writes: Array<{ id: string; pos: Vec3; vel: Vec3; grounded: boolean }>;
  add(row: RowRec): RowRec;
}

export function fakeStore(): FakeStore {
  const rows = new Map<string, RowRec>();
  const writes: FakeStore['writes'] = [];
  return {
    rows,
    writes,
    add(row) { rows.set(row.id, row); return row; },
    get: (id) => rows.get(id),
    engineWriteTransform(row, pos, vel, grounded, rot, angVel) {
      if (row.phase !== 'alive') return;
      row.tf.pos = { x: pos.x, y: pos.y, z: pos.z };
      row.tf.vel = { x: vel.x, y: vel.y, z: vel.z };
      row.tf.grounded = grounded;
      if (rot) row.tf.rot = { ...rot };
      if (angVel) row.tf.angVel = { ...angVel };
      writes.push({ id: row.id, pos: { ...row.tf.pos }, vel: { ...row.tf.vel }, grounded });
    },
  };
}

/** what a script's write does: new transform objects, then the port's verb (as store/transform.ts) */
export const setPos = (row: RowRec, p: Vec3): Vec3 => (row.tf.pos = { ...p });
export const setRot = (row: RowRec, q: Quat): Quat => (row.tf.rot = { ...q });
export const setVel = (row: RowRec, v: Vec3): Vec3 => (row.tf.vel = { ...v });
export const setPhysics = (row: RowRec, value: unknown): void => { row.props['physics'] = value; };

export const bakeOf = (pack: ColliderPack): PlaceBake => ({ colliders: pack, navgrid: null, terrain: null });
export const yawQuat = (deg: number): Quat => ({ x: 0, y: Math.sin((deg * Math.PI) / 360), z: 0, w: Math.cos((deg * Math.PI) / 360) });
