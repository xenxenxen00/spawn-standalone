import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
const root = (path: string): string => fileURLToPath(new URL(path, import.meta.url)).replaceAll('\\', '/');
const shared = {
  resolve: { alias: [{ find: /^builtin\/(.*)$/, replacement: `${root('./packages/runtime/src/compat/builtin/')}$1.ts` }] },
  define: {
    __SS_PLATFORM__: JSON.stringify('web'), __SS_TEST_HOOKS__: 'true',
    __SS_VERSION__: JSON.stringify('1.0.0+test'), __SS_ORIGIN_COMMIT__: JSON.stringify('public-synthetic'),
  },
};
const unit = (suffix: string): string[] => [`packages/runtime/tests/unit/**/*.${suffix}.test.ts`];

export default defineConfig({
  test: {
    pool: 'forks',
    testTimeout: 30_000,
    maxWorkers: Math.min(8, Math.max(1, Math.floor(availableParallelism() / 2))),
    passWithNoTests: true,
    projects: [
      {
        // Public package and tooling tests.
        extends: false,
        test: {
          name: 'repo',
          testTimeout: 30_000, // the project does not inherit the root value; cold transforms under a full-suite load exceed 5 s
          hookTimeout: 60_000,
          environment: 'node',
          include: ['packages/*/test/**/*.test.ts', 'tools/**/*.test.ts'],
        },
      },
      {
        ...shared,
        test: {
          name: 'node',
          environment: 'node',
          include: unit('node'),
          setupFiles: ['packages/runtime/tests/unit/physics/setup-rapier.ts'],
        },
      },
      { ...shared, test: { name: 'dom', environment: 'jsdom', include: unit('dom') } },
      { ...shared, test: { name: 'three', environment: 'node', include: unit('three') } },
    ],
  },
});
