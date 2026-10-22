// The UI page ctx (docs/design/core-runtime.md §7.5; docs/architecture.md X-25; io §3.5; contract §4.2, §14.1): what
// `render(ctx, player)` of `scripts/ui.js` receives. One object per render call (cheap: three closures and nothing else until
// a member is read); the UI host attaches its own state as `ctx.port` before the render (src/runtime/ui/ui-ctx.ts).
//
//   self        the human body's read-only handle (the UI realm's: every setter and nested write is a no-op, counted by the
//               store), or null while there is no human
//   world       the read-only world handle: `isLocal` reads true (the page reads through the client VM); writes to
//               `world.state` through it are ignored with a dev warning
//   session     a copy-on-write overlay of the client VM's session: reads fall through to the live session, writes land in
//               the overlay and are gone with the ctx (the next render gets a fresh one). Nested objects are overlaid too
//               (`ctx.session.ui.panel = 'x'` leaves the live `ui` object alone); `delete`, `in` and `Object.keys` see overlay
//               + base; nothing is cloned and an unwritten nested read keeps its identity within a render. It never throws.
//   getObject   the read-only handle of any resident row of any place, client-local rows included (X-24)
//   now, random, log / warn / error, view.camera   as every ctx (ctx/common.ts)
//   port        left undefined here: the UI host's extension slot (PortUiState)
// The page-local objects the game builds with a `ctx` name (`mySlot`, `meUserId`, `roles`, …, scripts/ui/lib/slots.js) are not
// engine members.
import { extOf } from '../ext.ts';
import { getObject, type Viewer } from '../query.ts';
import type { ObjectView, PlaceHandle, RowId, UiCtx, WorldHandle } from '../types.ts';
import { ignoreCtxWrites, type CtxKernel, type CtxShared, type ScriptLog } from './common.ts';

const UI_VIEWER: Viewer = Object.freeze({ kind: 'ui' });
/** the script path the UI realm's log lines carry */
export const UI_LOG_SCRIPT = 'ui';

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v: unknown): v is object => typeof v === 'object' && v !== null;
const INDEX = /^(?:0|[1-9]\d*)$/;

interface Layer {
  /** keys assigned through the overlay */
  readonly own: Map<string, unknown>;
  /** base keys deleted through the overlay */
  readonly gone: Set<string>;
}

/** the overlay of one render: a proxy per live object, created on first read */
class SessionOverlay {
  readonly #views = new WeakMap<object, object>();

  view(base: object): object {
    let v = this.#views.get(base);
    if (v === undefined) {
      const layer: Layer = { own: new Map(), gone: new Set() };
      v = new Proxy(Array.isArray(base) ? [] : {}, this.#handler(base, layer));
      this.#views.set(base, v);
    }
    return v;
  }

  #handler(base: object, layer: Layer): ProxyHandler<object> {
    const isArray = Array.isArray(base);
    const live = (key: string): boolean => !layer.gone.has(key) && hasOwn(base, key);
    const read = (key: string): unknown => {
      if (layer.own.has(key)) return layer.own.get(key);
      if (!live(key)) return undefined;
      const v = (base as Record<string, unknown>)[key];
      return isObj(v) ? this.view(v) : v;
    };
    const length = (): number => (layer.own.has('length') ? Number(layer.own.get('length')) : (base as unknown[]).length);
    /** `list.length = n`: the elements past the new length are gone from the view, as on a real array (never from the live one) */
    const setLength = (value: unknown): void => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) return;
      for (const k of [...layer.own.keys()]) if (INDEX.test(k) && Number(k) >= n) layer.own.delete(k);
      for (let i = n; i < (base as unknown[]).length; i++) layer.gone.add(String(i));
      layer.own.set('length', n);
    };
    return {
      get: (target, key) => {
        if (typeof key === 'symbol') return Reflect.get(target, key);
        if (isArray && key === 'length') return length();
        if (layer.own.has(key) || live(key)) return read(key);
        // inherited members (Array.prototype methods, Object.prototype ones) run against the overlay
        return Reflect.get(target, key);
      },
      set: (_target, key, value) => {
        if (typeof key === 'symbol') return true;
        if (isArray && key === 'length') {
          setLength(value);
          return true;
        }
        layer.gone.delete(key);
        layer.own.set(key, value);
        if (isArray && INDEX.test(key) && Number(key) >= length()) layer.own.set('length', Number(key) + 1);
        return true;
      },
      deleteProperty: (_target, key) => {
        if (typeof key === 'symbol') return true;
        layer.own.delete(key);
        if (hasOwn(base, key)) layer.gone.add(key);
        return true;
      },
      defineProperty: (_target, key, desc) => {
        if (typeof key !== 'symbol' && 'value' in desc) {
          layer.gone.delete(key);
          layer.own.set(key, desc.value);
        }
        return true;
      },
      has: (target, key) => (typeof key === 'symbol' ? Reflect.has(target, key) : layer.own.has(key) || live(key) || Reflect.has(target, key)),
      ownKeys: () => {
        const keys: string[] = [];
        for (const k of Object.keys(base)) if (!layer.gone.has(k)) keys.push(k);
        for (const k of layer.own.keys()) if (k !== 'length' && !keys.includes(k)) keys.push(k);
        // an array-shaped view must list its target's own non-configurable `length`
        if (isArray) keys.push('length');
        return keys;
      },
      getOwnPropertyDescriptor: (_target, key) => {
        if (typeof key === 'symbol') return undefined;
        if (isArray && key === 'length') return { value: length(), writable: true, enumerable: false, configurable: false };
        if (!layer.own.has(key) && !live(key)) return undefined;
        return { value: read(key), writable: true, enumerable: true, configurable: true };
      },
    };
  }
}

export class UiCtxImpl {
  readonly #s: CtxShared;
  #session: Record<string, any> | null = null;
  declare now: () => number;
  declare random: () => number;
  declare log: ScriptLog['log'];
  declare warn: ScriptLog['warn'];
  declare error: ScriptLog['error'];
  declare getObject: (id: RowId) => Readonly<ObjectView> | null;
  /** PortUiState, attached by the UI host before each render (X-25) */
  declare port?: unknown;
  /** ext.uiPlace only: the read-only handle of the viewer's place (absent otherwise, as in the base runtime) */
  declare readonly place?: PlaceHandle;

  constructor(shared: CtxShared) {
    this.#s = shared;
    const k = shared.k;
    const logs = shared.logger(UI_LOG_SCRIPT);
    this.now = shared.now;
    this.random = shared.random;
    this.log = logs.log;
    this.warn = logs.warn;
    this.error = logs.error;
    this.getObject = (id) => getObject(k, UI_VIEWER, id);
    if (extOf(k).uiPlace) {
      Object.defineProperty(this, 'place', {
        enumerable: true,
        get: () => {
          const body = k.store.get(k.ids.humanBody);
          return shared.place((body !== undefined && body.player !== null ? body.place : null) ?? k.worldConfig.defaultPlace, 'ui');
        },
        set: () => {},
      });
    }
  }

  get kind(): 'ui' {
    return 'ui';
  }

  /** the viewer's body (`player.controlling` is always null in this build) */
  get self(): Readonly<ObjectView> | null {
    const store = this.#s.k.store;
    const body = store.get(this.#s.k.ids.humanBody);
    return body !== undefined && body.player !== null ? store.handle(body, 'ui') : null;
  }

  get world(): WorldHandle {
    return this.#s.world('ui');
  }

  get session(): Record<string, any> {
    return (this.#session ??= new SessionOverlay().view(this.#s.k.vms.client.session) as Record<string, any>);
  }

  get view(): UiCtx['view'] {
    return this.#s.view;
  }
}

ignoreCtxWrites(UiCtxImpl);

/** core §7.5: the UI realm ctx for one render call */
export function createUiCtx(k: CtxKernel): UiCtx {
  return new UiCtxImpl(k.ctx) as unknown as UiCtx;
}
