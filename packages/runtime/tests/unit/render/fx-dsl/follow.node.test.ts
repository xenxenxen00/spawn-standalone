// DR-53 S6: `fxFollowOf` (src/render/fx/dsl/compile.ts), the program header's `follow` target read from the cached parse. The
// main thread needs it at a spawn (what the effect's origin follows) while the program may compile in the fx Worker, so it must
// be the compiled program's `header.follow`, for every live program, params and tier.
import { describe, expect, it } from 'vitest';
import { compileProgram, fxFollowOf } from '../../../../src/render/fx/dsl/compile.ts';

describe('fxFollowOf', () => {
  it('the last valid follow wins; other header keys and values are skipped, as the compiler skips them', () => {
    const cases: Array<[string, 'camera' | 'player' | undefined]> = [
      ['fx\npop p burst=1', undefined],
      ['fx follow=camera\npop p burst=1', 'camera'],
      ['fx follow=player\npop p burst=1', 'player'],
      ['fx follow=camera follow=player\npop p burst=1', 'player'],
      ['fx follow=nobody\npop p burst=1', undefined],
      ['fx follow=camera follow=nobody\npop p burst=1', 'camera'],
      ['fx speed=3 follow=camera\npop p burst=1', 'camera'],
    ];
    for (const [text, want] of cases) {
      expect(fxFollowOf(text), text).toBe(want);
      expect(compileProgram(text, {}, { low: false, mobile: false }, { strict: false, onDiagnostic: () => undefined }).header.follow, text).toBe(want);
    }
  });
});
