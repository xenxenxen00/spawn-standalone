# @spawn-standalone/vite

Vite 8 adapter for a converted Spawn-compatible game. Requires Node.js 24+ and the matching 1.0.0 runtime. MIT licensed. This is an unpublished local release candidate.

```js
import { spawnStandalone } from '@spawn-standalone/vite';
const gameDir = import.meta.dirname;
export default {
  root: gameDir, base: './',
  plugins: [spawnStandalone({ gameDir })],
};
```

The plugin reads the converted `game/` tree and `.import` records, resolves `builtin/*` and `@game/*`, serves assets/decoders, and generates `virtual:ss/world`, `content` and other host inputs. Each `createWorld()` call owns a fresh registry. The runtime itself never imports virtual game data.

Use `spawn-standalone init` from the CLI for a complete generated configuration, including worker plugins, SQL/jobs and the composition. The `ssJobs` plugin supports authored jobs in development and production. TypeScript hosts can include `@spawn-standalone/vite/virtual` declarations. Original game exports and assets are not shipped.
