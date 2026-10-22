# @spawn-standalone/testing

A game-independent local export fixture for testing the standalone runtime and converter. Requires Node.js 24+. MIT licensed. This is an unpublished local 1.0.0 candidate.

```js
import { createFixtureExport } from '@spawn-standalone/testing';
createFixtureExport('./fixture-export');
```

After installing the matching runtime, Vite and CLI archives:

```sh
npx --no-install spawn-standalone init ./fixture-export --name fixture-world --out ./fixture-world
npx --no-install spawn-standalone import ./fixture-world
npx --no-install spawn-standalone assets build ./fixture-world
npx --no-install spawn-standalone build ./fixture-world --target web
```

The fixture includes an authored triangle and lighting, UI action/state updates, a SQL migration/query, a background job and a local asset. Creation refuses to replace existing files. It requires no game workspace, account or Spawn connection, and includes no original game content.
