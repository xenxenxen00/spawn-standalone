import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dependencyPaths } from './dependency-paths.ts';

const temp = mkdtempSync(join(tmpdir(), 'ss-esm-dependency-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe('installed dependency resolution', () => {
  it('uses ESM import exports for an ESM-only dependency that rejects require resolution', () => {
    const metadata = join(temp, 'package.json');
    writeFileSync(metadata, JSON.stringify({ name: 'consumer', type: 'module' }));
    const dependency = join(temp, 'node_modules/esm-only'); mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'esm-only', type: 'module', exports: { import: './entry.js' } }));
    const entry = join(dependency, 'entry.js'); writeFileSync(entry, 'export const ready = true;');
    expect(() => createRequire(metadata).resolve('esm-only')).toThrow(/No "exports" main defined/);
    expect(dependencyPaths(metadata, ['esm-only'])).toEqual([{ name: 'esm-only', path: realpathSync(entry) }]);
  });
});
