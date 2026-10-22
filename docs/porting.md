# Port a local Spawn export

This is the implemented local converter path. It reads a local export; it does not connect to Spawn or fetch game data. `init` creates a runnable starter page, so a basic web build needs no hand-written converter glue. Game-specific edits and tuning remain separate. The public packages contain the extracted runtime; game exports and assets are supplied separately.

## Requirements

Use Node.js 24 or newer and install the local release archives (or build from this repository):

```powershell
npm ci
npm run build:packages
```

The local export should contain `export-info.json`, `source/`, `reference/` (if engine docs are included), `asset-manifest.json`, and `assets/cdn/` for asset indexing. Keep the export intact; `init` reads from it and creates a workspace.

## Create, import, and check a game

Replace the example export path and slug:

```powershell
node packages/cli/src/bin.ts init "C:/path/to/export" --name my-game --out .cache/my-game
node packages/cli/src/bin.ts import .cache/my-game
node packages/cli/src/bin.ts import .cache/my-game --check
node packages/cli/src/bin.ts coverage .cache/my-game --check --json
node packages/cli/src/bin.ts assets build .cache/my-game
node packages/cli/src/bin.ts assets verify .cache/my-game
node packages/cli/src/bin.ts build .cache/my-game --target web
```

`init` reads `export-info.json`, pins the local source commit, refuses an output folder inside the export, and creates `standalone.config.json`, `standalone.lock.json`, `edits/order.yml`, `flags.json`, `index.html`, `vite.config.js`, and runnable files under `src/` for the page, composition and geometry worker. It discovers conventional `scripts/db.js` and `jobs/*.js` files and wires their ports. It does not create a `package.json` or npm scripts; invoke the CLI directly as above. Existing scaffold paths cause `init` to fail rather than overwrite them.

`import` computes reachable files, applies tracked edits, and writes the generated `game/` tree. `import --check` compares that tree and its lock with a fresh import and fails on drift. `coverage` reports used ctx chains, builtins, acts and config keys; `--check` fails for absent, loud or unknown surfaces, warnings, or lock/import drift. Partial surfaces are reported for review without failing the check. The default capability manifest is used unless `--manifest <path>` is supplied.

`assets build` reads the export manifest and CDN directory and writes the v1 index. `assets verify` checks the index and asset files against their source/output hashes; build first when the index or its verification sidecars are missing. The config's `assets.manifest` and `assets.cdn` paths are honored.

`import` owns the generated `game/` tree and may remove paths absent from a fresh import. Keep hand-authored code, UI, config overrides and tests outside `game/`, normally under `src/`, `edits/` and `test/`. Record source changes as ordered edits so imports remain repeatable.

The generated `standalone.config.json` is directly understood by the CLI. It defaults to `platform.target: 'web'`, `save.durableKeys: 'all'`, built-in `platform-roots` exclusions and the `world.config` place roster. It selects the generic UI wrapper/root and ready gate, discovers jobs and the SQL migration module when present, and sets `lock: true`. Choose the intended platform and explicit durable key/key list before shipping; the runtime uses a generic player-state container and preserves all body keys by default. The starter is runnable, but it does not claim game-specific visual or gameplay parity.

## Build and package

To run a local dev server, use a separate terminal:

```powershell
node packages/cli/src/bin.ts dev .cache/my-game --target web
```

The build command defaults to `web`; use `--out <dir>` to choose its output folder. `--target playgama` selects the Playgama build configuration. The generated Vite config uses `@spawn-standalone/vite` and the `.import` records created by `import`.

The current CLI supports Playgama packaging:

```powershell
node packages/cli/src/bin.ts package .cache/my-game --target playgama
```

Use `--out <dir>` to choose the output folder, `--no-covers` to skip cover checks for a starter without finished cover art, and `--json` for machine-readable reporting. `package` currently supports Playgama; use `build --target web` for a web build.

## Re-import loop

After changing a tracked edit, regenerate and verify the game tree:

```powershell
node packages/cli/src/bin.ts import .cache/my-game
node packages/cli/src/bin.ts import .cache/my-game --check
```

Run `coverage --check` and `import --check` after source, config or edit changes. With `lock: true`, the lock records the export commit, the engine docs hash, runtime commit, converter version and file hashes; verify it before accepting an update to the origin or toolchain.

For runtime composition options, see [Runtime API](api.md). Check the [capability manifest](../packages/runtime/capabilities/capabilities.json) for each used surface. The shell is opt-in around rendering, physics, SQL, jobs, music and touch. Boot creates generic durable state; configure per-game storage keys deliberately. See the [source boundary](provenance.md) and [verification](verification.md); a successful import or package build does not establish game-specific visual or gameplay parity.

## Install outside the monorepo

From the repository, run `npm run release:check` to build the four compiled ESM/declaration archives, inspect their complete import graphs, install the actual archives into a fresh folder, and run the installed CLI and generated game. This gate requires the locked npm dependency cache and Chromium; it fails if browser launch, production build, workers, SQL, assets or packaging fails. It writes a report and keeps its external project for inspection.

For a separate project, install all four local tarballs together with npm; their versions are aligned at 1.0.0. Use the installed `spawn-standalone` executable in place of `node packages/cli/src/bin.ts` in the examples above. Installed packages contain JavaScript and declarations; Node never needs to strip TypeScript in node_modules.

The generated host explicitly passes `world: createWorld()`, `boot: { preloadSets }`, decoder URLs and its own geometry worker entry. Direct Node hosts provide a BootWorld and a worker factory or generator loader themselves. The Vite compatibility wrapper fills these omissions for older source-based hosts and narrowly migrates their old touch CSS/worker-marker tokens. It does not rewrite game state or gameplay.
