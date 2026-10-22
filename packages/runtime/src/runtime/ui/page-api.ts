// The page API the carried UI calls (io §3.6; spawn-engine-contract.md §12.2, §14): installed on `window` before `onMount`.
//
//   sendAction(name, payload, {down, relockPointer})  → ActionSink.inject (io §4.5): undeclared names dropped silently;
//                                                      relockPointer requests the lock synchronously inside the click
//   sendAxis(name, value)                              stub (no live caller)
//   openLink(url)                                      no-op unless the platform allows external links (Playgama does not,
//                                                      platform-playgama.md §3.3)
//   spawn.on('event', fn)                              the uiEvent bus (`ssBlood`, scripts/gore/screen.js:178)
//   spawn.assets / user / view                         empty stubs
//   the 15 game globals                                Object.assign(window, pick(mod, GAME_GLOBALS)) (system-ui.md §2.5)
//
// Every caller is an inline `onclick` attribute or a bare `sendAction(...)` inside the carried module, so these must be real
// properties of the page's global object.
import type { SendActionOptions } from '../input/action-sink.ts';
import type { GameUiModule } from './game-ui.d.ts';
import type { UiEventBus } from './ui-events.ts';
import { autoGlobalNames } from './auto-globals.ts';

/** the page globals `scripts/ui.js` exports (ui.js:34-48) */


/** the part of the ActionSink the page needs */
export interface ActionInjector {
  inject(name: string, payload?: unknown, opts?: SendActionOptions): boolean;
}

export interface PageApiDeps {
  actions: ActionInjector;
  events: UiEventBus;
  /** platform policy `externalLinks` true only: open the link (web builds); default no-op */
  openLink?: (url: string) => void;
  /** the global object(s) to install on; default the page's global object (`pageTargets()`) */
  target?: object | readonly object[];
  /** the game globals to install: a list of names, or 'auto' = every function the module exports (UiHostConfig.globals); default GAME_GLOBALS */
  globals?: readonly string[] | 'auto';
}

export interface SpawnPageObject {
  on(kind: 'event', fn: (name: string, payload: unknown) => void): () => void;
  readonly assets: Record<string, never>;
  readonly user: Record<string, never>;
  readonly view: Record<string, never>;
}

declare global {
  interface Window {
    sendAction(name: string, payload?: unknown, opts?: SendActionOptions): void;
    sendAxis(name: string, value: number): void;
    openLink(url: string): void;
    spawn: SpawnPageObject;
  }
}

/** sets `values` on every target and returns the function that puts back exactly what was there before */
export function installGlobals(targets: readonly object[], values: Readonly<Record<string, unknown>>): () => void {
  const undo: Array<() => void> = [];
  for (const target of targets) {
    const t = target as Record<string, unknown>;
    const saved = Object.keys(values).map((k) => [k, Object.getOwnPropertyDescriptor(t, k)] as const);
    for (const [k, v] of Object.entries(values)) {
      Object.defineProperty(t, k, { value: v, writable: true, configurable: true, enumerable: true });
    }
    undo.push(() => {
      for (const [k, d] of saved) {
        if (d) Object.defineProperty(t, k, d);
        else delete t[k];
      }
    });
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const u of undo.reverse()) u();
  };
}

/**
 * Where the page globals go: the given target, else the page's global object. In a browser `window`, `globalThis` and
 * `document.defaultView` are one object; a DOM emulation (jsdom under vitest) runs inline handlers against the document's own
 * window and module code against the host global, so every distinct one of them gets the globals.
 */
export function pageTargets(target?: object | readonly object[]): object[] {
  if (Array.isArray(target)) return [...(target as readonly object[])];
  if (target) return [target as object];
  const g = globalThis as { window?: object; document?: { defaultView?: object | null } };
  const out: object[] = [];
  for (const t of [globalThis, g.window, g.document?.defaultView]) if (t && !out.includes(t)) out.push(t);
  return out;
}

/** installs the page API and the game globals; returns the uninstall */
export function installPageApi(deps: PageApiDeps, mod: GameUiModule): () => void {
  const spawn: SpawnPageObject = Object.freeze({
    on(kind: 'event', fn: (name: string, payload: unknown) => void): () => void {
      if (kind !== 'event' || typeof fn !== 'function') return () => {};
      return deps.events.on(fn);
    },
    assets: Object.freeze({}) as Record<string, never>,
    user: Object.freeze({}) as Record<string, never>,
    view: Object.freeze({}) as Record<string, never>,
  });
  const values: Record<string, unknown> = {
    sendAction(name: string, payload?: unknown, opts?: SendActionOptions): void {
      deps.actions.inject(String(name), payload, opts ?? undefined);
    },
    sendAxis(_name: string, _value: number): void {
      // no live caller (io §3.1): the function exists so a stray call is harmless
    },
    openLink(url: string): void {
      if (typeof url === 'string' && deps.openLink) deps.openLink(url);
    },
    spawn,
  };
  const m = mod as unknown as Record<string, unknown>;
  const names = deps.globals === undefined || deps.globals === 'auto' ? autoGlobalNames(mod) : deps.globals;
  for (const name of names) {
    const f = m[name];
    if (typeof f === 'function' && !(name in values)) values[name] = f;
  }
  return installGlobals(pageTargets(deps.target), values);
}
