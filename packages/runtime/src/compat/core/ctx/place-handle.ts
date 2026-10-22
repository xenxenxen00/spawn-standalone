// `ctx.place` and `ctx.world.places[<id>]` (docs/design/core-runtime.md §3.5, §5.5, §5.7, §11; contract §4.1, §4.3).
//
// One handle per place and realm, cached. Every member is read at the moment of the read: the place manager's values when it is
// wired (C4: the resolved spawn point, the bottom, the runtime's state and atmosphere), the compiled config's otherwise, so the
// handles work in a kernel without places (tests, tools) and for a roster place that is not resident.
//
//   players            the human's PlayerView while its body stands in this place, else []
//   objects            a lazy map id → handle over the place's resident rows (`Object.keys(place.objects)`,
//                      `place.objects[id].light = …`, authored module); the camera rig is not in it and X-24 hides
//                      client-local rows from the platform VM
//   state              per place, room life, kept when the place unloads (`power.k` survives a reload); readable for a roster
//                      place that is not resident (the Director's `ctx.world.places[id].state.power`, authored module)
//   atmosphere         the LayeredValue over the config: a leaf write merges (`ambient.light.intensity`, authored module),
//                      a root assignment replaces (`fog = {…}`, scripts/gen/fallout-acre/nuke.js:20), `delete` reveals the config
//   gravity            the config's, default {0, −9.81, 0}; every live place {0, −24, 0}; a copy per read
//   defaultSpawnPoint  resolved (y from the ground when the config names none)
//   worldBounds.bottom the config's, or 64 m under the spawn point
// The UI realm's handle is read-only: writes to `state` and `atmosphere` through it are ignored.
import { placesOf, visibleTo } from '../query.ts';
import { ENGINE } from '../rules.ts';
import { extOf, gravityOverrides } from '../ext.ts';
import { LayeredValueImpl } from '../store/layers.ts';
import type { Realm } from '../store/proxies.ts';
import type { CompiledPlace, ObjectView, PlaceHandle, PlaceId, PlaceManager, PlayerView, RowId, RowRec, Vec3 } from '../types.ts';
import { cloneWire } from '../wire.ts';
import type { CtxShared } from './common.ts';
import { ignoreWrites } from './world-handle.ts';

const NO_TERRAIN: Readonly<Record<string, unknown>> = Object.freeze({ kind: 'off' });
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** a deep read-only view of plain data: nested objects are views too, every write and delete is ignored */
function readonlyView<T extends object>(target: T): T {
  return new Proxy(target, {
    get: (t, k, r) => {
      const v: unknown = Reflect.get(t, k, r);
      return typeof k === 'string' && v !== null && typeof v === 'object' && Object.prototype.hasOwnProperty.call(t, k) && !Object.isFrozen(t) ? readonlyView(v) : v;
    },
    set: () => true,
    deleteProperty: () => true,
    defineProperty: () => true,
  });
}

export class PlaceHandleImpl implements PlaceHandle {
  readonly #s: CtxShared;
  readonly #id: PlaceId;
  readonly #realm: Realm;
  #objects: Record<RowId, ObjectView> | null = null;

  constructor(shared: CtxShared, id: PlaceId, realm: Realm) {
    this.#s = shared;
    this.#id = id;
    this.#realm = realm;
  }

  /** @internal dev warning of an ignored write */
  static ignored(h: PlaceHandleImpl, member: string): void {
    h.#s.warn(`write to place.${member} of ${h.#id} ignored (read-only)`);
  }

  #config(): CompiledPlace | undefined {
    return this.#s.k.placeIndex.placeIndex[this.#id];
  }

  /** the place manager, for a roster place it can answer for */
  #manager(): PlaceManager | null {
    return this.#s.onRoster(this.#id) ? placesOf(this.#s.k) : null;
  }

  get id(): PlaceId {
    return this.#id;
  }

  get name(): PlaceId {
    return this.#id;
  }

  get mode(): '3d' {
    return '3d';
  }

  get players(): PlayerView[] {
    const store = this.#s.k.store;
    const body = store.get(this.#s.k.ids.humanBody);
    return body !== undefined && body.player !== null && body.place === this.#id ? [store.handle(body, this.#realm) as PlayerView] : [];
  }

  get objects(): Record<RowId, ObjectView> {
    if (this.#objects !== null) return this.#objects;
    const store = this.#s.k.store;
    const place = this.#id;
    const realm = this.#realm;
    const shown = (row: RowRec | undefined): row is RowRec => row !== undefined && row.place === place && row.rig === null && visibleTo(realm, row);
    const at = (key: string | symbol): ObjectView | undefined => {
      if (typeof key !== 'string') return undefined;
      const row = store.get(key);
      return shown(row) ? store.handle(row, realm) : undefined;
    };
    this.#objects = new Proxy(Object.create(null) as Record<RowId, ObjectView>, {
      get: (_t, key) => at(key),
      has: (_t, key) => at(key) !== undefined,
      ownKeys: () => {
        const ids: string[] = [];
        for (const row of store.byPlace(place)) if (shown(row)) ids.push(row.id);
        return ids;
      },
      getOwnPropertyDescriptor: (_t, key) => {
        const h = at(key);
        return h === undefined ? undefined : { value: h, enumerable: true, configurable: true, writable: false };
      },
      set: () => true,
      deleteProperty: () => true,
      defineProperty: () => true,
    });
    return this.#objects;
  }

  get state(): Record<string, any> {
    return this.#s.placeBag(this.#id).view(this.#realm === 'ui');
  }
  /** `place.state = {…}` replaces the contents (a copy); ignored from the UI realm */
  set state(v: Record<string, any>) {
    if (this.#realm === 'ui') this.#s.warn(`write to place.state of ${this.#id} through the read-only UI view ignored`);
    else this.#s.placeBag(this.#id).replace(v);
  }

  get atmosphere(): Record<string, any> {
    const lv = this.#s.atmosphere(this.#id);
    if (this.#realm !== 'ui') return lv.proxy();
    return lv instanceof LayeredValueImpl ? lv.proxy({ readonly: true }) : readonlyView(lv.read());
  }
  /** `place.atmosphere = {…}` replaces the own layer's root; ignored from the UI realm */
  set atmosphere(v: Record<string, any>) {
    if (this.#realm === 'ui') this.#s.warn(`write to place.atmosphere of ${this.#id} through the read-only UI view ignored`);
    else this.#s.atmosphere(this.#id).set([], v);
  }

  get gravity(): Vec3 {
    const g =
      gravityOverrides(this.#s.k).get(this.#id) ??
      (extOf(this.#s.k).gravitySetter ? this.#s.k.ports.physics.gravityOf?.(this.#id) : null) ??
      this.#config()?.gravity ??
      ENGINE.GRAVITY_DEFAULT;
    return { x: g.x, y: g.y, z: g.z };
  }
  /** R-3 (opt-in `ext.gravitySetter`): the value read back changes and the physics port is told; else ignored as before */
  set gravity(v: Vec3) {
    const ok = extOf(this.#s.k).gravitySetter && this.#realm !== 'ui' && v !== null && typeof v === 'object' && [v.x, v.y, v.z].every((n) => typeof n === 'number' && Number.isFinite(n));
    if (!ok) {
      PlaceHandleImpl.ignored(this, 'gravity');
      return;
    }
    const g = { x: v.x, y: v.y, z: v.z };
    gravityOverrides(this.#s.k).set(this.#id, g);
    this.#s.k.ports.physics.setGravity?.(this.#id, { ...g });
  }

  get terrain(): Record<string, unknown> {
    return (this.#config()?.terrain ?? NO_TERRAIN) as Record<string, unknown>;
  }

  get defaultSpawnPoint(): Vec3 {
    const pm = this.#manager();
    if (pm !== null) {
      try {
        const p = pm.spawnPoint(this.#id);
        return { x: p.x, y: p.y, z: p.z };
      } catch {
        // a place the manager cannot answer for: the config's point
      }
    }
    return this.#configSpawn();
  }

  /** the config's spawn point: `y` as written, `{ terrain: h }` above the ground, else the ground under (x, z), else 0 */
  #configSpawn(): Vec3 {
    const sp = cloneWire(this.#config()?.defaultSpawnPoint) as Record<string, unknown> | undefined;
    const x = num(sp?.['x']) ?? 0;
    const z = num(sp?.['z']) ?? 0;
    const y = sp?.['y'];
    const direct = num(y);
    if (direct !== null) return { x, y: direct, z };
    const ground = this.#s.k.ports.physics.groundY(this.#id, x, z);
    const above = y !== null && typeof y === 'object' ? (num((y as Record<string, unknown>)['terrain']) ?? 0) : 0;
    return { x, y: (ground ?? 0) + above, z };
  }

  get worldBounds(): { bottom: number } {
    const pm = this.#manager();
    if (pm !== null) {
      try {
        return { bottom: pm.bottom(this.#id) };
      } catch {
        // as above
      }
    }
    const bottom = num(this.#config()?.worldBounds.bottom);
    return { bottom: bottom ?? this.#configSpawn().y - ENGINE.OOB_DEFAULT_DEPTH_M };
  }
}
ignoreWrites(PlaceHandleImpl.prototype, (self, member) => PlaceHandleImpl.ignored(self as PlaceHandleImpl, member));
