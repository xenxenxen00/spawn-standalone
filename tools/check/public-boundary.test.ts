import { describe, expect, it } from 'vitest';
import { publicNamespaceIssue } from './public-boundary.ts';

describe('public runtime namespace guard', () => {
  it('rejects stale cross-bundle, worker, CSS and object contracts', () => {
    for (const text of ["Symbol.for('pp.compiled')", '__ppGeometryWorkerHosted', '.pp-touch-button', "'pp:scene'", '__PP_PLATFORM__']) {
      expect(publicNamespaceIssue(text), text).toBe(true);
    }
  });
  it('accepts the package namespace, arbitrary state keys and compatible binary formats', () => {
    expect(publicNamespaceIssue("Symbol.for('ss.compiled'); const format='PPBK'; const state={pp:1}" )).toBe(false);
  });
});
