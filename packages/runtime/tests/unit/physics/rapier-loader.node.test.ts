// physics/rapier/loader.ts (motion §5.1, D-MPN-10): one import + one `init()` per realm, shared by concurrent callers; no
// namespace before it resolved; the world layer refuses / holds until then (X-32). The deferred `buildPlace` of the port and
// `ensurePhysics()` are PH3's part of this file's contract.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRapierLoader, loadRapier, rapier, rapierIfLoaded, type Rapier } from '../../../src/compat/physics/rapier/loader.ts';
import { PhysicsWorld, createPhysicsWorld } from '../../../src/compat/physics/rapier/world.ts';
import { raycast } from '../../../src/compat/builtin/physics.ts';
import { PhysicsPortImpl, ensurePhysics } from '../../../src/compat/physics/port.ts';
import { LIVE_PLAYER_PHYSICS } from './kernel-fixture.ts';
import { bakeOf, fakeRow, fakeStore, setPos, setRot, setVel, yawQuat } from './port-fixtures.ts';
import { FLOOR, packOf, player, stepWith } from './rapier-fixtures.ts';

/** a stand-in module whose `init()` resolves when the test says so */
function fakeModule(): { mod: Rapier; importer: () => Promise<Rapier>; imports: () => number; inits: () => number; release: () => void } {
  let imports = 0, inits = 0;
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const mod = { init: async (): Promise<void> => { inits++; await gate; } } as unknown as Rapier;
  return { mod, importer: async () => { imports++; return mod; }, imports: () => imports, inits: () => inits, release: () => release() };
}

describe('rapier loader', () => {
  it('the setup file loaded Rapier through the loader, version 0.21.0', async () => {
    const R = rapierIfLoaded();
    expect(R).not.toBeNull();
    expect(R!.version()).toBe('0.21.0');
    expect(await loadRapier()).toBe(R);
    expect(rapier()).toBe(R);
  });

  it('memoises: concurrent and later callers share one promise, one import, one init', async () => {
    const f = fakeModule();
    const loader = createRapierLoader(f.importer);
    expect(loader.current()).toBeNull();
    const a = loader.load(), b = loader.load();
    expect(a).toBe(b);
    await Promise.resolve();
    await Promise.resolve();
    // imported and inside init(), not ready yet
    expect(f.imports()).toBe(1);
    expect(f.inits()).toBe(1);
    expect(loader.current()).toBeNull();
    f.release();
    expect(await a).toBe(f.mod);
    expect(loader.current()).toBe(f.mod);
    expect(loader.load()).toBe(a);
    await loader.load();
    expect(f.imports()).toBe(1);
    expect(f.inits()).toBe(1);
  });

  it('a failed load is forgotten, so the next call tries again', async () => {
    let calls = 0;
    const good = { init: async (): Promise<void> => undefined } as unknown as Rapier;
    const loader = createRapierLoader(async () => {
      if (calls++ === 0) throw new Error('chunk failed');
      return good;
    });
    await expect(loader.load()).rejects.toThrow('chunk failed');
    expect(loader.current()).toBeNull();
    expect(await loader.load()).toBe(good);
    expect(calls).toBe(2);
  });

  it('without a namespace there is no world (the caller keeps the bake, X-32)', () => {
    expect(createPhysicsWorld('p', {}, null)).toBeNull();
    const world = createPhysicsWorld('p');
    expect(world).toBeInstanceOf(PhysicsWorld);
    world!.free();
  });

  it('an unbuilt world answers no ray and holds its characters still', () => {
    const world = new PhysicsWorld('late');
    const c = player(world, { x: 0, y: 2, z: 0 });
    expect(world.built).toBe(false);
    expect(world.castRay({ x: 5, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 30)).toBeNull();
    for (let i = 0; i < 5; i++) stepWith(world, c, { x: 3, y: -4, z: 0 });
    expect(c.feet).toEqual({ x: 0, y: 2, z: 0 });
    expect(c.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(c.grounded).toBe(false);
    // built on resolve: the same world then answers and moves
    world.build(packOf('late', [FLOOR]));
    expect(world.built).toBe(true);
    expect(world.castRay({ x: 5, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 30)?.toi).toBeCloseTo(5, 4);
    stepWith(world, c, { x: 3, y: -4, z: 0 });
    expect(c.feet.x).toBeCloseTo(0.1, 5);
    expect(c.feet.y).toBeCloseTo(2 - 4 / 30, 5);
    world.free();
  });

  it('no module but the loader imports the package as a value (D-MPN-10)', () => {
    const root = new URL('../../../src/compat/', import.meta.url);
    const offenders: string[] = [];
    const walk = (dir: URL): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const url = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
        if (e.isDirectory()) { walk(url); continue; }
        if (!e.name.endsWith('.ts') || url.pathname.endsWith('/physics/rapier/loader.ts')) continue;
        const src = readFileSync(url, 'utf8');
        for (const line of src.split('\n')) {
          if (!line.includes('@dimforge/rapier3d-simd-compat')) continue;
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('import type ')) continue;
          offenders.push(`${url.pathname}: ${t}`);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

// ── WP PH3: the port's deferred build and `ensurePhysics()` (motion §5.1, X-32) ──────────────────────────────────────────

/** a loader over the real, initialised namespace that resolves only when the test says so */
function gatedLoader(): { loader: ReturnType<typeof createRapierLoader>; release: () => void } {
  const real = rapier();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // `init()` of the stand-in waits for the gate; the classes and enums are the real ones
  const mod = new Proxy(real, { get: (t, k) => (k === 'init' ? (): Promise<void> => gate : Reflect.get(t, k)) });
  return { loader: createRapierLoader(async () => mod), release: () => release() };
}

describe('physics port: deferred build (X-32) and ensurePhysics()', () => {
  const ctx = { place: { id: 'home' }, self: { id: 'sim' } };
  const from = { x: 5, y: 5, z: 0 }, down = { x: 0, y: -1, z: 0 };
  const settleMicrotasks = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  it('a buildPlace before the load leaves the place unbuilt (null ray, held character); ensure() resolves only after the stored build ran', async () => {
    const { loader, release } = gatedLoader();
    const store = fakeStore();
    const port = new PhysicsPortImpl({ loader, host: { store } });
    port.buildPlace('home', bakeOf(packOf('home', [FLOOR])));
    expect(port.storedBuilds).toBe(1);
    expect(port.world('home')).toBeNull();
    expect(port.isBuilt('home')).toBe(false);
    expect(port.residentPlaces()).toEqual(['home']);
    // null rays, no ground
    expect(raycast(ctx, from, down)).toBeNull();
    expect(port.groundY('home', 5, 0)).toBeNull();
    expect(port.staticRaycaster(() => 'home').castDown(from, 30)).toBeNull();
    // a character spawned meanwhile is recorded and held: no movement, not grounded, realised velocity 0
    const body = store.add(fakeRow('player/local', { physics: LIVE_PLAYER_PHYSICS, pos: { x: 0, y: 2, z: 0 }, vel: { x: 3, y: -4, z: 0 }, tags: ['player'] }));
    body.tf.grounded = true;
    port.rowSpawned(body);
    for (let i = 0; i < 3; i++) {
      setVel(body, { x: 3, y: -4, z: 0 });
      port.step('home', 1 / 30);
      expect(body.tf.pos).toEqual({ x: 0, y: 2, z: 0 });
      expect(body.tf.vel).toEqual({ x: 0, y: 0, z: 0 });
      expect(body.tf.grounded).toBe(false);
    }
    expect(port.drainTriggerEnters()).toEqual([]);

    let ensured = false, all = false;
    const mine = port.ensure().then(() => { ensured = true; });
    const everyone = ensurePhysics().then(() => { all = true; });
    await settleMicrotasks();
    expect(ensured).toBe(false);
    expect(all).toBe(false);
    expect(port.storedBuilds).toBe(1);

    release();
    await mine;
    // resolved only after the stored build ran: the world is there in the same turn
    expect(port.storedBuilds).toBe(0);
    expect(port.isBuilt('home')).toBe(true);
    await everyone;
    expect(all).toBe(true);
    const world = port.world('home')!;
    expect(world.characters.map((c) => c.rowId)).toEqual(['player/local']);
    expect((raycast(ctx, from, down) as { distance: number }).distance).toBeCloseTo(5, 4);
    expect(port.groundY('home', 5, 0)).toBeCloseTo(0, 4);
    // and the held body moves from the next step on
    setVel(body, { x: 3, y: -4, z: 0 });
    port.step('home', 1 / 30);
    expect(body.tf.pos.x).toBeCloseTo(0.1, 5);
    expect(body.tf.pos.y).toBeCloseTo(2 - 4 / 30, 5);
    expect(body.tf.vel.x).toBeCloseTo(3, 4);
    port.dispose();
    expect(world.freed).toBe(true);
  });

  it('rows recorded before the build get their bodies in spawn-serial order, whatever order they were reported in', async () => {
    const { loader, release } = gatedLoader();
    const store = fakeStore();
    const port = new PhysicsPortImpl({ loader, host: { store } });
    const a = store.add(fakeRow('a', { physics: 'character' })), b = store.add(fakeRow('b', { physics: 'character', pos: { x: 3, y: 0, z: 0 } }));
    const c = store.add(fakeRow('c', { physics: 'character', pos: { x: 6, y: 0, z: 0 } }));
    // a row may be recorded before its place is (the Director spawns into a place that has not loaded)
    port.rowSpawned(c);
    port.buildPlace('home', bakeOf(packOf('home', [FLOOR])));
    port.rowSpawned(a);
    port.rowSpawned(b);
    release();
    await port.ensure();
    expect(port.world('home')!.characters.map((ch) => ch.rowId)).toEqual(['a', 'b', 'c']);
    port.dispose();
  });

  it('pack rows that moved between their spawn and the stored build are seated where they stand (a door that swung, a teacup that turned)', async () => {
    // The pack's instances stand at the pose a row SPAWNED with. In the browser the home place waits for the Rapier chunk
    // while its scripts already run (the teacups' yaw tween), so the build must not take the pose of that later moment for
    // the baked one: the collider would keep the difference for good.
    const { loader, release } = gatedLoader();
    const store = fakeStore();
    const port = new PhysicsPortImpl({ loader, host: { store } });
    const bake = bakeOf(packOf('home', [
      FLOOR,
      // the leaf stands from x = 4 to 5; its row (the hinge) is at x = 4
      { row: 'door', box: [0.5, 1, 0.05], at: [4.5, 1, 0], kinematic: true, mutable: true },
      { row: 'terminal', box: [0.4, 1, 0.4], at: [-4, 1, 0], mutable: true },
    ]));
    port.buildPlace('home', bake);
    const door = store.add(fakeRow('door', { physics: 'kinematic', pos: { x: 4, y: 0, z: 0 } }));
    const term = store.add(fakeRow('terminal', { physics: 'static', pos: { x: -4, y: 0, z: 0 } }));
    port.rowSpawned(door);
    port.rowSpawned(term);
    // both move while the place has no world
    port.setRotation(door, setRot(door, yawQuat(90)));
    port.setPosition(term, setPos(term, { x: -8, y: 0, z: 2 }));
    port.step('home', 1 / 30);
    release();
    await port.ensure();
    port.step('home', 1 / 30);
    const under = (x: number, z: number): string | null => (raycast(ctx, { x, y: 10, z }, down, { distance: 30 }) as { id: string | null } | null)?.id ?? null;
    // the door: baked closed, standing open (the leaf runs along -z from the hinge)
    expect(under(4.8, 0)).toBe('floor');
    expect(under(4, -0.8)).toBe('door');
    // the terminal: gone from where it was baked, there where its row is
    expect(under(-4, 0)).toBe('floor');
    expect(under(-8, 2)).toBe('terminal');
    // and swinging shut again lands on the baked pose exactly
    port.setRotation(door, setRot(door, yawQuat(0)));
    port.step('home', 1 / 30);
    expect(under(4.8, 0)).toBe('door');
    expect(port.world('home')!.kinematicOf('door')!.pos.x).toBeCloseTo(4.5, 5);

    // a place demoted while its build was still stored, then built again from the same bake: the first spawn still counts
    port.dispose();
    const second = gatedLoader();
    const again = new PhysicsPortImpl({ loader: second.loader, host: { store } });
    const bake2 = bakeOf(packOf('home', [FLOOR, { row: 'door', box: [0.5, 1, 0.05], at: [4.5, 1, 0], kinematic: true, mutable: true }]));
    again.buildPlace('home', bake2);
    again.rowSpawned(door);
    again.setRotation(door, setRot(door, yawQuat(90)));
    again.disposePlace('home');
    again.buildPlace('home', bake2);
    again.rowSpawned(door);
    second.release();
    await again.ensure();
    again.step('home', 1 / 30);
    expect(under(4.8, 0)).toBe('floor');
    expect(under(4, -0.8)).toBe('door');
    again.dispose();
  });

  it('a load somebody else finished is picked up by the next step', async () => {
    const { loader, release } = gatedLoader();
    const port = new PhysicsPortImpl({ loader, host: { store: fakeStore() } });
    port.buildPlace('home', bakeOf(packOf('home', [FLOOR])));
    release();
    await loader.load();
    expect(port.world('home')).toBeNull();
    port.step('home', 1 / 30);
    expect(port.isBuilt('home')).toBe(true);
    port.dispose();
  });

  it('with Rapier loaded a build is immediate; a stored place that is disposed is never built; ensurePhysics() without work resolves', async () => {
    const port = new PhysicsPortImpl({ host: { store: fakeStore() } });
    port.buildPlace('home', bakeOf(packOf('home', [FLOOR])));
    expect(port.storedBuilds).toBe(0);
    expect(port.isBuilt('home')).toBe(true);
    await ensurePhysics();
    port.dispose();
    const { loader, release } = gatedLoader();
    const late = new PhysicsPortImpl({ loader, host: { store: fakeStore() } });
    late.buildPlace('gone', bakeOf(packOf('gone', [FLOOR])));
    late.disposePlace('gone');
    expect(late.storedBuilds).toBe(0);
    release();
    await late.ensure();
    expect(late.residentPlaces()).toEqual([]);
    late.dispose();
  });

  it('a stored build that fails rejects ensure() and is not tried again', async () => {
    const { loader, release } = gatedLoader();
    const warnings: string[] = [];
    const port = new PhysicsPortImpl({ loader, host: { store: fakeStore(), warn: (m) => warnings.push(m) } });
    const bad = packOf('bad', [FLOOR]);
    bad.instances[0]!.key = 7;
    port.buildPlace('bad', bakeOf(bad));
    release();
    await expect(port.ensure()).rejects.toThrow(/names collider key 7/);
    expect(port.storedBuilds).toBe(0);
    await expect(port.ensure()).resolves.toBeUndefined();
    port.step('bad', 1 / 30);
    expect(port.isBuilt('bad')).toBe(false);
    port.dispose();
  });
});
