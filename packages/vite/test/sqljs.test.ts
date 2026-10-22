// The sql.js prompt rewrite (PG-13) and the Playgama bundle path (PG-10): a fixture build is scanned the way the pack checks scan it.
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { runImport } from '../../cli/src/import/command.ts';
import { spawnStandalone, stripSqlJsPrompt } from '../src/index.ts';

const require = createRequire(import.meta.url);
const sqlDist = join(require.resolve('sql.js'), '..');
const fwd = (p: string): string => p.split('\\').join('/');
const WS = fwd(fileURLToPath(new URL('../../cli/test/fixture/ws/', import.meta.url)));
const RT = fwd(fileURLToPath(new URL('../../runtime/src/', import.meta.url)));

const jsFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? jsFiles(join(dir, e.name)) : /\.m?js$/.test(e.name) ? [join(dir, e.name)] : []));

describe('stripSqlJsPrompt', () => {
  it('rewrites the stdin prompt fallback in both glue files and leaves other code alone', () => {
    for (const f of ['sql-wasm.js', 'sql-wasm-browser.js']) {
      const src = readFileSync(join(sqlDist, f), 'utf8');
      expect(src).toMatch(/window\.prompt\(/);
      const fixed = stripSqlJsPrompt(src)!;
      expect(fixed).not.toMatch(/prompt\(/);
      expect(fixed.length).toBeLessThan(src.length);
    }
    expect(stripSqlJsPrompt('const x = 1;')).toBeNull();
  });

  it('sql.js still opens a database and runs a query after the rewrite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-sqljs-run-'));
    try {
      writeFileSync(join(dir, 'sql-wasm.cjs'), stripSqlJsPrompt(readFileSync(join(sqlDist, 'sql-wasm.js'), 'utf8'))!);
      copyFileSync(join(sqlDist, 'sql-wasm.wasm'), join(dir, 'sql-wasm.wasm'));
      const init = createRequire(join(dir, 'x.cjs'))('./sql-wasm.cjs') as (c?: object) => Promise<{ Database: new () => { exec(q: string): Array<{ values: unknown[][] }>; close(): void } }>;
      const SQL = await init({ locateFile: (f: string) => join(dir, f) });
      const db = new SQL.Database();
      db.exec('CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (40), (2)');
      expect(db.exec('SELECT SUM(n) FROM t')[0]!.values[0]![0]).toBe(42);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Playgama fixture build', () => {
  it('bundles no browser storage and no prompt( on the playgama path (mode playgama)', async () => {
    const tmp = fwd(mkdtempSync(join(tmpdir(), 'ss-pgfix-')));
    try {
      const gameRoot = `${tmp}/game`;
      await runImport(WS, { out: gameRoot });
      const entry = `${tmp}/entry.ts`;
      writeFileSync(
        entry,
        [
          `import { composeGame } from '${RT}shell/compose-game.ts';`,
          `import { createHostSqlStores, createSqlJsPort } from '${RT}ports/sql/index.ts';`,
          'export async function start(canvas: HTMLCanvasElement | null) {',
          '  const stores = createHostSqlStores({ namespace: "fixture-sql" });',
          '  const sql = createSqlJsPort({ store: stores.factory });',
          '  return composeGame({ slug: "fixture", canvas, platform: "playgama", world: undefined as never, ports: { sql, sqlWorldId: "w", sqlStores: stores } });',
          '}',
        ].join('\n'),
      );
      const dist = `${tmp}/dist`;
      await build({
        root: tmp,
        mode: 'playgama',
        configFile: false,
        logLevel: 'silent',
        plugins: [spawnStandalone({ gameDir: WS, gameRoot })],
        build: { outDir: dist, emptyOutDir: true, target: 'es2022', minify: true, lib: { entry, formats: ['es'], cssFileName: 'style', fileName: () => 'main.mjs' }, rolldownOptions: { external: [/^@playgama\/bridge/] } },
      });
      const files = jsFiles(dist);
      expect(files.length).toBeGreaterThan(0);
      const hits: string[] = [];
      for (const f of files) {
        const text = readFileSync(f, 'utf8');
        const re = /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\.cookie|(?<![\w$.])(?:alert|confirm|prompt)\(|\bwindow\.(?:alert|confirm|prompt)\(/g;
        for (const m of text.matchAll(re)) hits.push(`${fwd(f).slice(dist.length)}: ${m[0]}`);
      }
      expect(hits).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 180_000);
});
