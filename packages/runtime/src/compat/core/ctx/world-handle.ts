// `ctx.world` and `ctx.world.places` (docs/design/core-runtime.md §3.5, §5.7, §5.8; contract §4.1).
//
// One handle per realm (platform VM, client VM, the UI page): `players` and every handle reached through it are that realm's
// (isLocal is true only from the client VM and the UI, core §10.3), and the UI's is read-only (writes to `world.state` through
// it are ignored with a dev warning, core §7.5). Everything is read from the kernel at the moment of the read; nothing here
// touches the place manager, so the handle works before C4 wires it.
//
//   state         the write-through proxy over kernel.worldState (ctx/state-bag.ts)
//   players       `[PlayerView(body)]` from the moment spawnHuman ran, through every place load; `[]` before. Bots are not players
//   places        an object keyed by every roster place, resident or not; `Object.keys` lists the roster; an unknown key reads
//                 undefined (`placeExists(ctx, "lobby")`, authored module)
//   files         the carried tree list (authored module filters it for the place's cells)
//   assets        `assets[ref]` → the asset facts port (bounds, gait, clips)
//   camera        the camera port's values, a fresh object per read (`aspect` undefined before frame 1: never a default)
//   inputs        the input port's declared map (world-config inputs after the import edits and the user's binds)
//   engine        world-config `engine` over `{ ui: { referenceHeight: 1080, theme: { font: 'Geist' } } }`
// Game modules are strict-mode code: every member has a setter that ignores the write instead of throwing.
import type { Realm } from '../store/proxies.ts';
import type { AssetFacts, InputsDef, PlaceHandle, PlaceId, PlacesCollection, PlayerView, TreePath, WorldHandle } from '../types.ts';
import { isPlainObject } from '../wire.ts';
import type { CtxShared } from './common.ts';

type Obj = Record<string, unknown>;

const ENGINE_DEFAULTS: Readonly<Obj> = Object.freeze({ ui: Object.freeze({ referenceHeight: 1080, theme: Object.freeze({ font: 'Geist' }) }) });
const EMPTY: Readonly<Obj> = Object.freeze({});
const NO_TABS: readonly never[] = Object.freeze([]);

/** `over` merged over `base` (plain objects deep, the rest replaces), frozen at every level */
function mergeFrozen(base: unknown, over: unknown): unknown {
  if (!isPlainObject(over)) return over === undefined ? freezeDeep(base) : freezeDeep(over);
  const out: Obj = {};
  if (isPlainObject(base)) for (const k of Object.keys(base)) out[k] = base[k];
  for (const k of Object.keys(over)) out[k] = mergeFrozen(isPlainObject(base) ? base[k] : undefined, over[k]);
  for (const k of Object.keys(out)) out[k] = freezeDeep(out[k]);
  return Object.freeze(out);
}

function freezeDeep<T>(v: T): T {
  if (v === null || typeof v !== 'object' || Object.isFrozen(v)) return v;
  if (Array.isArray(v)) return Object.freeze(v.map((x: unknown) => freezeDeep(x))) as T;
  if (!isPlainObject(v)) return v;
  const out: Obj = {};
  for (const k of Object.keys(v)) out[k] = freezeDeep(v[k]);
  return Object.freeze(out) as T;
}

/** setters that ignore the write for every getter-only member of a handle class (strict-mode game code must not throw) */
export function ignoreWrites(proto: object, warn: (self: unknown, member: string) => void): void {
  for (const name of Object.getOwnPropertyNames(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, name)!;
    if (typeof d.get !== 'function' || d.set !== undefined) continue;
    Object.defineProperty(proto, name, {
      ...d,
      set(this: unknown, _v: unknown) {
        warn(this, name);
      },
    });
  }
}

export class WorldHandleImpl implements WorldHandle {
  readonly #s: CtxShared;
  readonly #realm: Realm;
  #places: PlacesCollection | null = null;
  #assets: Record<string, AssetFacts | undefined> | null = null;
  #engine: Obj | null = null;
  #ui: Obj | null = null;

  constructor(shared: CtxShared, realm: Realm) {
    this.#s = shared;
    this.#realm = realm;
  }

  /** @internal dev warning of an ignored write */
  static ignored(h: WorldHandleImpl, member: string): void {
    h.#s.warn(`write to world.${member} ignored (read-only)`);
  }

  get state(): Record<string, any> {
    return this.#s.worldBag.view(this.#realm === 'ui');
  }
  /** `world.state = {…}` replaces the contents (a copy); ignored from the UI realm */
  set state(v: Record<string, any>) {
    if (this.#realm === 'ui') this.#s.warn('write to world.state through the read-only UI view ignored');
    else this.#s.worldBag.replace(v);
  }

  get players(): PlayerView[] {
    const store = this.#s.k.store;
    const body = store.get(this.#s.k.ids.humanBody);
    return body !== undefined && body.player !== null ? [store.handle(body, this.#realm) as PlayerView] : [];
  }

  get places(): PlacesCollection {
    if (this.#places !== null) return this.#places;
    const s = this.#s;
    const realm = this.#realm;
    const handle = (key: string | symbol): PlaceHandle | undefined => (typeof key === 'string' && s.onRoster(key) ? s.place(key, realm) : undefined);
    const roster = (): PlaceId[] => Object.keys(s.k.placeIndex.placeIndex);
    this.#places = new Proxy(Object.create(null) as PlacesCollection, {
      get: (_t, key) => handle(key),
      has: (_t, key) => typeof key === 'string' && s.onRoster(key),
      ownKeys: roster,
      getOwnPropertyDescriptor: (_t, key) => {
        const h = handle(key);
        return h === undefined ? undefined : { value: h, enumerable: true, configurable: true, writable: false };
      },
      set: () => true,
      deleteProperty: () => true,
      defineProperty: () => true,
    });
    return this.#places;
  }

  get defaultPlace(): PlaceId {
    return this.#s.k.worldConfig.defaultPlace;
  }

  get files(): readonly TreePath[] {
    return this.#s.k.tree.files;
  }

  get assets(): Record<string, AssetFacts | undefined> {
    if (this.#assets !== null) return this.#assets;
    const k = this.#s.k;
    const get = (key: string | symbol): AssetFacts | undefined => (typeof key === 'string' ? k.ports.assets.get(key) : undefined);
    this.#assets = new Proxy(Object.create(null) as Record<string, AssetFacts | undefined>, {
      get: (_t, key) => get(key),
      has: (_t, key) => get(key) !== undefined,
      // the port keeps no list of its refs
      ownKeys: () => [],
      getOwnPropertyDescriptor: (_t, key) => {
        const v = get(key);
        return v === undefined ? undefined : { value: v, enumerable: true, configurable: true, writable: false };
      },
      set: () => true,
      deleteProperty: () => true,
      defineProperty: () => true,
    });
    return this.#assets;
  }

  get camera(): { aspect?: number | undefined; fov?: number | undefined } & Record<string, unknown> {
    return { ...this.#s.k.ports.camera.worldCamera() };
  }

  get inputs(): InputsDef {
    return this.#s.k.ports.input.declared;
  }

  get engine(): Record<string, unknown> {
    return (this.#engine ??= mergeFrozen(ENGINE_DEFAULTS, this.#s.k.worldConfig.engine) as Obj);
  }

  get ui(): Record<string, unknown> {
    return (this.#ui ??= freezeDeep({ ...(this.#s.k.worldConfig.ui ?? {}) }) as Obj);
  }

  get routing(): null {
    return null;
  }

  /** the world's player layer: nothing is configured in this build */
  get player(): Record<string, unknown> {
    return EMPTY;
  }

  get mode(): 'live' {
    return 'live';
  }

  get id(): string | null {
    return this.#s.k.worldId;
  }

  get address(): null {
    return null;
  }

  /** true while boot (`kernel.booting`) or a sim-side place load is in progress (core §11.5, §14) */
  get settling(): boolean {
    return this.#s.k.settling;
  }

  get godMode(): Record<string, never> {
    return EMPTY as Record<string, never>;
  }

  get creatorTabs(): readonly never[] {
    return NO_TABS;
  }
}
ignoreWrites(WorldHandleImpl.prototype, (self, member) => WorldHandleImpl.ignored(self as WorldHandleImpl, member));
