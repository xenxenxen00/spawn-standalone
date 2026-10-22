import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { auditSource, inspectSource } from './source-audit.ts';
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('detects credentials, private paths, game exports and binary payloads without echoing matches', () => {
  const token = 'ghp_' + 'x'.repeat(36);
  const bytes = Buffer.from('const value = "' + token + '";');
  const result = inspectSource('src/example.ts', bytes);
  expect(result[0]?.rule).toBe('github-credential'); expect(JSON.stringify(result)).not.toContain(token);
  expect(inspectSource('games/example/source.js', Buffer.from('export const value = 1;'))[0]?.rule).toBe('private-content-path');
  expect(inspectSource('src/path.ts', Buffer.from(['C:', 'Users', 'owner', 'private'].join('/')))[0]?.rule).toBe('private-checkout-path');
  expect(inspectSource('src/asset.bin', Buffer.from([1, 0, 2]))[0]?.rule).toBe('unreviewed-binary');
  expect(inspectSource('src/asset.bin', Buffer.from([255, 254, 253, 252]))[0]?.rule).toBe('unreviewed-binary');
  expect(inspectSource('src/example.ts', Buffer.from('export const value = 1;'))).toEqual([]);
});

it.each([
  ['service-credential', 'sk-' + 'x'.repeat(40)],
  ['service-credential', 'npm_' + 'x'.repeat(36)],
  ['service-credential', 'AKIA' + 'X'.repeat(16)],
  ['private-key', '-----BEGIN ' + 'PRIVATE KEY-----'],
  ['credential-url', 'https://' + 'person:synthetic-password@example.invalid'],
  ['jwt-credential', ['eyJ' + 'x'.repeat(24), 'x'.repeat(24), 'x'.repeat(24)].join('.')],
  ['credential-literal', ['const', 'password', '='].join(' ') + ' ' + JSON.stringify('synthetic-' + 'x'.repeat(20))],
  ['credential-literal', JSON.stringify({ password: 'synthetic-' + 'x'.repeat(20) })],
  ['credential-literal', ['"password"', ': ', 'synthetic-' + 'x'.repeat(20)].join('')],
  ['credential-literal', ['//registry.example.invalid/:', '_authToken', '=', 'synthetic-' + 'x'.repeat(20)].join('')],
])('detects %s without exposing its test value', (rule, value) => {
  const findings = inspectSource('src/control.ts', Buffer.from(value));
  expect(findings.some(item => item.rule === rule)).toBe(true);
  expect(JSON.stringify(findings)).not.toContain(value);
});

it('audits every reachable historical blob even after a credential is removed from the current file', () => {
  const root = mkdtempSync(join(tmpdir(), 'public-source-audit-')); temporary.push(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  const token = 'github_pat_' + 'x'.repeat(50);
  writeFileSync(join(root, 'example.js'), 'export const value = "' + token + '";');
  git('add', 'example.js'); git('commit', '-q', '-m', 'Add synthetic audit control');
  writeFileSync(join(root, 'example.js'), 'export const value = 1;');
  git('add', 'example.js'); git('commit', '-q', '-m', 'Remove synthetic audit control');
  const result = auditSource(root);
  expect(result.commits).toBe(2); expect(result.historyBlobs).toBe(2);
  expect(result.findings).toHaveLength(1); expect(result.findings[0]?.origin).toMatch(/^history:/);
  expect(JSON.stringify(result)).not.toContain(token);
});

it('audits staged content when the working file has already been cleaned', () => {
  const root = mkdtempSync(join(tmpdir(), 'public-source-index-')); temporary.push(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  const token = 'ghp_' + 'x'.repeat(36);
  writeFileSync(join(root, 'example.js'), JSON.stringify(token)); git('add', 'example.js');
  writeFileSync(join(root, 'example.js'), 'export const value = 1;');
  const result = auditSource(root);
  expect(result.findings.some(item => item.origin.startsWith('index:') && item.rule === 'github-credential')).toBe(true);
  expect(JSON.stringify(result)).not.toContain(token);
});
