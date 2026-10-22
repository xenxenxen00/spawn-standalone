import { execFileSync } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SourceFinding { path: string; line: number; rule: string; origin: string }
const rules: readonly [string, RegExp][] = [
  ['github-credential', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['service-credential', /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{32,}|sk_live_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})/g],
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g],
  ['credential-url', /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/:@]+:[^\s/@]+@/g],
  ['jwt-credential', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g],
  ['credential-literal', /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|_authToken|client[_-]?secret|password|private[_-]?key)['"]?\s*[:=]\s*(?:['"][^'"\r\n]{12,}['"]|[^\s'"{};,]{12,})/gi],
  ['private-checkout-path', /(?:[A-Za-z]:[\\/]+Users[\\/]+(?!<|example[\\/])[^\s'"/\\]+[\\/]|\/Users\/[^\s'"/]+\/|\.claude[\\/]worktrees[\\/])/g],
];
const privatePath = /^(?:games\/|\.claude\/|exports?\/)|(?:^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$|^packages\/runtime\/src\/(?:compat\/legacy\/|runtime\/legacy\/|platform\/save-schema\.)|^packages\/runtime\/test\/ports\/fixtures\/(?:crown-clash|crown-riot|pip-skybloom)\//i;

/** Findings contain locations and rule names, never matched file contents. */
export function inspectSource(path: string, bytes: Buffer, origin = 'working-tree'): SourceFinding[] {
  const findings: SourceFinding[] = [];
  if (privatePath.test(path)) findings.push({ path, line: 1, rule: 'private-content-path', origin });
  if (bytes.includes(0) || !isUtf8(bytes)) return [...findings, { path, line: 1, rule: 'unreviewed-binary', origin }];
  const text = bytes.toString('utf8');
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) findings.push({ path, line: text.slice(0, match.index).split('\n').length, rule, origin });
  }
  return findings;
}

export function auditSource(root: string): { workingFiles: number; commits: number; historyBlobs: number; findings: SourceFinding[] } {
  const git = (...args: string[]): Buffer => execFileSync('git', ['-C', root, ...args], { maxBuffer: 64 << 20 });
  const paths = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean))];
  const findings: SourceFinding[] = [];
  for (const path of paths) {
    const full = resolve(root, path);
    if (lstatSync(full).isSymbolicLink()) findings.push({ path, line: 1, rule: 'source-symlink', origin: 'working-tree' });
    else findings.push(...inspectSource(path, readFileSync(full)));
  }
  const commits = git('rev-list', '--all').toString().trim().split('\n').filter(Boolean);
  const blobs = new Map<string, { path: string; origin: string }[]>();
  const addBlob = (oid: string, path: string, origin: string): void => {
    if (!blobs.has(oid)) blobs.set(oid, []);
    const names = blobs.get(oid)!;
    if (!names.some(item => item.path === path && item.origin === origin)) names.push({ path, origin });
  };
  for (const entry of git('ls-files', '--stage', '-z').toString().split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t'); const [mode, oid, stage] = entry.slice(0, tab).split(' '); const path = entry.slice(tab + 1);
    if (mode !== '100644' && mode !== '100755' || stage !== '0') findings.push({ path, line: 1, rule: 'index-nonregular-file', origin: 'index' });
    else addBlob(oid!, path, 'index:' + oid);
  }
  const historical = new Set<string>();
  for (const commit of commits) {
    for (const entry of git('ls-tree', '-r', '-z', commit).toString().split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t'); const metadata = entry.slice(0, tab); const path = entry.slice(tab + 1);
      const [mode, type, oid] = metadata.split(' ');
      if (mode === '120000' || type !== 'blob') { findings.push({ path: path!, line: 1, rule: 'history-nonregular-file', origin: commit }); continue; }
      historical.add(oid!); addBlob(oid!, path, 'history:' + oid);
    }
  }
  if (blobs.size) {
    const data = execFileSync('git', ['-C', root, 'cat-file', '--batch'], { input: [...blobs.keys()].join('\n') + '\n', maxBuffer: 128 << 20 });
    let offset = 0;
    for (const [oid, names] of blobs) {
      const end = data.indexOf(10, offset); const header = data.subarray(offset, end).toString().split(' '); const size = Number(header[2]);
      if (header[0] !== oid || header[1] !== 'blob' || !Number.isSafeInteger(size)) throw new Error('Invalid Git blob response');
      const bytes = data.subarray(end + 1, end + 1 + size);
      for (const { path, origin } of names) findings.push(...inspectSource(path, bytes, origin));
      offset = end + size + 2;
    }
  }
  return { workingFiles: paths.length, commits: commits.length, historyBlobs: historical.size, findings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = auditSource(resolve(import.meta.dirname, '../..'));
  console.log(JSON.stringify(result, null, 2));
  if (result.findings.length) process.exitCode = 1;
}
