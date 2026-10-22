// DR-53 S7: where a page runs its fx (src/render/fx/fx-setup.ts `fxModeOf`): the fx Worker by default, the in-process runtime
// on `?fx=inline`, on a page without workers, or when the app asks for it.
import { describe, expect, it } from 'vitest';
import { fxModeOf } from '../../../../src/render/fx/fx-setup.ts';

describe('fxModeOf', () => {
  it('picks the worker on a page with workers, unless the query says ?fx=inline', () => {
    expect(fxModeOf(undefined, '', true)).toBe('worker');
    expect(fxModeOf(undefined, '?tier=high', true)).toBe('worker');
    expect(fxModeOf(undefined, '?fx=inline', true)).toBe('inline');
    expect(fxModeOf(undefined, '?tier=low&fx=inline', true)).toBe('inline');
    expect(fxModeOf(undefined, '?fx=worker', true)).toBe('worker');
  });

  it('stays in-process without workers, and follows an explicit choice', () => {
    expect(fxModeOf(undefined, '', false)).toBe('inline');
    expect(fxModeOf('worker', '', false)).toBe('inline');
    expect(fxModeOf('inline', '', true)).toBe('inline');
    expect(fxModeOf('worker', '?fx=inline', true)).toBe('worker');
  });
});
