// virtual.d.ts declares every `virtual:ss/*` id the plugins serve, and is reachable as `@spawn-standalone/vite/virtual`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SsPlaceBundle } from 'virtual:ss/places';
import { JOBS_ID } from '../src/jobs.ts';
import pkg from '../package.json' with { type: 'json' };

const dts = readFileSync(fileURLToPath(new URL('../src/virtual.d.ts', import.meta.url)), 'utf8');
const declared = [...dts.matchAll(/declare module '(virtual:ss\/[^']+)'/g)].map((m) => m[1]);

describe('virtual:ss/* declarations', () => {
  it('cover every module game.ts serves, the place wildcard and the jobs module', () => {
    const served = ['modules', 'content', 'world-config', 'world-files', 'preload-sets', 'places', 'place/*', 'anim', 'port-flags', 'asset-index', 'vendor', 'world', 'shell'].map((n) => `virtual:ss/${n}`);
    for (const id of [...served, JOBS_ID]) expect(declared).toContain(id);
  });
  it('is exported for games to reference', () => {
    expect(pkg.exports['./virtual']).toEqual({ types: './dist/src/virtual.d.ts' });
  });
  it('the place bundle type compiles', () => {
    const bundle: SsPlaceBundle = { id: 'main', config: {}, rows: [] };
    expect(bundle.id).toBe('main');
  });
});
