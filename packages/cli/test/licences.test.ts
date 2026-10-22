import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolvePackageConfig } from '../src/package/config.ts';
import { buildThirdParty, collectLicences } from '../src/package/licences.ts';

const temp = mkdtempSync(join(tmpdir(), 'ss-vendor-licenses-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const config = resolvePackageConfig({ name: 'Fixture', slug: 'fixture', source: { dir: '.' } });

describe('redistributed vendor license text', () => {
  it('retains full license text and actual attribution for every emitted vendor component', () => {
    const entries = collectLicences(temp, config, ['playgama-bridge.js', 'assets/sql-wasm.wasm', 'vendor/meshopt_decoder.module.js', 'vendor/basis/basis_transcoder.js', 'vendor/basis/basis_transcoder.wasm']);
    for (const name of ['@playgama/bridge', 'sql.js', 'three', 'meshoptimizer decoder', 'Basis Universal transcoder']) expect(entries.find((entry) => entry.name === name)?.text, name).toBeTruthy();
    const output = buildThirdParty({ name: 'Fixture', version: '1' }, entries, []);
    const apache = readFileSync(join(import.meta.dirname, '../../../node_modules/sharp/LICENSE'), 'utf8').trim();
    expect(output).toContain(apache);
    expect(entries.find(entry => entry.name === '@spawn-standalone/runtime')?.text).toBeTruthy();
    expect(output).toContain('Copyright (c) 2026 xenxenxen00 and contributors');
    expect(output).toContain('Copyright (c) Tailwind Labs, Inc.');
    expect(output).toContain('## Vendored three.js code');
    const decoder = readFileSync(join(import.meta.dirname, '../../../node_modules/three/examples/jsm/libs/meshopt_decoder.module.js'), 'utf8');
    const header = decoder.match(/^(?:\/\/[^\r\n]*\r?\n)+/)![0].trim();
    expect(output).toContain(header);
    expect(entries.find((entry) => entry.name === 'meshoptimizer decoder')?.version).toBe(decoder.match(/Built from meshoptimizer ([^\r\n]+)/)![1]!.trim());
    expect(output).toContain('Permission is hereby granted, free of charge');
    expect(output).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });
  it('rejects a redistributed SQL vendor asset when its installed package has no license file', () => {
    const dir = join(temp, 'missing-license'); const dependency = join(dir, 'node_modules/sql.js');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'sql.js', version: '1', license: 'MIT' }));
    expect(() => collectLicences(dir, config, ['assets/sql-wasm.wasm'])).toThrow(/redistributed sql.js has no license text/);
  });
});
