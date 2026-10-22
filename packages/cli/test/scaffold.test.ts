import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createFixtureExport } from '@spawn-standalone/testing';
import { createSqlJsPort } from '@spawn-standalone/runtime/sql';
import { createRegistry } from '@spawn-standalone/runtime/registry';
import { createSqlExtension } from '@spawn-standalone/runtime';
import { createKernel } from '../../runtime/src/compat/core/kernel.ts';
import { prepareExtensions } from '../../runtime/src/compat/core/ext.ts';
import type { SqlTag } from '../../runtime/src/ports/sql/types.ts';
import { runInit, runImport } from '../src/import/command.ts';
import { scaffoldFiles } from '../src/import/scaffold.ts';

const temp = mkdtempSync(join(tmpdir(), 'ss-scaffold-migration-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

async function prepareMigration(migrate: (sql: SqlTag) => Promise<void>) {
  const registry = createRegistry({ modules: { 'scripts/db.js': async () => ({ migrate }) }, sets: { boot: ['scripts/db.js'], director: [], actors: [] }, anim: {} });
  await registry.ensure('boot');
  const sql = createSqlJsPort();
  const kernel = createKernel({ seed: 1, ports: {}, registry, worldConfig: { defaultPlace: 'main', player: 'templates/player.js#player', camera: 'templates/camera.js#camera', inputs: {} }, places: { placeIndex: {}, places: {} }, ext: { sql: createSqlExtension({ port: sql, worldId: 'fixture' }) } });
  await prepareExtensions(kernel, registry);
  return sql;
}

describe('SQL scaffold migration', () => {
  it('carries the fixture migration as a boot registry module and gives boot sole ownership', async () => {
    const exp = createFixtureExport(join(temp, 'export'));
    const game = join(temp, 'game'); runInit(exp, { name: 'fixture', out: game });
    await runImport(game);
    const main = readFileSync(join(game, 'src/main.js'), 'utf8');
    expect(main).not.toContain('import { migrate }');
    expect(main).not.toContain('createSqlJsPort({ migrate');
    const modules = JSON.parse(readFileSync(join(game, 'game/.import/modules.json'), 'utf8'));
    const preload = JSON.parse(readFileSync(join(game, 'game/.import/preload-sets.json'), 'utf8'));
    expect(modules.registry).toContain('scripts/db.js');
    expect(modules.content).not.toContain('scripts/db.js');
    expect(preload.sets.boot).toContain('scripts/db.js');
    const module = await import(pathToFileURL(join(game, 'game/scripts/db.js')).href);
    const sql = await prepareMigration(module.migrate);
    try {
      const result = await sql.run({ worldId: 'fixture', sql: 'INSERT INTO scores (score) VALUES (21); SELECT score FROM scores' });
      expect(result.rows).toEqual([{ score: 21 }]);
    } finally { await sql.close(); }
  });
  it('runs a non-idempotent migration exactly once through the actual kernel boot preparation hook', async () => {
    const migrate = vi.fn(async (sql: SqlTag) => { await sql`CREATE TABLE once_only (value INTEGER)`; });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sql = await prepareMigration(migrate);
    try {
      await sql.run({ worldId: 'fixture', sql: 'INSERT INTO once_only (value) VALUES (1)' });
      expect(migrate).toHaveBeenCalledTimes(1);
      expect(errors).not.toHaveBeenCalled();
    } finally { await sql.close(); errors.mockRestore(); }
  });
  it('does not import a migration when the export has no SQL module', () => {
    const main = scaffoldFiles(temp, { name: 'Plain', slug: 'plain', source: { dir: '.' } }, null, false, false)['src/main.js']!;
    expect(main).not.toContain('@game/scripts/db.js');
    expect(main).not.toContain('createSqlJsPort');
  });
});
