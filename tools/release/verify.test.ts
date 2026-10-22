import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { archiveEntries, auditArchive, installationLock } from './verify.ts';

function archive(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text); const header = Buffer.alloc(512);
    header.write(name); header.write(data.length.toString(8).padStart(11, '0'), 124); header[156] = 48;
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
const legal = { 'package/package.json': JSON.stringify({ name: '@spawn-standalone/testing', license: 'MIT', exports: { '.': './dist/src/index.js' } }), 'package/LICENSE': 'MIT License', 'package/NOTICE': 'Third-party notices' };

describe('public archive audit', () => {
  it('reads actual gzip/tar entries and accepts the compiled boundary', () => {
    const tar = archive({ ...legal, 'package/dist/src/index.js': 'export const ready = true;' });
    expect(archiveEntries(tar).get('package/dist/src/index.js')?.toString()).toContain('ready');
    expect(auditArchive(tar)).toBe(4);
  });
  it('rejects missing legal files, fixtures, legacy adapters, private paths and sibling source imports', () => {
    expect(() => auditArchive(archive({ 'package/dist/src/index.js': '' }))).toThrow(/license/);
    for (const [path, text] of [
      ['package/test/fixture.js', ''], ['package/dist/src/compat/legacy/save.js', ''],
      ['package/dist/src/index.js', 'const checkout = ' + JSON.stringify(['C:', 'Users', 'private', 'game'].join('/')) + ';'],
      ['package/dist/src/index.js', 'export { x } from "../../runtime/src/x.js";'],
      ['package/dist/src/index.js', 'import { x } from "undeclared-package";'],
      ['package/dist/src/index.js', 'export { x } from "./missing.js";'],
      ['package/dist/src/index.d.ts', 'import type { SaveDoc } from "./compat/legacy/save-schema.js";'],
    ]) expect(() => auditArchive(archive({ ...legal, [path!]: text! }))).toThrow();
  });
});

describe('offline external install lock', () => {
  it('uses actual archives, follows required edges and prunes unrelated workspace packages', () => {
    const result = installationLock({ name: 'release-test', dependencies: { '@spawn-standalone/testing': 'file:../testing.tgz' }, devDependencies: {} }, {
      'node_modules/@spawn-standalone/testing': { link: true, resolved: 'packages/testing' },
      'node_modules/needed': { version: '1.0.0', optionalDependencies: { absent: '*' } },
      'node_modules/unrelated-game': { version: '1.0.0' },
    }, { 'node_modules/@spawn-standalone/testing': { version: '1.0.0', resolved: 'file:../testing.tgz', dependencies: { needed: '1.0.0' } } });
    expect(Object.keys(result.packages as object)).toEqual(['', 'node_modules/@spawn-standalone/testing', 'node_modules/needed']);
    expect((result.packages as Record<string, unknown>)['node_modules/@spawn-standalone/testing']).toMatchObject({ resolved: 'file:../testing.tgz' });
  });
  it('fails when a required dependency is absent from the warm lock', () => {
    expect(() => installationLock({ name: 'release-test', dependencies: { missing: '1' }, devDependencies: {} }, {}, {})).toThrow(/missing locked root/);
  });
});
