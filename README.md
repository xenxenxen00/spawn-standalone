# spawn-standalone

A game-independent browser runtime and converter for local Spawn-compatible exports, using three.js r186 and Rapier 0.21.

| MIT-licensed package | Purpose |
|---|---|
| `@spawn-standalone/runtime` | Kernel, rendering, physics, input, audio, UI and host ports |
| `@spawn-standalone/vite` | World/content compilation and browser worker integration |
| `@spawn-standalone/cli` | Import, coverage, assets, build, development server and Playgama packaging |
| `@spawn-standalone/testing` | Synthetic local export fixture |

This source contains no game workspaces, exported game code/assets, private Git history or original game acceptance corpus. Tests use synthetic inputs. Dependency copyrights and licenses remain in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); see [provenance and scope](docs/provenance.md).

## Build and check

Requirements: Node.js 24+, npm and Git. Install Playwright Chromium for browser checks:

```sh
npm ci --no-audit --no-fund
npx --no-install playwright install chromium
npm run check
npm run audit:source
npm run release:check -- --out ../release-candidates
```

On Windows, use writable local `TEMP`/`TMP` and `VITEST_MAX_WORKERS=1` for one browser lane. `PLAYWRIGHT_BROWSERS_PATH` can select an existing browser cache. A skipped browser case is not browser verification.

`check` builds the public JavaScript/declaration entries before typechecking, boundary checks and tests. Workspace imports use compiled entries; rebuild after source changes. `audit:source` scans publishable files, staged blobs and every reachable Git-history blob for known credential patterns and private content paths, reporting locations without matched file contents. It is a focused release-content check, not an exhaustive vulnerability assessment.

`release:check` packs all four packages, audits import/declaration graphs and licenses, installs the archives into a fresh external directory, and drives the installed CLI and fixture through build/dev/SQL/jobs/input/assets/Playgama packaging. Its external install uses npm's cache offline; the preceding install must fetch the locked dependencies. Output includes four `.tgz` files, `release-report.json`, `smoke.log`, an installed sample, screenshots and covers. It never publishes or uploads.

## Try a synthetic game

After building:

```sh
node --input-type=module -e 'import { createFixtureExport } from "@spawn-standalone/testing"; createFixtureExport(".cache/fixture-export");'
node packages/cli/src/bin.ts init .cache/fixture-export --name fixture-world --out .cache/fixture-world
node packages/cli/src/bin.ts import .cache/fixture-world
node packages/cli/src/bin.ts import .cache/fixture-world --check
node packages/cli/src/bin.ts coverage .cache/fixture-world --check --json
node packages/cli/src/bin.ts assets build .cache/fixture-world
node packages/cli/src/bin.ts assets verify .cache/fixture-world
node packages/cli/src/bin.ts build .cache/fixture-world --target web
node packages/cli/src/bin.ts dev .cache/fixture-world
# Stop the development server before packaging.
node packages/cli/src/bin.ts package .cache/fixture-world --target playgama
```

In a separate project, install all four matching 1.0.0 archives together and use `npx --no-install spawn-standalone` instead of `node packages/cli/src/bin.ts`. Registry publication and name availability have not been verified.

The converter reads local exports and never contacts Spawn. `init` refuses to overwrite existing scaffold files; `import` owns the generated `game/` tree. Keep hand edits in the ordered edit ledger. Conventional SQL migrations and job modules are wired automatically. Import success does not establish every game's visual or gameplay parity.

See [porting](docs/porting.md), [runtime API](docs/api.md), [capabilities](packages/runtime/capabilities/capabilities.json) and [verification](docs/verification.md).

TypeScript hosts use the declaration dependencies exercised by the strict external check:

```sh
npm install --save-dev typescript@7.0.2 @types/node@24.19.1 @types/three@0.186.0 @types/sql.js@1.4.11
```
