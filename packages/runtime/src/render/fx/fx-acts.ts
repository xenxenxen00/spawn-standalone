// R10: the game `fx` act → `FxRuntime.emit` routing (docs/architecture.md X-12; render §13).
//
// The act router (act-wiring.ts `renderActs`) buffers `fx` acts until the renderer registers a handler, then replays
// them in emit order; the `fx-<id>` destroy act ends the effect the `fx` act with the same id started. This module is
// the renderer's side of that contract: the act id → effect id table the router itself cannot see.
import type { ActEnvelope } from '../../compat/core/ports.ts';
import type { FxEffectId, FxRuntime } from './fx-system.ts';

/** the world-space origin as `FxRuntime.emit` takes it */
export type FxActOrigin = Parameters<FxRuntime['emit']>[1];

/** the act-router surface the fx routing needs (`ActWiring.renderActs` satisfies it) */
export interface FxActRouter {
  register(name: 'fx', handler: (envelope: ActEnvelope) => void): () => void;
  registerEnd(prefix: 'fx-', handler: (id: string) => void): () => void;
}

/** the surface of the fx runtime the act routing needs (the real `FxRuntime` satisfies it) */
export interface FxActTarget {
  emit(spec: unknown, origin: FxActOrigin): FxEffectId | null;
  end(id: FxEffectId): void;
  /** true while the runtime still tracks the effect; finished one-shots are removed by `update` */
  has(id: FxEffectId): boolean;
}

/** payload fields that may carry the effect's world-space origin, in order (the impulse act's `position` first) */
const ORIGIN_FIELDS = ['position', 'origin'] as const;

const isXyz = (v: unknown): v is { readonly x: number; readonly y: number; readonly z: number } =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { readonly x?: unknown }).x === 'number' &&
  typeof (v as { readonly y?: unknown }).y === 'number' &&
  typeof (v as { readonly z?: unknown }).z === 'number';

/**
 * The world-space origin of a game `fx` act: the payload's `position` (the impulse act's convention), else `origin`,
 * else the world origin. The game-side emitter's exact origin field is still unconfirmed; this is the provisional
 * mapping (see the R10 activation note).
 */
export function fxActOrigin(payload: unknown): FxActOrigin {
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>;
    for (const field of ORIGIN_FIELDS) {
      const v = record[field];
      if (isXyz(v)) return [v.x, v.y, v.z];
    }
  }
  return [0, 0, 0];
}

/**
 * Routes game `fx` acts to `target.emit(spec, worldOrigin)` and their `fx-<id>` destroy acts to `target.end`. The
 * payload itself is the spec (`emit` takes it as `unknown`); an act without an id still emits, it just cannot be
 * ended individually. One-shot effects the runtime removes by itself in `update` never get a destroy act, so the
 * table prunes them: every `fx` act drops the entries the runtime no longer tracks, and a destroy act for an
 * already-gone effect skips the no-op `end` instead of handing a stale id to the runtime. After any `fx` act the
 * table holds only live effects, so repeated one-shots cannot grow it. Returns the disposer: it unregisters both
 * handlers, after which the router buffers `fx` again (a renderer rebuild, X3).
 */
export function registerFxActs(acts: FxActRouter, target: FxActTarget): () => void {
  const live = new Map<string, FxEffectId>();
  /** drop the entries of effects the runtime removed by itself (one-shots that ran their course) */
  const pruneRemoved = (): void => {
    for (const [actId, effect] of live) {
      if (!target.has(effect)) live.delete(actId);
    }
  };
  const offEmit = acts.register('fx', (envelope: ActEnvelope) => {
    pruneRemoved();
    const id = target.emit(envelope.payload, fxActOrigin(envelope.payload));
    if (envelope.id !== null && id !== null) live.set(envelope.id, id);
  });
  const offEnd = acts.registerEnd('fx-', (id: string) => {
    const effect = live.get(id);
    if (effect === undefined) return;
    live.delete(id);
    // already finished and removed by `update`: `end` would be a no-op; never hand a stale id to the runtime.
    if (!target.has(effect)) return;
    target.end(effect);
  });
  return () => {
    offEmit();
    offEnd();
    live.clear();
  };
}
