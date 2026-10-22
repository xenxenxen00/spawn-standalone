// vitest `setupFiles` entry of the node project (motion §10.1): the Rapier physics tests get the engine loaded once per
// worker, through physics/rapier/loader.ts and nothing else (D-MPN-10). Only test files of the areas listed here pay the
// ~65 ms `init()`; the nav tests and everything else never load the wasm. A test elsewhere that needs real physics awaits
// `loadRapier()` (or PH3's `ensurePhysics()`) itself.
import { beforeAll, expect } from 'vitest';
import { loadRapier } from '../../../src/compat/physics/rapier/loader.ts';

export const RAPIER_TEST_AREAS = ['/tests/unit/physics/'];

beforeAll(async () => {
  const path = (expect.getState().testPath ?? '').replace(/\\/g, '/');
  if (RAPIER_TEST_AREAS.some((area) => path.includes(area))) await loadRapier();
});
