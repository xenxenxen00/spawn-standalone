// Audience (io §2.5, X-12): the visibility table is implemented once, in core (`events/acts.ts` `presentable()`, core §8.6),
// and the kernel applies it before an act reaches `kernel.acts`; the audio engine never filters again. This module only
// re-exports core's audience types for the audio code and its tests.
//
// `presentable()` itself is re-exported here once WP C2 lands `src/compat/core/events/acts.ts` (it does not exist on the
// branch yet, so a re-export would not compile).
export type { Audience, NormalisedAudience } from '../../compat/core/types.ts';
