import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageNames, repository } from './build.ts';

function installedPackage(from: string, name: string): string | null {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const up = dirname(dir); if (up === dir) return null; dir = up;
  }
}

export function dependencyNotices(): string {
  const direct = new Map<string, { version: string; license: string; users: Set<string>; dir: string }>();
  for (const name of packageNames) {
    const root = join(repository, 'packages', name); const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).sort()) {
      if (dependency.startsWith('@spawn-standalone/')) continue;
      const dir = installedPackage(root, dependency); assert.ok(dir, `dependency not installed: ${dependency}`);
      const metadata = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      let entry = direct.get(dependency);
      if (!entry) { entry = { version: metadata.version, license: metadata.license ?? 'UNKNOWN', users: new Set(), dir }; direct.set(dependency, entry); }
      assert.equal(entry.version, metadata.version, `multiple direct versions: ${dependency}`);
      entry.users.add(name + (manifest.peerDependencies?.[dependency] ? ' (peer)' : ''));
    }
  }
  const transitive = new Map<string, { name: string; version: string; license: string; notices: string[] }>();
  const visit = (dir: string): void => {
    const metadata = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); const key = metadata.name + '@' + metadata.version;
    if (transitive.has(key)) return;
    const notices = readdirSync(dir).filter((p) => /^(licen[cs]e|copying|notice)(\.[^.]+)?$/i.test(p));
    transitive.set(key, { name: metadata.name, version: metadata.version, license: metadata.license ?? 'UNKNOWN', notices });
    for (const [name, optional] of [...Object.keys(metadata.dependencies ?? {}).map((n) => [n, false] as const), ...Object.keys(metadata.optionalDependencies ?? {}).map((n) => [n, true] as const)]) {
      const child = installedPackage(dir, name);
      if (!child) { assert.ok(optional, `required dependency not installed: ${name}`); continue; }
      visit(child);
    }
  };
  for (const value of direct.values()) visit(value.dir);
  const out = [
    '# Third-party notices', '',
    'The four public spawn-standalone packages are MIT licensed. Their dependencies retain their own',
    'licenses and copyright notices. This inventory records installed package metadata; it does not',
    'relicense dependencies. The npm archives include adapted three.js postprocessing code credited',
    'below. Other dependencies are installed as separate npm packages with their own',
    'license files. Preserve those files when redistributing a complete installation.', '',
    'Regenerate this inventory after a dependency change with `node tools/release/notices.ts`.', '',
    '## Direct production dependencies and peers', '',
    '| Package | Installed version | License metadata | Public packages |',
    '| --- | --- | --- | --- |',
  ];
  for (const [name, value] of [...direct].sort(([a], [b]) => a.localeCompare(b))) out.push(`| ${name} | ${value.version} | ${value.license} | ${[...value.users].sort().join(', ')} |`);
  const three = direct.get('three'); assert.ok(three, 'three.js dependency is required for vendored notices');
  const threeLicense = readFileSync(join(three.dir, 'LICENSE'), 'utf8').trim();
  out.push('', '## Vendored three.js code', '',
    'The runtime includes an adapted three.js bloom/postprocessing implementation. The following',
    'copyright, permission notice and disclaimer apply to those vendored portions:', '', threeLicense, '');
  out.push('', 'The optional `@types/three` peer supplies public TypeScript types. The testing package has no',
    'production dependencies. The Playgama Bridge is LGPL-3.0-or-later; the project MIT license does',
    'not replace its license. Sharp\'s installed native package also includes libvips components under',
    'the licenses recorded below. Playwright downloads Chromium separately; the browser is a local',
    'verification prerequisite and is excluded from the npm archives.', '',
    '## Installed transitive production dependencies', '',
    'This table follows required dependencies and installed optional dependencies from the direct',
    'packages above. Uninstalled optional binaries for other operating systems/architectures are',
    'excluded. Paths below are relative to each dependency package in `node_modules`.', '',
    '| Package | Version | License metadata | Notice files in installed package |',
    '| --- | --- | --- | --- |');
  for (const item of [...transitive.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) out.push(`| ${item.name} | ${item.version} | ${item.license} | ${item.notices.length ? item.notices.map((n) => '`' + n + '`').join(', ') : 'See package source/README'} |`);
  out.push('', '## Assets emitted into converted game builds', '',
    '- The Vite plugin copies the meshopt decoder and Basis Universal transcoders from the installed',
    '  three.js package. Meshopt uses MIT; Basis Universal uses Apache-2.0. Their upstream notices',
    '  remain in the distributed files. The three.js Basis directory has no separate license file.',
    '- The SQL adapter emits sql.js\'s WebAssembly file when a generated game uses SQL.',
    '- Playgama packaging emits the Bridge configuration and credits/license inventory as',
    '  `THIRD_PARTY.txt`; games retain their own license and asset credits.',
    '- Game exports and their assets are supplied separately and are excluded from these public npm',
    '  archives. They are not covered by this project\'s MIT grant.', '',
    'Upstream references: [Playgama Bridge](https://github.com/playgama/bridge),',
    '[Sharp/libvips](https://sharp.pixelplumbing.com/install/#licensing),',
    '[three.js](https://github.com/mrdoob/three.js),',
    '[Basis Universal](https://github.com/BinomialLLC/basis_universal), and',
    '[meshoptimizer](https://github.com/zeux/meshoptimizer).', '');
  return out.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = join(repository, 'THIRD_PARTY_NOTICES.md'); const text = dependencyNotices();
  assert.ok(!text.includes(repository));
  if (process.argv.includes('--check')) assert.equal(readFileSync(output, 'utf8'), text, 'dependency notice inventory is stale');
  else writeFileSync(output, text);
  console.log('dependency notice inventory verified');
}
