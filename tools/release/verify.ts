import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackages, packageNames, repository } from './build.ts';
import { parse } from 'acorn';
import { simple } from 'acorn-walk';

const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const run = (args: string[], cwd: string): string => {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 600_000, maxBuffer: 16 << 20 });
  assert.equal(result.status, 0, `${args[0]} failed\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};

export function archiveEntries(data: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(data); const entries = new Map<string, Buffer>();
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512); if (header.every((b) => b === 0)) break;
    const text = (start: number, end: number): string => header.subarray(start, end).toString().replace(/\0.*$/s, '');
    const size = Number.parseInt(text(124, 136).trim(), 8); assert.ok(Number.isFinite(size));
    const name = [text(345, 500), text(0, 100)].filter(Boolean).join('/');
    if (header[156] === 0 || header[156] === 48) entries.set(name, tar.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(entries.size > 0); return entries;
}

export function auditArchive(data: Buffer): number {
  const entries = archiveEntries(data);
  assert.ok(entries.has('package/LICENSE'), 'package license is missing');
  assert.ok(entries.has('package/NOTICE'), 'package notice is missing');
  for (const [path, bytes] of entries) {
    assert.match(path, /^package\/(dist\/|package\.json$|LICENSE$|NOTICE$|THIRD_PARTY_NOTICES\.md$|README\.md$)/);
    assert.doesNotMatch(path, /(^|\/)(games|\.cache|exports|test|tests|fixtures?|legacy)(\/|$)|save-schema\.(js|d\.ts)$/i);
    if (!/\.(js|ts|json|css|md|txt)$/.test(path)) continue;
    const text = bytes.toString('utf8');
    assert.doesNotMatch(text, /(?:[A-Za-z]:[\\/]+Users[\\/]|\/Users\/|\/home\/)|(?:gh[pousr]_[A-Za-z0-9]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,})/, `private path or credential in ${path}`);
    assert.doesNotMatch(text, /(?:from\s*|import\s*\()\s*['"](?:\.\.\/)+(?:runtime|vite|cli|testing)\/src\//, `sibling package source import in ${path}`);
  }
  const metadata = entries.get('package/package.json');
  assert.ok(metadata, 'package metadata is missing');
  const manifest = JSON.parse(metadata.toString());
  assert.equal(manifest.private, undefined); assert.equal(manifest.license, 'MIT');
  const declared = new Set([manifest.name, ...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
  for (const [path, bytes] of entries) {
    if (!/\.(?:js|d\.ts)$/.test(path)) continue;
    const check = (specifier: unknown): void => {
      if (typeof specifier !== 'string' || specifier.startsWith('node:')) return;
      if (specifier.startsWith('virtual:')) {
        assert.ok(!path.startsWith('package/dist/src/compat/') && !path.startsWith('package/dist/src/render/'), `engine module ${path} imports ${specifier}`);
        return;
      }
      if (specifier.startsWith('.')) {
        const target = posix.normalize(posix.join(posix.dirname(path), specifier.split('?')[0]!));
        assert.ok(entries.has(target), `missing packaged module: ${path} -> ${specifier}`);
      } else {
        const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;
        assert.ok(declared.has(name), `undeclared dependency: ${path} -> ${name}`);
      }
    };
    if (path.endsWith('.d.ts')) {
      for (const match of bytes.toString().matchAll(/(?:from\s+|import\s*\(|import\s+)['"]([^'"]+)['"]/g)) check(match[1]);
      continue;
    }
    const ast = parse(bytes.toString(), { ecmaVersion: 'latest', sourceType: 'module' });
    simple(ast, {
      ImportDeclaration: (node) => check(node.source.value), ExportNamedDeclaration: (node) => { if (node.source) check(node.source.value); },
      ExportAllDeclaration: (node) => check(node.source.value), ImportExpression: (node) => { if (node.source.type === 'Literal') check(node.source.value); },
      NewExpression: (node) => { if (node.callee.type === 'Identifier' && node.callee.name === 'URL' && node.arguments[0]?.type === 'Literal') { const value = node.arguments[0].value; if (typeof value === 'string' && value.startsWith('.')) check(value); } },
    });
  }
  for (const value of Object.values(manifest.exports ?? {})) {
    const targets = typeof value === 'string' ? [value] : Object.values(value as Record<string, string>);
    for (const target of targets) if (!target.includes('*')) assert.ok(entries.has('package/' + target.replace(/^\.\//, '')), `missing public export: ${target}`);
  }
  return entries.size;
}

interface LockEntry {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  [key: string]: unknown;
}

/** Preserve the already-fetched dependency graph without requiring registry metadata in offline CI. */
export function installationLock(manifest: { name: string; dependencies: Record<string, string>; devDependencies: Record<string, string> }, source: Record<string, LockEntry>, archives: Record<string, LockEntry>): Record<string, unknown> {
  const available = { ...source, ...archives };
  const packages: Record<string, LockEntry> = { '': { name: manifest.name, dependencies: manifest.dependencies, devDependencies: manifest.devDependencies } };
  const find = (from: string, name: string): string | null => {
    let dir = from;
    for (;;) {
      const candidate = (dir ? dir + '/' : '') + 'node_modules/' + name;
      if (available[candidate] && !available[candidate]!.link) return candidate;
      if (!dir) return null;
      const up = posix.dirname(dir); dir = up === '.' ? '' : up;
    }
  };
  const visit = (location: string): void => {
    if (packages[location]) return;
    const item = available[location]; assert.ok(item, `missing locked dependency: ${location}`);
    packages[location] = item;
    const optional = item.optionalDependencies ?? {};
    const dependencies = { ...item.dependencies, ...optional };
    for (const name of Object.keys(dependencies)) {
      const target = find(location, name);
      if (!target) { assert.ok(name in optional, `missing locked dependency: ${location} -> ${name}`); continue; }
      visit(target);
    }
    for (const name of Object.keys(item.peerDependencies ?? {})) {
      const target = find(location, name);
      if (!target) { assert.ok(item.peerDependenciesMeta?.[name]?.optional, `missing locked peer: ${location} -> ${name}`); continue; }
      visit(target);
    }
  };
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const target = find('', name); assert.ok(target, `missing locked root dependency: ${name}`); visit(target);
  }
  return { name: manifest.name, lockfileVersion: 3, requires: true, packages };
}

export function verifyRelease(): void {
  const requested = process.argv.indexOf('--out');
  const base = requested >= 0 ? resolve(process.argv[requested + 1]!) : join(tmpdir(), 'spawn-standalone-release-check');
  mkdirSync(base, { recursive: true });
  const output = mkdtempSync(join(base, 'candidate-')); const install = join(output, 'installed'); mkdirSync(install);
  const rel = relative(realpathSync(repository), realpathSync(output));
  assert.ok(rel.startsWith('..') || isAbsolute(rel), 'release install must be outside the checkout');
  assert.ok(!process.env.NODE_PATH, 'NODE_PATH may mask missing public dependencies');
  buildPackages();
  const dependencies: Record<string, string> = {}; const archiveLocks: Record<string, LockEntry> = {}; const packed: { name: string; files: number; archive: string }[] = [];
  for (const name of packageNames) {
    const info = JSON.parse(run([npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', output], join(repository, 'packages', name)))[0];
    const archive = join(output, info.filename); const count = auditArchive(readFileSync(archive));
    const bytes = readFileSync(archive);
    const metadata = JSON.parse(archiveEntries(bytes).get('package/package.json')!.toString());
    const specifier = 'file:../' + info.filename;
    dependencies[metadata.name] = specifier;
    const entry: LockEntry = { version: metadata.version, resolved: specifier, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') };
    for (const key of ['license', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'engines', 'bin']) if (metadata[key] !== undefined) entry[key] = metadata[key];
    archiveLocks['node_modules/' + metadata.name] = entry;
    packed.push({ name: info.name, files: count, archive });
  }
  const manifest = { name: 'standalone-release-verification', private: true, type: 'module', dependencies, devDependencies: { typescript: '7.0.2', '@types/node': '24.19.1', '@types/three': '0.186.0', '@types/sql.js': '1.4.11' } };
  const source = JSON.parse(readFileSync(join(repository, 'package-lock.json'), 'utf8')).packages;
  writeFileSync(join(install, 'package.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(install, 'package-lock.json'), JSON.stringify(installationLock(manifest, source, archiveLocks), null, 2));
  run([npm, 'ci', '--offline', '--no-audit', '--no-fund'], install);
  for (const name of packageNames) {
    const path = join(install, 'node_modules/@spawn-standalone', name); const resolved = realpathSync(path);
    assert.equal(resolved.toLowerCase(), resolve(path).toLowerCase(), `${name} is a link outside the fresh install`);
    assert.ok(!relative(install, resolved).startsWith('..'));
  }
  for (const tool of ['smoke.mjs', 'dependency-paths.ts']) cpSync(join(repository, 'tools/release', tool), join(install, tool));
  const log = run([join(install, 'smoke.mjs')], install); writeFileSync(join(output, 'smoke.log'), log);
  writeFileSync(join(output, 'release-report.json'), JSON.stringify({ status: 'pass', node: process.version, packed, install, checks: log.trim().split('\n') }, null, 2) + '\n');
  console.log(log.trim()); console.log(`release verification passed: ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) verifyRelease();
