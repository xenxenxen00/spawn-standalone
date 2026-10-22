# @spawn-standalone/runtime

Game-independent Spawn-compatible browser runtime using three.js r186 and Rapier 0.21. Requires Node.js 24+ for tooling. MIT licensed; dependencies retain their own licenses in THIRD_PARTY_NOTICES.md.

Install matching 1.0.0 release archives for runtime, Vite, CLI and testing together. This candidate is local; registry publication has not been performed.

With the Vite adapter configured for a converted game:

```js
import { composeGame } from '@spawn-standalone/runtime/shell';
import { createWorld, preloadSets } from 'virtual:ss/world';
import { content } from 'virtual:ss/content';
import assetIndex from 'virtual:ss/asset-index';

const app = await composeGame({
  slug: 'my-game', canvas: document.querySelector('canvas'),
  world: createWorld(), boot: { preloadSets }, content, assetIndex,
  renderer: 'default', wiring: 'default',
});
// On shutdown: app.dispose();
```

The runtime requires injected world data and never imports a game. UI, SQL, jobs and authored touch controls are explicit host inputs. Use the CLI to generate the complete composition, asset pipeline and geometry worker instead of assembling these manually. Direct headless hosts supply their own world and advance the frame driver.

TypeScript hosts need `@types/node`, `@types/three@0.186.0` and `@types/sql.js@1.4.11`; public declarations are checked with strict TypeScript settings. Game exports and assets retain their own licenses and are not included.
