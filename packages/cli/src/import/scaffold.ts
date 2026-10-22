import type { GameConfig } from './config.ts';

const html = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** A runnable composition using installed public package entries. */
export function scaffoldFiles(dir: string, config: GameConfig, uiEntry: string | null, sql: boolean, jobs: boolean): Record<string, string> {
  const runtime = (p: string): string => JSON.stringify('@spawn-standalone/runtime/' + p);
  return {
    'index.html': `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${html(config.name)}</title>
<style>html,body { margin:0; width:100%; height:100%; overflow:hidden; } canvas { display:block; width:100%; height:100%; touch-action:none; } #game-ui { position:fixed; inset:0; color:#fff; font-family:system-ui; pointer-events:none; } #game-ui button,#game-ui input,#game-ui select,#game-ui textarea,#game-ui a,#game-ui [onclick],#game-ui [role="button"] { pointer-events:auto; } #boot-error { position:fixed; inset:1rem; color:#fff; background:#300; padding:1rem; }</style>
</head><body><canvas id="stage" aria-label="Game scene"></canvas><div id="game-ui"></div><div id="tome-game-mount"></div><script type="module" src="./src/main.js"></script></body></html>
`,
    'vite.config.js': `import { fileURLToPath } from 'node:url';
import { spawnStandalone${jobs ? ', ssJobs' : ''} } from '@spawn-standalone/vite';
import config from './standalone.config.json' with { type: 'json' };
const gameDir = fileURLToPath(new URL('.', import.meta.url));
const game = () => spawnStandalone({ gameDir, ui: { gameCss: false }, defines: { version: config.version, originCommit: config.source.commit } });
export default {
  root: gameDir, base: './', plugins: [game()${jobs ? ', ssJobs({ root: fileURLToPath(new URL("./game/", import.meta.url)), jobs: config.jobs })' : ''}],
  worker: { format: 'es', plugins: () => [game()] },
  build: { target: 'esnext', outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 4000 },
};
`,
    'src/main.js': `import { composeGame } from ${runtime('shell')};
import { content } from 'virtual:ss/content';
import { createWorld, preloadSets } from 'virtual:ss/world';
import assetIndex from 'virtual:ss/asset-index';
import { slug, ui, save } from '../standalone.config.json';
${uiEntry ? `import * as carriedUi from ${JSON.stringify(`@game/${uiEntry}`)};` : 'const carriedUi = {};'}
${sql ? `import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { createHostSqlStores, createSqlJsLoader, createSqlJsPort } from ${runtime('sql')};
const sqlStores = createHostSqlStores({ namespace: slug + '-sql' });
const sql = createSqlJsPort({ store: sqlStores.factory, loadSqlJs: createSqlJsLoader({ locateFile: () => wasmUrl }) });` : ''}
${jobs ? `import { createJobHost, createJobPauseGate, wrapDomWorker } from ${runtime('jobs')};
import { createJobWorker, resolveJobModule } from 'virtual:ss/jobs';
const jobPause = createJobPauseGate();
const jobs = createJobHost({ resolveModule: resolveJobModule, createWorker: () => wrapDomWorker(createJobWorker()), pause: jobPause });` : ''}
const render = carriedUi.default;
const gameUi = typeof render === 'function' ? { ...carriedUi, default: (ctx, player) => '<div id="' + ui.rootId + '">' + render(ctx, player) + '</div>' } : null;
composeGame({
  slug, world: createWorld(), boot: { preloadSets }, canvas: document.getElementById('stage'), uiContainer: document.getElementById('game-ui'), gameUi, ui,
  platform: import.meta.env.MODE === 'playgama' ? 'playgama' : 'web',
  durable: save, viewport: true, renderer: 'default', wiring: 'default', content, assetIndex,
  rendererOptions: { search: location.search },
  render: { geometryWorker: () => new Worker(new URL('./geometry-worker.js', import.meta.url), { type: 'module' }) },
  ports: { ${[...(sql ? ['sql', 'sqlStores', 'sqlWorldId: slug'] : []), ...(jobs ? ['jobs', 'jobPause'] : [])].join(', ')} },
}).then((app) => {
  document.body.dataset.booted = '1';
  addEventListener('pagehide', () => { app.dispose(); ${jobs ? 'jobs.dispose();' : ''} ${sql ? 'void sql.close().then(() => sqlStores.flush()).catch(console.error);' : ''} }, { once: true });
${sql ? `  const flush = () => void sql.flush().then(() => sqlStores.flush()).catch(console.error);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });` : ''}
}).catch((error) => {
  ${jobs ? 'jobs.dispose();' : ''}
  ${sql ? 'void sql.close().catch(console.error);' : ''}
  console.error(error);
  document.body.dataset.bootError = String(error);
  const plate = document.createElement('p'); plate.id = 'boot-error'; plate.setAttribute('role', 'alert'); plate.textContent = 'The game could not start: ' + String(error); document.body.append(plate);
});
`,
    'src/geometry-worker-flag.js': 'globalThis.__ssGeometryWorkerHosted = true;\n',
    'src/geometry-worker.js': `import './geometry-worker-flag.js';
import { serveGeneratorModules } from ${runtime('geometry/worker')};
import { content } from 'virtual:ss/content';
serveGeneratorModules(content);
`,
  };
}
