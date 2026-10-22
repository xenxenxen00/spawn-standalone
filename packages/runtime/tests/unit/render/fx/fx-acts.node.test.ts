// R10: the game `fx` act → `FxRuntime.emit` routing.
import { describe, expect, it } from 'vitest';
import type { ActEnvelope } from '../../../../src/compat/core/ports.ts';
import type { FxEffectId } from '../../../../src/render/fx/fx-system.ts';
import { fxActOrigin, registerFxActs, type FxActRouter, type FxActTarget } from '../../../../src/render/fx/fx-acts.ts';

const envelope = (id: string | null, payload: unknown): ActEnvelope =>
  ({ id, name: 'fx', payload, sourceId: null, sourcePlace: null }) as unknown as ActEnvelope;

const asFxId = (n: number): FxEffectId => n as FxEffectId;

/**
 * A production-shaped fx target: `has` is required (the real `FxRuntime.has` reads its effect map) and `update`
 * removes finished effects the way the real runtime's `update` does — every effect here is a one-shot that finishes
 * when `finishAll` runs. No optional capabilities.
 */
function setup() {
  const handlers = new Map<string, (a: ActEnvelope) => void>();
  const endHandlers = new Map<string, (id: string) => void>();
  let offs = 0;
  const router: FxActRouter = {
    register: (name, handler) => {
      handlers.set(name, handler);
      return () => {
        offs++;
        handlers.delete(name);
      };
    },
    registerEnd: (prefix, handler) => {
      endHandlers.set(prefix, handler);
      return () => {
        offs++;
        endHandlers.delete(prefix);
      };
    },
  };
  const emitted: Array<{ spec: unknown; origin: unknown }> = [];
  const ended: FxEffectId[] = [];
  const hasCalls: FxEffectId[] = [];
  const effects = new Map<FxEffectId, { finished: boolean }>();
  let next = 1;
  let refuse = false;
  const target: FxActTarget & { update(): void; finishAll(): void } = {
    emit: (spec, origin) => {
      emitted.push({ spec, origin });
      if (refuse) return null;
      const id = asFxId(next++);
      effects.set(id, { finished: false });
      return id;
    },
    end: (id) => {
      ended.push(id);
      effects.delete(id);
    },
    has: (id) => {
      hasCalls.push(id);
      return effects.has(id);
    },
    update: () => {
      for (const [id, effect] of effects) {
        if (effect.finished) effects.delete(id);
      }
    },
    finishAll: () => {
      for (const effect of effects.values()) effect.finished = true;
    },
  };
  const dispose = registerFxActs(router, target);
  const emit = (id: string | null, payload: unknown): void => {
    handlers.get('fx')!(envelope(id, payload));
  };
  const destroy = (id: string): void => {
    endHandlers.get('fx-')!(id);
  };
  return {
    handlers,
    endHandlers,
    emitted,
    ended,
    hasCalls,
    dispose,
    offs: () => offs,
    setRefuse: (v: boolean) => {
      refuse = v;
    },
    emit,
    destroy,
    update: () => target.update(),
    finishAll: () => target.finishAll(),
  };
}

describe('fxActOrigin', () => {
  it('reads the payload position', () => {
    expect(fxActOrigin({ position: { x: 1, y: 2, z: 3 } })).toEqual([1, 2, 3]);
  });

  it('falls back to the payload origin, with position winning', () => {
    expect(fxActOrigin({ origin: { x: 4, y: 5, z: 6 } })).toEqual([4, 5, 6]);
    expect(fxActOrigin({ position: { x: 1, y: 2, z: 3 }, origin: { x: 4, y: 5, z: 6 } })).toEqual([1, 2, 3]);
  });

  it('defaults to the world origin', () => {
    expect(fxActOrigin({})).toEqual([0, 0, 0]);
    expect(fxActOrigin('fx spark')).toEqual([0, 0, 0]);
    expect(fxActOrigin(null)).toEqual([0, 0, 0]);
    expect(fxActOrigin({ position: { x: 1 } })).toEqual([0, 0, 0]);
    expect(fxActOrigin({ position: null })).toEqual([0, 0, 0]);
  });
});

describe('registerFxActs', () => {
  it('registers the fx and fx- handlers', () => {
    const s = setup();
    expect(s.handlers.has('fx')).toBe(true);
    expect(s.endHandlers.has('fx-')).toBe(true);
  });

  it('routes an fx act to emit with its world origin', () => {
    const s = setup();
    const payload = { script: 'fx spark', position: { x: 1, y: 2, z: 3 } };
    s.emit('fx-7', payload);
    expect(s.emitted).toEqual([{ spec: payload, origin: [1, 2, 3] }]);
  });

  it('ends the effect on its fx-<id> destroy act, exactly once', () => {
    const s = setup();
    s.emit('fx-7', { script: 'fx spark' });
    s.destroy('fx-7');
    expect(s.ended).toEqual([asFxId(1)]);
    s.destroy('fx-7');
    expect(s.ended).toEqual([asFxId(1)]);
  });

  it('ignores the destroy act of an unknown id', () => {
    const s = setup();
    s.destroy('fx-99');
    expect(s.ended).toEqual([]);
  });

  it('emits without tracking when the act has no id', () => {
    const s = setup();
    s.emit(null, { script: 'fx spark' });
    expect(s.emitted.length).toBe(1);
    s.destroy('fx-1');
    expect(s.ended).toEqual([]);
  });

  it('does not track a refused emit', () => {
    const s = setup();
    s.setRefuse(true);
    s.emit('fx-8', { script: 'fx spark' });
    expect(s.emitted.length).toBe(1);
    s.destroy('fx-8');
    expect(s.ended).toEqual([]);
  });

  it('repeated one-shots are pruned: the table does not grow', () => {
    const s = setup();
    s.emit('fx-7', { script: 'fx spark' });
    s.emit('fx-8', { script: 'fx spark' });
    s.emit('fx-9', { script: 'fx spark' });
    // the one-shots finish and the runtime's update removes them, as the real FxRuntime does
    s.finishAll();
    s.update();
    s.hasCalls.length = 0;
    // the next fx act prunes every finished entry: the table holds only live effects afterwards
    s.emit('fx-10', { script: 'fx puff' });
    expect(s.hasCalls).toEqual([asFxId(1), asFxId(2), asFxId(3)]);
    // their destroy acts are now unknown: no end call, no further probing
    s.destroy('fx-7');
    s.destroy('fx-8');
    s.destroy('fx-9');
    expect(s.ended).toEqual([]);
    expect(s.hasCalls).toEqual([asFxId(1), asFxId(2), asFxId(3)]);
    // the live effect still ends normally
    s.destroy('fx-10');
    expect(s.ended).toEqual([asFxId(4)]);
  });

  it('a destroy act for an effect finished by update skips the no-op end', () => {
    const s = setup();
    s.emit('fx-7', { script: 'fx spark' });
    s.finishAll();
    s.update();
    s.destroy('fx-7');
    expect(s.ended).toEqual([]);
    s.destroy('fx-7');
    expect(s.ended).toEqual([]);
  });

  it('the disposer unregisters both handlers', () => {
    const s = setup();
    s.dispose();
    expect(s.handlers.size).toBe(0);
    expect(s.endHandlers.size).toBe(0);
    expect(s.offs()).toBe(2);
  });
});
