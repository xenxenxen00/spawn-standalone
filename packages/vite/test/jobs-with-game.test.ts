// ssJobs and spawnStandalone together: the Worker import `virtual:ss/job-worker?worker` carries a query, which the game plugin's
// load() must not mistake for one of its own modules.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runImport } from '../../cli/src/import/command.ts';
import { spawnStandalone, ssJobs } from '../src/index.ts';

const WS = fileURLToPath(new URL('../../cli/test/fixture/ws/', import.meta.url)).replaceAll(String.fromCharCode(92), '/');
const jobsRoot = fileURLToPath(new URL('./fixture/', import.meta.url)).replaceAll(String.fromCharCode(92), '/').replace(/\/$/, '');
const tmp = mkdtempSync(join(tmpdir(), 'ss-vite-jobs-game-')).replaceAll(String.fromCharCode(92), '/');
const gameRoot = `${tmp}/game`;
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeAll(async () => {
  await runImport(WS, { out: gameRoot });
});

describe('vite build with ssJobs and spawnStandalone', () => {
  it('builds the page and the job worker chunk with no workaround', async () => {
    const entry = `${tmp}/entry.js`;
    writeFileSync(entry, ["import { createJobWorker, jobIds } from 'virtual:ss/jobs';", "import { modules } from 'virtual:ss/modules';", 'export { createJobWorker, jobIds, modules };'].join('\n'));
    const out = `${tmp}/dist`;
    await build({
      root: tmp,
      configFile: false,
      logLevel: 'silent',
      plugins: [...spawnStandalone({ gameDir: WS, gameRoot }), ssJobs({ root: jobsRoot, jobs: { cpu: 'jobs/cpu.js' } })],
      build: { outDir: out, emptyOutDir: true, minify: false, lib: { entry, formats: ['es'], fileName: () => 'main.mjs' } },
    });
    const js = readdirSync(out, { recursive: true }).map(String).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
    const text = js.map((f) => readFileSync(join(out, f), 'utf8'));
    expect(text.some((t) => t.includes('think-marker-7f3a'))).toBe(true);
    expect(readFileSync(join(out, 'main.mjs'), 'utf8')).toMatch(/new Worker\(/);
  }, 60_000);
});
