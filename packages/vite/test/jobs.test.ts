import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { jobWorkerSource, jobsModuleSource, resolveJobEntries, ssJobs } from '../src/index.ts';

const fixture = fileURLToPath(new URL('./fixture/', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');

describe('resolveJobEntries (C-5)', () => {
  it('reads the jobs: config and discovers jobs/<id>.js', () => {
    const entries = resolveJobEntries({ root: fixture, jobs: { cpu: 'jobs/cpu.js' } });
    expect(Object.keys(entries).sort()).toEqual(['cpu', 'extra']);
    expect(entries.cpu).toBe(`${fixture}/jobs/cpu.js`);
  });

  it('discover:false keeps only the config; a missing file is an error', () => {
    expect(Object.keys(resolveJobEntries({ root: fixture, jobs: { cpu: 'jobs/cpu.js' }, discover: false }))).toEqual(['cpu']);
    expect(() => resolveJobEntries({ root: fixture, jobs: { nope: 'jobs/nope.js' } })).toThrow(/jobs\.nope/);
  });

  it('no config and no jobs folder -> no entries', () => {
    expect(resolveJobEntries({ root: `${fixture}/lib` })).toEqual({});
  });
});

describe('generated sources', () => {
  it('worker program: one dynamic import per job, protocol handlers wired', () => {
    const src = jobWorkerSource({ cpu: '/g/jobs/cpu.js' }, '/rt/job-runner.ts');
    expect(src).toContain('"cpu": () => import("/g/jobs/cpu.js")');
    expect(src).toContain('from "/rt/job-runner.ts"');
    expect(src).toContain('handleWarmRequest');
  });

  it('main module: ids, resolver and a Worker factory over the ?worker import', () => {
    const src = jobsModuleSource({ cpu: '/g/jobs/cpu.js' });
    expect(src).toContain('virtual:ss/job-worker?worker');
    expect(src).toContain('export const jobIds = ["cpu"]');
  });
});

describe('vite build with the jobs plugin', () => {
  const out = mkdtempSync(join(tmpdir(), 'ss-jobs-'));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it('emits a worker chunk that bundles the job and its imports, and keeps them out of the main bundle', async () => {
    await build({
      root: fixture,
      configFile: false,
      logLevel: 'silent',
      plugins: [ssJobs({ root: fixture, jobs: { cpu: 'jobs/cpu.js' } })],
      build: { outDir: out, emptyOutDir: true, minify: false, lib: { entry: `${fixture}/main.js`, formats: ['es'], fileName: 'main' } },
    });
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else files.push(join(dir, e.name));
      }
    };
    walk(out);
    const text = new Map(files.filter((f) => f.endsWith('.js')).map((f) => [f, readFileSync(f, 'utf8')]));
    const all = [...text.values()];
    const main = [...text].find(([f]) => /main\.js$/.test(f))![1];
    expect(all.some((t) => t.includes('think-marker-7f3a'))).toBe(true);
    expect(all.some((t) => t.includes('extra-marker-91c2'))).toBe(true);
    expect(main).not.toContain('think-marker-7f3a');
    expect(main).not.toContain('handleRunRequest');
    expect(main).toMatch(/new Worker\(/);
    expect(all.some((t) => t.includes('handleRunRequest') && t.includes('onmessage'))).toBe(true);
  }, 60_000);
});

describe('vite development job worker', () => {
  it('executes a job through a browser-loadable worker URL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ss-jobs-dev-'));
    cpSync(join(fixture, 'jobs'), join(root, 'jobs'), { recursive: true });
    cpSync(join(fixture, 'lib'), join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'index.html'), `<script type="module">
import { createJobWorker } from 'virtual:ss/jobs';
const worker = createJobWorker();
worker.onerror = (event) => { document.body.dataset.error = event.message || event.filename; };
worker.onmessage = (event) => { document.body.dataset.result = JSON.stringify(event.data); worker.terminate(); };
worker.postMessage({type:'run', requestId:1, moduleUrl:'cpu', job:{}, args:{n:21}});
</script>`);
    const server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: [ssJobs({ root })], server: { host: '127.0.0.1', port: 0, fs: { allow: [root, fileURLToPath(new URL('../../../..', import.meta.url))] } } });
    let browser;
    try {
      await server.listen();
      const { chromium } = await import('@playwright/test');
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const requests: string[] = [];
      const errors: string[] = [];
      page.on('request', (request) => requests.push(request.url()));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('requestfailed', (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
      page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.url()}: ${response.status()}`); });
      await page.goto(server.resolvedUrls!.local[0]!);
      await page.waitForFunction(() => document.body.dataset.result || document.body.dataset.error);
      expect(await page.getAttribute('body', 'data-error'), JSON.stringify({ requests, errors })).toBeNull();
      const result = JSON.parse((await page.getAttribute('body', 'data-result'))!);
      expect(result, JSON.stringify({ result, requests, errors })).toMatchObject({ type: 'result', requestId: 1, data: 'think-marker-7f3a:21' });
      expect(requests.some((url) => url.includes('worker_file'))).toBe(true);
      expect(requests.some((url) => /\u0000|%00/.test(url))).toBe(false);
    } finally {
      await browser?.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
