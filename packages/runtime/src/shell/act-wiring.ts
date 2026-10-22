// Copied from purge-protocol-web ebab692 (src/app or src/platform, same file name; web-platform.ts is platform/web.ts).
// The act routing table (docs/architecture.md X-12, X-47, §3.1, §11; core §8.6, §15.6; io §2.3, §5.5; WP X1).
//
// The kernel mints the ids and runs the one visibility filter; each act name then has exactly one handler on `kernel.acts`.
// This module registers every one of them once, at compose time, and never again: a domain that lands later, or a renderer
// that comes and goes, plugs into the registration that is already there, so the kernel's router never sees a second handler
// for a name (`metrics.actsDoubleRegistered` stays 0) and no act is unhandled in between.
//
//   playSound, stopSound    the audio engine (`playSound(id, payload, { sourceId, sourcePlace })`); the end of a `snd-<n>`
//                           (`ctx.destroy('snd-3')`) is `stopSound({ soundId })`
//   fx, decal               the renderer. Until it has registered its handler they are buffered with their emit time on the
//                           presentation clock (at most 512 over both, the oldest dropped; the end of a buffered `fx-<n>`
//                           removes it) and replayed, in emit order per act, when the handler arrives. An act whose lifetime
//                           has run out by then is not replayed
//   shockwave, shake        the renderer; dropped while it has no handler (nothing is visible behind the menu)
//   hitstop                 `presentation.hitstop(payload.duration)` (X-11: a presentation freeze, never a sim stop)
//   screenShake, cameraPunch   the camera juice (CA2): `deps.juice.register(acts)` when there is one, else no-ops
//   screenFlash             no-op by default (X-12: the live act showed nothing); the opt-in overlay of the UI chrome (UI2b)
//                           plugs in with `setSink('screenFlash', …)`
//   damageNumber            the UI host's damage numbers (UI2b) through `setSink('damageNumber', …)`; nothing until then
//   uiEvent {name, payload} the UI host's event bus (`window.spawn.on('event')` subscribers)
//   impulse                 `physics.applyImpulse(target, impulse, angularImpulse, position)` on the port in force
//   highlightSet / Clear    X-47: state, not events (scripts/player/team-glow.js sends a mark only when it changes). The table
//                           keeps the latest `{ color, style }` per target, drops it on `highlightClear` and when the row is
//                           destroyed, and hands the whole table to the highlight sink (`special/highlight.ts`, RH1) when it
//                           attaches (engine-loader.ts, the game's `GameWorld.highlights`) and again after a renderer
//                           rebuild (X3). Both names are engine acts (rules.ts ACT_NAMES, RH1); a router that does not know
//                           them (an `isActName` of a test) gets no registration
//   milestone               the TrophyStore's (TR1): `deps.trophies.unlock(name)`; registered here like every other
//                           act, a no-op without a store; needs no renderer
//   slowMo                  ignored and counted by the kernel itself
//
// The renderer's side. `renderer.registerActs(wiring.renderActs)` gets a router of this module's: a registration of one of the
// four render acts or of the `fx-` end is kept here and called from the standing registration; its disposer hands the act back
// to the buffer (a rebuild, X3). Anything else a renderer registers goes to the kernel's router unchanged.
//
// Lifetime of a buffered act: `payload.lifetime` in seconds when it is a finite positive number (the decal act's field,
// render §12.1), measured on the presentation clock (paused time does not age it). An `fx` payload names a program and its
// parameters, and the program decides how long it lives, so an `fx` normally has no lifetime here and is replayed.
import type { ActEnvelope, ActRouter } from '../compat/core/ports.ts';
import { isActName as isEngineAct } from '../compat/core/rules.ts';
import type { ActName, RowId, Vec3 } from '../compat/core/types.ts';

/** buffered `fx` + `decal` acts while the renderer has no handler (docs/architecture.md §3.1) */
export const ACT_BUFFER_CAP = 512;

/** the acts the render domain handles (X-12) */
export const RENDER_ACTS = Object.freeze(['fx', 'decal', 'shockwave', 'shake'] as const);
export type RenderAct = (typeof RENDER_ACTS)[number];
const BUFFERED: ReadonlySet<string> = new Set(['fx', 'decal']);
const isRenderAct = (name: string): name is RenderAct => (RENDER_ACTS as readonly string[]).includes(name);

/** the acts a later package plugs into with `setSink` */
export type SinkAct = 'damageNumber' | 'screenFlash';

/** X-47: `ctx.emit('highlightSet', { target, color, style, width?, duration?, intensity? })`; the optional ones only when sent */
export interface HighlightMark {
  color: unknown;
  style: unknown;
  width?: unknown;
  duration?: unknown;
  intensity?: unknown;
}

/** the optional highlightSet fields forwarded to the sink when the payload carries them */
export const HIGHLIGHT_OPTIONAL_FIELDS = ['width', 'duration', 'intensity'] as const;

/** `special/highlight.ts` (RH1) as the wiring drives it */
export interface HighlightSink {
  /** the whole table: on attach and after a renderer rebuild */
  reset(marks: ReadonlyMap<RowId, HighlightMark>): void;
  set(target: RowId, mark: HighlightMark): void;
  clear(target: RowId): void;
}

export interface ActWiringDeps {
  /** `kernel.acts` */
  acts: ActRouter;
  audio: { playSound(id: string, payload: never, meta: { sourceId: string | null; sourcePlace: string | null }): void; stopSound(payload: never): void };
  /** the physics port in force (`kernel.ports.physics`), read at each act */
  physics(): { applyImpulse(target: RowId, impulse?: Vec3, angularImpulse?: Vec3, position?: Vec3): void };
  /** the UI host's port (`uiEvent` → `window.spawn.on` subscribers) */
  ui: { uiEvent(name: string, payload: unknown): void };
  /** X-11; `now()` stamps buffered acts */
  presentation: { hitstop(seconds: number): void; now(): number };
  /** CA2's `Juice`: registers `screenShake` and `cameraPunch` itself; without one both are no-ops */
  juice?: { register(acts: ActRouter): void } | null;
  /** `kernel.on('rowDestroyed', …)` reduced to the row id; returns the unsubscribe */
  onRowDestroyed?: (cb: (rowId: RowId) => void) => () => void;
  /** default: rules.ts `isActName` */
  isActName?: (name: string) => boolean;
  /** TR1: the TrophyStore; without one the `milestone` act is registered but a no-op */
  trophies?: { unlock(name: string): boolean } | null;
  /** default console.warn */
  log?: (msg: string) => void;
}

export interface ActWiring {
  /** what `renderer.registerActs` gets */
  readonly renderActs: ActRouter;
  /** `renderer.registerActs(renderActs)`: buffered acts are replayed as its handlers arrive */
  attachRenderer(renderer: { registerActs(acts: ActRouter): void }): void;
  /** the renderer is gone: its handlers are forgotten, `fx` and `decal` are buffered again */
  detachRenderer(): void;
  /** the handler behind `damageNumber` / `screenFlash`; null puts the default back (nothing) */
  setSink(name: SinkAct, handler: ((a: ActEnvelope) => void) | null): void;
  /** the highlight renderer attached (the whole table is handed over), or went away (null) */
  setHighlightSink(sink: HighlightSink | null): void;
  readonly highlights: ReadonlyMap<RowId, HighlightMark>;
  /** `fx` + `decal` acts waiting for the renderer */
  readonly buffered: number;
  /** buffered acts dropped because the buffer was full */
  readonly dropped: number;
  dispose(): void;
}

interface Buffered {
  env: ActEnvelope;
  /** presentation ms at emit */
  at: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const vec = (v: unknown): Vec3 | undefined => (isObject(v) && Number.isFinite(v['x']) && Number.isFinite(v['y']) && Number.isFinite(v['z']) ? (v as unknown as Vec3) : undefined);

/** seconds a buffered act lives; null = unknown (it is replayed) */
export function actLifetimeS(env: ActEnvelope): number | null {
  const p = env.payload;
  if (!isObject(p)) return null;
  const life = p['lifetime'];
  return typeof life === 'number' && Number.isFinite(life) && life > 0 ? life : null;
}

export function createActWiring(deps: ActWiringDeps): ActWiring {
  const { acts, presentation } = deps;
  const known = deps.isActName ?? isEngineAct;
  const log = deps.log ?? ((m: string): void => console.warn(m));
  const reported = new Set<string>();
  const offs: Array<() => void> = [];

  const renderHandlers = new Map<RenderAct, (a: ActEnvelope) => void>();
  let renderFxEnd: ((id: string) => void) | null = null;
  const sinks = new Map<SinkAct, (a: ActEnvelope) => void>();
  let buffer: Buffered[] = [];
  let dropped = 0;
  const highlights = new Map<RowId, HighlightMark>();
  let highlightSink: HighlightSink | null = null;

  /** a throwing handler is this module's to report: the game's emit must not see it */
  const guard = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      const msg = `act ${what}: ${e instanceof Error ? e.message : String(e)}`;
      if (reported.has(msg)) return;
      if (reported.size < 64) reported.add(msg);
      log(msg);
    }
  };

  const on = (name: string, handler: (a: ActEnvelope) => void): void => {
    if (!known(name)) return;
    offs.push(acts.register(name as ActName, (a) => guard(name, () => handler(a))));
  };

  // ── audio ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  on('playSound', (a) => {
    if (a.id !== null) deps.audio.playSound(a.id, a.payload as never, { sourceId: a.sourceId, sourcePlace: a.sourcePlace });
  });
  on('stopSound', (a) => deps.audio.stopSound(a.payload as never));
  offs.push(acts.registerEnd('snd-', (id) => guard('end snd-', () => deps.audio.stopSound({ soundId: id } as never))));

  // ── render ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const render = (name: RenderAct, a: ActEnvelope): void => {
    const handler = renderHandlers.get(name);
    if (handler) {
      handler(a);
      return;
    }
    if (!BUFFERED.has(name)) return; // shockwave, shake: nothing is visible yet
    buffer.push({ env: a, at: presentation.now() });
    if (buffer.length > ACT_BUFFER_CAP) {
      dropped += buffer.length - ACT_BUFFER_CAP;
      buffer.splice(0, buffer.length - ACT_BUFFER_CAP);
    }
  };
  for (const name of RENDER_ACTS) on(name, (a) => render(name, a));
  offs.push(
    acts.registerEnd('fx-', (id) =>
      guard('end fx-', () => {
        const i = buffer.findIndex((b) => b.env.id === id);
        if (i >= 0) buffer.splice(i, 1);
        else renderFxEnd?.(id);
      }),
    ),
  );

  /** the handler of `name` arrived: its buffered acts, in emit order, minus the ones that have run out */
  const replay = (name: RenderAct, handler: (a: ActEnvelope) => void): void => {
    if (!BUFFERED.has(name) || buffer.length === 0) return;
    const now = presentation.now();
    const mine: Buffered[] = [];
    const rest: Buffered[] = [];
    for (const b of buffer) (b.env.name === name ? mine : rest).push(b);
    buffer = rest;
    for (const b of mine) {
      const life = actLifetimeS(b.env);
      if (life !== null && now - b.at >= life * 1000) continue;
      guard(name, () => handler(b.env));
    }
  };

  const renderActs: ActRouter = {
    register(name, handler) {
      if (!isRenderAct(name)) return acts.register(name, handler);
      if (renderHandlers.has(name)) log(`[acts] the renderer registered ${name} twice; the second handler replaces the first`);
      renderHandlers.set(name, handler);
      replay(name, handler);
      return () => {
        if (renderHandlers.get(name) === handler) renderHandlers.delete(name);
      };
    },
    registerEnd(prefix, handler) {
      if (prefix !== 'fx-') return acts.registerEnd(prefix, handler);
      renderFxEnd = handler;
      return () => {
        if (renderFxEnd === handler) renderFxEnd = null;
      };
    },
  };

  // ── presentation, camera juice, UI, physics ────────────────────────────────────────────────────────────────────────
  on('hitstop', (a) => {
    const d = isObject(a.payload) ? a.payload['duration'] : undefined;
    if (typeof d === 'number') presentation.hitstop(d);
  });
  if (deps.juice) deps.juice.register(acts);
  else for (const name of ['screenShake', 'cameraPunch']) on(name, () => {});
  for (const name of ['screenFlash', 'damageNumber'] as const) on(name, (a) => sinks.get(name)?.(a));
  on('uiEvent', (a) => {
    const p = a.payload;
    if (isObject(p) && typeof p['name'] === 'string') deps.ui.uiEvent(p['name'], p['payload']);
  });
  on('impulse', (a) => {
    const p = a.payload;
    if (!isObject(p) || typeof p['target'] !== 'string' || p['target'] === '') return;
    deps.physics().applyImpulse(p['target'], vec(p['impulse']), vec(p['angularImpulse']), vec(p['position']));
  });

  // ── trophies (TR1, X-47) ─────────────────────────────────────────────────────────────────────────────────────────────
  // `milestone { name }`: the Director's judge and the player's ear route every trophy here; the TrophyStore
  // unlocks it (first-time unlock → flush + the one platform achievement event). Without a store the act is
  // registered but a no-op, like screenShake/cameraPunch without juice.
  on('milestone', (a) => {
    const p = a.payload;
    const name = isObject(p) ? p['name'] : undefined;
    if (typeof name === 'string' && name !== '') deps.trophies?.unlock(name);
  });

  // ── highlights (X-47) ──────────────────────────────────────────────────────────────────────────────────────────────
  const clearMark = (target: RowId): void => {
    if (!highlights.delete(target)) return;
    if (highlightSink) guard('highlightClear', () => highlightSink?.clear(target));
  };
  on('highlightSet', (a) => {
    const p = a.payload;
    if (!isObject(p) || typeof p['target'] !== 'string' || p['target'] === '') return;
    const mark: HighlightMark = { color: p['color'], style: p['style'] };
    for (const k of HIGHLIGHT_OPTIONAL_FIELDS) if (p[k] !== undefined) mark[k] = p[k];
    highlights.set(p['target'], mark);
    highlightSink?.set(p['target'], mark);
  });
  on('highlightClear', (a) => {
    const p = a.payload;
    if (isObject(p) && typeof p['target'] === 'string') clearMark(p['target']);
  });
  if (deps.onRowDestroyed) offs.push(deps.onRowDestroyed((id) => clearMark(id)));

  return {
    renderActs,
    attachRenderer(renderer) {
      renderer.registerActs(renderActs);
    },
    detachRenderer() {
      renderHandlers.clear();
      renderFxEnd = null;
    },
    setSink(name, handler) {
      if (handler === null) sinks.delete(name);
      else sinks.set(name, handler);
    },
    setHighlightSink(sink) {
      highlightSink = sink;
      if (sink) guard('highlight reset', () => sink.reset(highlights));
    },
    highlights,
    get buffered() {
      return buffer.length;
    },
    get dropped() {
      return dropped;
    },
    dispose() {
      for (const off of offs.splice(0).reverse()) off();
      renderHandlers.clear();
      renderFxEnd = null;
      sinks.clear();
      highlightSink = null;
      buffer = [];
    },
  };
}

/** what `wireActs` needs of the composition root (the `App` satisfies it) */
export interface ActWiringHost {
  kernel: {
    acts: ActRouter;
    ports: { physics: { applyImpulse(target: RowId, impulse?: Vec3, angularImpulse?: Vec3, position?: Vec3): void } };
    on(event: 'rowDestroyed', fn: (row: { id: RowId }) => void): () => void;
  };
  audio: ActWiringDeps['audio'];
  ui: ActWiringDeps['ui'];
  presentation: ActWiringDeps['presentation'];
  juice?: ActWiringDeps['juice'];
  /** TR1: the TrophyStore behind the `milestone` act */
  trophies: NonNullable<ActWiringDeps['trophies']>;
}

/** docs/architecture.md §3.1 `wireActs(app)`: the table on `kernel.acts` */
export function wireActs(host: ActWiringHost): ActWiring {
  return createActWiring({
    acts: host.kernel.acts,
    audio: host.audio,
    physics: () => host.kernel.ports.physics,
    ui: host.ui,
    presentation: host.presentation,
    juice: host.juice ?? null,
    trophies: host.trophies,
    onRowDestroyed: (cb) => host.kernel.on('rowDestroyed', (row) => cb(row.id)),
  });
}
