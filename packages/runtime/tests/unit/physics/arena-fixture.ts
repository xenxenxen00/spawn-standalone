// The fixture place of the `raycast` option table (motion §6.4), built twice from one description: as PH1's `QueryScene`
// (the BVH backend, the oracle) and as a Rapier world behind `RapierQueryWorld` (WP PH3). Box room, a crate, a kinematic
// door, an instanced static terminal, characters (one spectating), dynamic bodies, a sensor, a terrain patch, anonymous
// geometry and far walls. tests/unit/physics/raycast.node.test.ts holds the same scene for the oracle's own table.
import { StaticBvh } from '../../../src/compat/physics/bvh.ts';
import { v3 } from '../../../src/compat/physics/math.ts';
import { QueryScene, type QueryBody, type QueryLayer } from '../../../src/compat/physics/query.ts';
import { RapierQueryWorld } from '../../../src/compat/physics/rapier/query.ts';
import { PhysicsWorld } from '../../../src/compat/physics/rapier/world.ts';
import { boxTriangles, capsuleFromFeet, meshShape, obbShape, sphereShape } from '../../../src/compat/physics/shapes.ts';
import { centred, mat34 } from './rapier-fixtures.ts';

type P3 = [number, number, number];
export const quad = (a: P3, b: P3, c: P3, d: P3): Float32Array => new Float32Array([...a, ...b, ...c, ...a, ...c, ...d]);
const translate = (x: number, y: number, z: number): Float64Array => new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, x, y, z]);

interface Soup { id: string | null; tags: string[]; tris?: Float32Array; box?: { at: P3; half: P3 } }
interface Ball { id: string; tags: string[]; at: P3; r: number }
interface Capsule { id: string; tags: string[]; feet: P3; active: boolean }
interface Slab { id: string; tags: string[]; at: P3; half: P3; kind: 'static' | 'kinematic' }

export const ARENA = {
  soups: [
    { id: 'floor', tags: ['ground'], tris: quad([-20, 0, -20], [20, 0, -20], [20, 0, 20], [-20, 0, 20]) },
    { id: 'wall-n', tags: ['wall'], tris: quad([-10, 0, -10], [10, 0, -10], [10, 4, -10], [-10, 4, -10]) },
    { id: 'crate', tags: ['prop'], box: { at: [0, 0.6, -5], half: [0.6, 0.6, 0.6] } },
    { id: null, tags: [], box: { at: [-15, 1, 0], half: [1, 1, 1] } },
    { id: 'far-150', tags: ['wall'], tris: quad([150, 0, -2], [150, 0, 2], [150, 3, 2], [150, 3, -2]) },
    { id: 'far-250', tags: ['wall'], tris: quad([-250, 0, 10], [-250, 0, 20], [-250, 3, 20], [-250, 3, 10]) },
  ] as Soup[],
  terrain: quad([30, -1, -10], [50, -1, -10], [50, -1, 10], [30, -1, 10]),
  capsules: [
    { id: 'player-1', tags: ['player'], feet: [0, 0, 0], active: true },
    { id: 'bot-1', tags: ['bot'], feet: [0, 0, -1.5], active: false },
    { id: 'enemy-1', tags: ['enemy'], feet: [0, 0, -3], active: true },
  ] as Capsule[],
  balls: [
    { id: 'player-1/gear', tags: ['gear'], at: [0, 1, -1], r: 0.2 },
    { id: 'gib-1', tags: ['gib'], at: [0, 1, -6.5], r: 0.2 },
  ] as Ball[],
  sensor: { id: 'portal-1', tags: ['portal'], at: [0, 1, -2] as P3, half: [2, 2, 0.1] as P3 },
  slabs: [
    { id: 'door-1', tags: ['door'], at: [0, 1.25, -8], half: [1, 1.25, 0.05], kind: 'kinematic' },
    { id: 'terminal-1', tags: ['terminal'], at: [0, 1, -9], half: [0.3, 0.3, 0.3], kind: 'static' },
  ] as Slab[],
  capsule: { height: 1.8, radius: 0.35 },
} as const;

const body = (b: Omit<QueryBody, 'active' | 'sensor'> & { active?: boolean; sensor?: boolean }): QueryBody => ({ active: true, sensor: false, ...b });

/** the oracle: PH1's BVH scene */
export function arenaScene(): QueryScene {
  const s = new QueryScene('arena');
  for (const p of ARENA.soups) s.addStatic(p.id, p.tags, p.tris ?? boxTriangles(v3(...p.box!.half), translate(...p.box!.at)));
  s.addStatic('terrain/arena', [], ARENA.terrain);
  s.build();
  for (const c of ARENA.capsules) {
    s.addBody(body({ rowId: c.id, kind: 'character', tags: c.tags, active: c.active, shape: capsuleFromFeet({ x: c.feet[0], y: c.feet[1], z: c.feet[2] }, ARENA.capsule.height, ARENA.capsule.radius) }));
  }
  for (const b of ARENA.balls) s.addBody(body({ rowId: b.id, kind: 'dynamic', tags: b.tags, shape: sphereShape(v3(...b.at), b.r) }));
  const z = ARENA.sensor;
  s.addBody(body({ rowId: z.id, kind: 'static', tags: z.tags, sensor: true, shape: obbShape(v3(...z.at), v3(...z.half), null) }));
  for (const d of ARENA.slabs) {
    s.addBody(body({ rowId: d.id, kind: d.kind, tags: d.tags, shape: meshShape(StaticBvh.build(boxTriangles(v3(...d.half), null)), translate(...d.at)) }));
  }
  return s;
}

/** the same place as a Rapier world, stepped once so every collider answers queries */
export function arenaRapier(proxies: () => QueryLayer | null = () => null): { world: PhysicsWorld; query: RapierQueryWorld } {
  const world = new PhysicsWorld('arena');
  const R = world.R;
  const set = world.colliders;
  for (const p of ARENA.soups) {
    if (p.tris) set.addInstance({ rowId: p.id, shape: { id: String(p.id), tris: p.tris }, m: mat34(), tags: p.tags });
    else set.addInstance({ rowId: p.id, ...centred(String(p.id), p.box!.half, p.box!.at), tags: p.tags });
  }
  world.build({ place: 'arena', keys: [], instances: [], runtimeKeys: [], terrain: { id: 'terrain/arena', tris: ARENA.terrain } });
  for (const c of ARENA.capsules) {
    const ch = world.addCharacter({ rowId: c.id, feet: { x: c.feet[0], y: c.feet[1], z: c.feet[2] }, ...ARENA.capsule, tags: c.tags });
    if (!c.active) world.setCharacterEnabled(ch, false);
  }
  for (const b of ARENA.balls) {
    // what PH4's dynamics.ts will make: a dynamic body with a ball, held still here (asleep, no gravity)
    const rb = world.raw.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(...b.at).setGravityScale(0).setCanSleep(true));
    const col = world.raw.createCollider(R.ColliderDesc.ball(b.r), rb);
    set.adopt(col, rb, { rowId: b.id, kind: 'dynamic', tags: b.tags });
    rb.sleep();
  }
  const z = ARENA.sensor;
  set.addInstance({ rowId: z.id, ...centred(z.id, z.half, z.at), tags: z.tags, sensor: true });
  for (const d of ARENA.slabs) set.addInstance({ rowId: d.id, ...centred(d.id, d.half, d.at), tags: d.tags, kind: d.kind, mutable: true });
  world.refresh();
  const query = new RapierQueryWorld(world, proxies);
  for (const b of ARENA.balls) query.children.add(b.id);
  return { world, query };
}
