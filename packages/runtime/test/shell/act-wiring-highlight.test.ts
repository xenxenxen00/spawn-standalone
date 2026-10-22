// highlightSet: the optional width / duration / intensity fields reach the highlight sink (render's HighlightMarkInput).
import { describe, expect, it } from 'vitest';
import type { ActRouter } from '../../src/compat/core/ports.ts';
import { createActWiring, type HighlightMark } from '../../src/shell/act-wiring.ts';

function router() {
  const handlers = new Map<string, (a: { name: string; payload: unknown }) => void>();
  const acts = {
    register(name: string, handler: (a: { name: string; payload: unknown }) => void) {
      handlers.set(name, handler);
      return () => void handlers.delete(name);
    },
    registerEnd: () => () => {},
  } as unknown as ActRouter;
  const emit = (name: string, payload: unknown): void => handlers.get(name)?.({ name, payload });
  return { acts, emit };
}

function wiring() {
  const r = router();
  const w = createActWiring({
    acts: r.acts,
    audio: { playSound() {}, stopSound() {} },
    physics: () => ({ applyImpulse() {} }),
    ui: { uiEvent() {} },
    presentation: { hitstop() {}, now: () => 0 },
    log: () => {},
  });
  const set: Array<[string, HighlightMark]> = [];
  const resets: Array<Map<string, HighlightMark>> = [];
  w.setHighlightSink({ reset: (m) => void resets.push(new Map(m)), set: (t, m) => void set.push([t, m]), clear() {} });
  return { ...r, w, set, resets };
}

describe('act wiring: highlightSet', () => {
  it('forwards width, duration and intensity when the payload carries them', () => {
    const t = wiring();
    t.emit('highlightSet', { target: 'r1', color: '#f00', style: 'outline', width: 3, duration: 1.5, intensity: 0.8 });
    expect(t.set).toEqual([['r1', { color: '#f00', style: 'outline', width: 3, duration: 1.5, intensity: 0.8 }]]);
    expect(t.w.highlights.get('r1')).toEqual({ color: '#f00', style: 'outline', width: 3, duration: 1.5, intensity: 0.8 });
  });

  it('keeps the mark to color and style when the optional fields are absent', () => {
    const t = wiring();
    t.emit('highlightSet', { target: 'r2', color: 'blue', style: 'glow' });
    expect(t.set).toEqual([['r2', { color: 'blue', style: 'glow' }]]);
    expect(Object.keys(t.set[0]![1])).toEqual(['color', 'style']);
  });

  it('a sink attached later gets the full marks in its reset', () => {
    const t = wiring();
    t.emit('highlightSet', { target: 'r3', color: 'x', style: 'y', width: 2 });
    const later: Array<Map<string, HighlightMark>> = [];
    t.w.setHighlightSink({ reset: (m) => void later.push(new Map(m)), set() {}, clear() {} });
    expect(later[0]!.get('r3')).toEqual({ color: 'x', style: 'y', width: 2 });
  });
});
