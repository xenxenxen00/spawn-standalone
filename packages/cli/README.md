# @spawn-standalone/cli

The `spawn-standalone` converter for local Spawn-compatible exports. Requires Node.js 24+. MIT licensed. Install matching 1.0.0 runtime, Vite, CLI and testing release archives together; this candidate has not been published to a registry.

Worked example after installing the archives in a separate project:

```sh
npx --no-install spawn-standalone init ./export --name my-game --out ./my-game
npx --no-install spawn-standalone import ./my-game
npx --no-install spawn-standalone import ./my-game --check
npx --no-install spawn-standalone coverage ./my-game --check --json
npx --no-install spawn-standalone assets build ./my-game
npx --no-install spawn-standalone assets verify ./my-game
npx --no-install spawn-standalone build ./my-game --target web
npx --no-install spawn-standalone dev ./my-game
# Stop the development server before packaging.
npx --no-install spawn-standalone package ./my-game --target playgama
```

`init` reads `export-info.json`, `source/` and the export asset manifest. It generates a composition, worker, Vite configuration, import lock and edit ledger, and refuses to overwrite existing scaffold files. Conventional `scripts/db.js` migrations and `jobs/*.js` workers are wired automatically. The input export is read-only; keep tracked edits outside generated `game/`.

`coverage --check` rejects unavailable or unknown capabilities and import/lock drift. Partial capabilities still require review. A successful import does not establish visual or gameplay parity for every game.

Playgama packaging creates a local archive, checks, screenshots and three covers. Cover capture requires Playwright Chromium (`npx --no-install playwright install chromium`). Packaging does not publish, submit a game or contact Spawn. Game content is not included in these packages and retains its own license.
