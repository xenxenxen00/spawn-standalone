import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AnchorError } from '../src/import/edit-kit.ts';
import { runImport, runInit } from '../src/import/command.ts';
import { buildImport, sha256, TOOL_VERSION } from '../src/import/pipeline.ts';
import { FolderOrigin, GitOrigin } from '../src/import/origin.ts';
import { fromDeclarative } from '../src/import/edits.ts';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url)).replaceAll('\\', '/');
const SOURCE = here('./fixture/export/source');
const WS = here('./fixture/ws');
const tmp = mkdtempSync(join(tmpdir(), 'ss-import-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const live = (out: string): { files: { path: string; added?: true; place?: string }[]; delta: { path: string; rule: string }[]; places: string[] } =>
  JSON.parse(readFileSync(join(out, '.import/live-files.json'), 'utf8'));

describe('import on the fixture export', () => {
  const out = join(tmp, 'game');

  it('copies the reachable tree, drops platform roots and unreached files, expands template-literal paths', async () => {
    const o = await runImport(WS, { out, now: () => new Date('2026-10-21T00:00:00Z') });
    expect(o.ok).toBe(true);
    const files = live(out).files.map((f) => f.path);
    expect(files).toEqual([
      'places/main/cells/x0z0.scene',
      'places/main/config.yaml',
      'scripts/added.js',
      'scripts/lib/data.yml',
      'scripts/lighting.js',
      'scripts/spawner.js',
      'scripts/spin.js',
      'scripts/ui.js',
      'sim.js',
      'templates/camera.js',
      'templates/enemies/a.js',
      'templates/enemies/b.js',
      'templates/player.js',
      'world.config.yaml',
    ]);
    // not reached: scripts/unused.js, templates/enemies/sub/c.js (folder match only), .spawn/**
    expect(live(out).delta).toEqual([{ path: 'ui/nametag.js', rule: 'platform-roots', reason: expect.any(String) }]);
    expect(live(out).places).toEqual(['main']);
    expect(live(out).files.find((f) => f.path === 'scripts/added.js')?.added).toBe(true);
    expect(existsSync(join(out, 'scripts/unused.js'))).toBe(false);
    expect(existsSync(join(out, 'ui/nametag.js'))).toBe(false);
  });

  it('applies the tracked edits with markers and records them', () => {
    const ui = readFileSync(join(out, 'scripts/ui.js'), 'utf8');
    expect(ui).toContain('// PORT-EDIT E-FX-01: pull in the added helper');
    expect(ui).toContain("import { added } from './added.js';");
    expect(ui).toContain('${DATA.title}${added()}');
    const world = readFileSync(join(out, 'world.config.yaml'), 'utf8');
    expect(world).toContain('name: "Fixture SA"');
    expect(world).not.toContain('nametag');
    expect(world).toContain('# a small fixture world');
    const edits = JSON.parse(readFileSync(join(out, '.import/edits.json'), 'utf8')) as { edits: { id: string; ops: { op: string; found: number; expected: number }[] }[] };
    expect(edits.edits.map((e) => e.id)).toEqual(['E-FX-01']);
    expect(edits.edits[0]!.ops.map((x) => x.op)).toEqual(['yamlSet', 'yamlDelete', 'addFile', 'replaceExact', 'replaceExact']);
    expect(readFileSync(join(out, '.import/patches/E-FX-01.diff'), 'utf8')).toContain('+++ b/scripts/added.js');
    const origin = JSON.parse(readFileSync(join(out, '.import/origin.json'), 'utf8')) as { game: string; commit: string; importedAt: string };
    expect(origin).toMatchObject({ game: 'fixture', commit: 'folder', importedAt: '2026-10-21T00:00:00.000Z' });
  });

  it('writes the preload sets and module roles', () => {
    const sets = JSON.parse(readFileSync(join(out, '.import/preload-sets.json'), 'utf8')) as { sets: Record<string, string[]> };
    expect(sets.sets['boot']).toEqual(expect.arrayContaining(['sim.js', 'scripts/ui.js', 'scripts/added.js', 'templates/player.js', 'templates/camera.js']));
    expect(sets.sets['place:main']).toEqual([]);
    const roles = JSON.parse(readFileSync(join(out, '.import/modules.json'), 'utf8')) as { registry: string[]; content: string[] };
    expect(roles.content).toEqual(['scripts/lighting.js']);
    expect(roles.registry).toContain('templates/enemies/a.js');
  });

  it('--check passes on a fresh tree, and names every drift', async () => {
    expect((await runImport(WS, { out, check: true })).ok).toBe(true);
    writeFileSync(join(out, 'scripts/spin.js'), '// hand edit\n');
    writeFileSync(join(out, 'scripts/stray.js'), '');
    rmSync(join(out, 'sim.js'));
    const o = await runImport(WS, { out, check: true });
    expect(o.ok).toBe(false);
    expect(o.diffs).toEqual(['changed scripts/spin.js', 'extra scripts/stray.js', 'missing sim.js']);
    // a write run repairs it, keeping importedAt (the records did not change)
    const w = await runImport(WS, { out });
    expect(w.removed).toEqual(['scripts/stray.js']);
    expect((await runImport(WS, { out, check: true })).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(out, '.import/origin.json'), 'utf8')).importedAt).toBe('2026-10-21T00:00:00.000Z');
  });
});

describe('edit anchors', () => {
  const origin = new FolderOrigin(SOURCE);
  const base = { origin, config: { name: 'F', slug: 'f', source: { dir: SOURCE } }, editContext: { flags: {}, readGameFile: () => '' } };
  const edit = (ops: unknown[]) => fromDeclarative({ id: 'E-T-01', title: 't', rationale: '', cites: [], files: [], ops: ops as never });

  it('preserves unchanged import provenance across converter upgrades, but records real changes', () => {
    const first = buildImport({ ...base, edits: [] });
    const record = (name: string) => first.tree.get(`.import/${name}.json`)!;
    const oldLive = JSON.parse(record('live-files').toString()); oldLive.toolVersion = '0.1.0';
    const oldBytes = Buffer.from(JSON.stringify(oldLive, null, 2) + '\n');
    const previousOrigin = { ...JSON.parse(record('origin').toString()), toolVersion: '0.1.0', importedAt: '2020-01-01T00:00:00.000Z', contentHash: sha256(Buffer.concat([oldBytes, record('edits'), record('preload-sets'), record('modules')])) };
    const same = buildImport({ ...base, edits: [], previousOrigin });
    expect(same.tree.get('.import/live-files.json')).toEqual(oldBytes);
    expect(JSON.parse(same.tree.get('.import/origin.json')!.toString())).toEqual(previousOrigin);
    const changed = buildImport({ ...base, previousOrigin, edits: [edit([{ op: 'addFile', path: 'new.js', text: 'export const value = 1;' }])] });
    expect(JSON.parse(changed.tree.get('.import/origin.json')!.toString())).toMatchObject({ toolVersion: TOOL_VERSION });
    expect(changed.tree.get('.import/live-files.json')).not.toEqual(oldBytes);
  });

  it('a missing or repeated anchor fails loudly, naming the edit', () => {
    expect(() => buildImport({ ...base, edits: [edit([{ op: 'replaceExact', path: 'sim.js', from: 'no such text', to: '' }])] })).toThrow(AnchorError);
    expect(() => buildImport({ ...base, edits: [edit([{ op: 'replaceExact', path: 'sim.js', from: 'ctx', to: 'c' }])] })).toThrow(/E-T-01 sim\.js: anchor "ctx" found 2×, expected 1×/);
    expect(() => buildImport({ ...base, edits: [edit([{ op: 'yamlSet', path: 'world.config.yaml', key: ['name'], value: 'x', expectOld: 'Other' }])] })).toThrow(/old value "Fixture"/);
    expect(() => buildImport({ ...base, edits: [edit([{ op: 'addFile', path: 'sim.js', text: '' }])] })).toThrow(/exists already/);
    expect(() => buildImport({ ...base, edits: [edit([{ op: 'yamlDelete', path: 'world.config.yaml', key: ['nope'] }])] })).toThrow(/found 0×/);
  });

  it('an edit that breaks the JS syntax is refused', () => {
    expect(() => buildImport({ ...base, edits: [edit([{ op: 'replaceExact', path: 'sim.js', from: 'export function tick(ctx) {', to: 'export function tick(ctx) {{' }])] })).toThrow(/does not parse/);
  });

  it('the pinned commit must match', () => {
    expect(() => buildImport({ ...base, config: { ...base.config, source: { dir: SOURCE, commit: 'abc' } }, origin: { ...origin, info: () => ({ commit: 'def', date: '', subject: '' }), list: () => origin.list(), read: (p: string) => origin.read(p) }, edits: [] })).toThrow(/≠ pinned abc/);
  });
});

describe('git origin and init', () => {
  it('reads committed bytes, not the working tree', () => {
    const repo = join(tmp, 'repo');
    cpSync(SOURCE, repo, { recursive: true });
    const git = (...a: string[]): string => {
      const r = spawnSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'fixture');
    writeFileSync(join(repo, 'sim.js'), 'dirty working tree\n');
    const o = new GitOrigin(repo);
    expect(o.info().subject).toBe('fixture');
    expect(o.read('sim.js').toString()).toContain('export const cadence');
    expect(o.list()).toContain('.spawn/engine.yaml');
  });

  it('init writes a config from export-info.json', () => {
    const exp = join(tmp, 'export');
    cpSync(SOURCE, join(exp, 'source'), { recursive: true });
    writeFileSync(join(exp, 'export-info.json'), JSON.stringify({ name: 'Fixture Game', commit: 'c0ffee', engineVersion: '6.0.0' }));
    const r = runInit(exp, { name: 'fixture-game', out: join(tmp, 'ws-init') });
    const cfg = JSON.parse(readFileSync(join(r.dir, 'standalone.config.json'), 'utf8')) as { name: string; source: { commit: string }; engine: { semver: string } };
    expect(cfg).toMatchObject({ name: 'Fixture Game', source: { commit: 'c0ffee' }, engine: { semver: '6.0.0' } });
    expect(() => runInit(exp, { name: 'fixture-game', out: join(tmp, 'ws-init') })).toThrow(/exists already/);
    expect(() => runInit(exp, { name: 'Bad Name' })).toThrow(/kebab-case/);
  });
});

describe('jobs as reach roots', () => {
  const copy = (): string => {
    const dir = mkdtempSync(join(tmp, 'jobsrc-'));
    cpSync(SOURCE, dir, { recursive: true });
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    writeFileSync(join(dir, 'jobs/think.js'), 'import { never } from "../scripts/unused.js";\nexport default function think() { return never(); }\n');
    return dir;
  };
  const run = (dir: string, config: object = {}, edits: ReturnType<typeof fromDeclarative>[] = []) =>
    buildImport({ origin: new FolderOrigin(dir), config: { name: 'F', slug: 'f', source: { dir }, roots: { jobs: true }, ...config } as never, edits, editContext: { flags: {}, readGameFile: () => '' } });
  const paths = (r: ReturnType<typeof run>): string[] => [...r.tree.keys()].filter((p: string) => !p.startsWith('.import/'));

  it('a jobs/<id>.js the source has is a root, with what it imports', () => {
    const r = run(copy());
    expect(paths(r)).toEqual(expect.arrayContaining(['jobs/think.js', 'scripts/unused.js']));
    const files = JSON.parse(Buffer.from(r.tree.get('.import/live-files.json')!).toString('utf8')).files as { path: string; roots: string[] }[];
    expect(files.find((f) => f.path === 'jobs/think.js')!.roots).toEqual(['job:think']);
  });

  it('opt-in: without roots.jobs the jobs/ files are not carried (as before)', () => {
    const r = run(copy(), { roots: {} });
    expect(paths(r)).not.toContain('jobs/think.js');
    expect(paths(r)).not.toContain('scripts/unused.js');
  });

  it('negative control: without the jobs/ file nothing of it is carried', () => {
    const dir = copy();
    rmSync(join(dir, 'jobs'), { recursive: true });
    expect(paths(run(dir))).not.toContain('scripts/unused.js');
  });

  it('the jobs: config key names the file; the job is neither a registry module nor content', () => {
    const dir = copy();
    cpSync(join(dir, 'jobs/think.js'), join(dir, 'jobs/other.js'));
    rmSync(join(dir, 'jobs/think.js'));
    const r = run(dir, { jobs: { cpu: 'jobs/other.js' } });
    const roles = JSON.parse(Buffer.from(r.tree.get('.import/modules.json')!).toString('utf8')) as { registry: string[]; content: string[] };
    expect(paths(r)).toContain('jobs/other.js');
    for (const p of ['jobs/other.js', 'scripts/unused.js']) {
      expect(roles.registry).not.toContain(p);
      expect(roles.content).not.toContain(p);
    }
  });

  it('a job module an edit adds is carried through the jobs: key; a key naming nothing is an error', () => {
    const dir = copy();
    rmSync(join(dir, 'jobs'), { recursive: true });
    const add = fromDeclarative({ id: 'E-T-02', title: 't', rationale: '', cites: [], files: [], ops: [{ op: 'addFile', path: 'jobs/cpu.js', text: 'import { onTick } from "../scripts/spin.js";\nexport default () => onTick;\n' }] as never });
    const r = run(dir, { jobs: { cpu: 'jobs/cpu.js' } }, [add]);
    expect(paths(r)).toContain('jobs/cpu.js');
    const files = JSON.parse(Buffer.from(r.tree.get('.import/live-files.json')!).toString('utf8')).files as { path: string; roots: string[] }[];
    expect(files.find((x) => x.path === 'scripts/spin.js')!.roots).toContain('job:cpu');
    expect(() => run(dir, { jobs: { cpu: 'jobs/cpu.js' } })).toThrow(/jobs\.cpu names jobs\/cpu\.js/);
  });
});
