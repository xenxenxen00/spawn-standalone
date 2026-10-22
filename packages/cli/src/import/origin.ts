// The read-only source of an import: a git clone read through git objects at one commit (the export's `source/`), or a plain
// folder (fixtures). Never writes. Pattern after purge-protocol-web ebab692 tools/import-live/origin.ts.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface OriginInfo {
  commit: string;
  /** ISO commit date; '' for a folder */
  date: string;
  subject: string;
}

export interface OriginSource {
  info(): OriginInfo;
  /** every file, tree paths, sorted */
  list(): string[];
  read(path: string): Buffer;
}

function git(dir: string, args: string[], input?: string): Buffer {
  const r = spawnSync('git', ['-C', dir, ...args], { input, maxBuffer: 1 << 30, windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${dir}: ${r.stderr?.toString().trim() ?? r.error?.message}`);
  return r.stdout;
}

/** A git clone at `commit` (default HEAD), read through `ls-tree` and `cat-file --batch`; the working tree is never read. */
export class GitOrigin implements OriginSource {
  private readonly files = new Map<string, Buffer>();
  private readonly meta: OriginInfo;

  constructor(dir: string, commit?: string) {
    const head = git(dir, ['rev-parse', `${commit ?? 'HEAD'}^{commit}`]).toString().trim();
    const [date = '', subject = ''] = git(dir, ['log', '-1', '--format=%cI%n%s', head]).toString().split('\n');
    this.meta = { commit: head, date, subject };
    const entries = git(dir, ['ls-tree', '-r', '-z', '--full-tree', head])
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        const [, type, oid] = line.slice(0, tab).split(' ');
        return { type: type!, oid: oid!, path: line.slice(tab + 1) };
      })
      .filter((e) => e.type === 'blob');
    const out = git(dir, ['cat-file', '--batch'], entries.map((e) => e.oid).join('\n') + '\n');
    let at = 0;
    for (const e of entries) {
      const nl = out.indexOf(0x0a, at);
      const header = out.subarray(at, nl).toString();
      const size = Number(header.split(' ')[2]);
      if (!header.startsWith(e.oid) || !Number.isFinite(size)) throw new Error(`git cat-file: unexpected header ${header}`);
      this.files.set(e.path, Buffer.from(out.subarray(nl + 1, nl + 1 + size)));
      at = nl + 1 + size + 1;
    }
  }

  info(): OriginInfo {
    return this.meta;
  }
  list(): string[] {
    return [...this.files.keys()].sort();
  }
  read(path: string): Buffer {
    const b = this.files.get(path);
    if (!b) throw new Error(`origin: ${path} is not in ${this.meta.commit}`);
    return b;
  }
}

/** A plain folder (no git): every file except `.git/`; the commit is the config's pin (or 'folder'). */
export class FolderOrigin implements OriginSource {
  private readonly root: string;
  private readonly paths: string[];
  private readonly commit: string;

  constructor(root: string, commit?: string) {
    this.root = root;
    this.commit = commit ?? 'folder';
    const out: string[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const name of readdirSync(dir)) {
        if (rel === '' && name === '.git') continue;
        const abs = join(dir, name);
        const r = rel ? `${rel}/${name}` : name;
        if (statSync(abs).isDirectory()) walk(abs, r);
        else out.push(r);
      }
    };
    walk(root, '');
    this.paths = out.sort();
  }

  info(): OriginInfo {
    return { commit: this.commit, date: '', subject: '' };
  }
  list(): string[] {
    return this.paths;
  }
  read(path: string): Buffer {
    return readFileSync(join(this.root, path));
  }
}

/** git when `dir` is a clone, else a folder */
export function openOrigin(dir: string, commit?: string): OriginSource {
  return existsSync(join(dir, '.git')) ? new GitOrigin(dir, commit) : new FolderOrigin(dir, commit);
}
