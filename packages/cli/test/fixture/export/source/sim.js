// the root sim
import { pick } from './scripts/spawner.js';
export const cadence = '100ms';
export function tick(ctx) {
  pick(ctx);
}
