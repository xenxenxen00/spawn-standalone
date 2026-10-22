import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadManifest, parseManifest, type CapabilityManifest } from '../../runtime/capabilities/types.ts';
import { ManifestIndex, buildReport, keyLines, runCoverage, scanConfig, scanJs, scanTree } from '../src/index.ts';

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** writes a small game tree into a temp dir: { 'places/main/sim.js': '...' } */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ss-cov-'));
  temps.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return dir;
}

const chains = (src: string): string[] => scanJs(src).chains.map((c) => `${c.viaResult ? 'result:' : ''}${c.path.join('.')}@${c.line}`);

const mini: CapabilityManifest = {
  version: 1,
  runtime: 'test',
  description: '',
  entries: [
    { id: 'ctx.self.state', kind: 'ctx', status: 'implemented' },
    { id: 'ctx.self.anim.*', kind: 'ctx', status: 'implemented' },
    { id: 'ctx.self.anim', kind: 'ctx', status: 'implemented' },
    { id: 'ctx.self.bones', kind: 'ctx', status: 'absent', plan: 'K3' },
    { id: 'ctx.world.places.*', kind: 'ctx', status: 'partial' },
    { id: 'ctx.sql', kind: 'ctx', status: 'loud' },
    { id: 'ctx.emit', kind: 'ctx', status: 'implemented' },
    { id: 'act:squash', kind: 'act', status: 'absent' },
    { id: 'act:fx', kind: 'act', status: 'implemented' },
    { id: 'hook:cadence', kind: 'hook', status: 'partial' },
    { id: 'hook:cadence=100ms', kind: 'hook', status: 'implemented' },
    { id: 'hook:onArrive', kind: 'hook', status: 'absent' },
    { id: 'builtin/physics.raycast', kind: 'builtin', status: 'implemented' },
    { id: 'builtin/room-routing', kind: 'builtin', status: 'absent' },
    { id: 'config:atmosphere.fog', kind: 'config', status: 'partial' },
    { id: 'config:atmosphere.fog.kind=linear', kind: 'config', status: 'absent' },
    { id: 'config:inputs.actions.*', kind: 'config', status: 'implemented' },
    { id: 'config:inputs.actions.*.gamepad', kind: 'config', status: 'absent' },
    { id: 'spec:projection=orthographic', kind: 'spec', status: 'absent' },
    { id: 'config:name', kind: 'config', status: 'implemented' },
    { id: 'config:camera', kind: 'config', status: 'implemented' },
    { id: 'config:routing', kind: 'config', status: 'absent' },
  ],
};

describe('ctx chain extraction and alias resolution', () => {
  it('records one use per outermost chain', () => {
    expect(chains('export function update(ctx) {\n  ctx.self.state.live.hp = 3;\n  ctx.emit("x");\n}')).toEqual(['self.state.live.hp@2', 'emit@3']);
  });

  it('follows a local alias and a destructured root', () => {
    const src = [
      'export function update(ctx) {',
      '  const me = ctx.self;',
      '  me.feetPosition.x = 1;',
      '  const { world, self: s } = ctx;',
      '  s.anim.walk = 1;',
      '  world.state.round = 2;',
      '}',
    ].join('\n');
    const got = chains(src);
    expect(got).toContain('self@2'); // the declaration reads the chain it names
    expect(got).toContain('self.feetPosition.x@3');
    expect(got).toContain('world@4');
    expect(got).toContain('self@4');
    expect(got).toContain('self.anim.walk@5');
    expect(got).toContain('world.state.round@6');
  });

  it('resolves destructuring of a nested chain and `a || b` aliases', () => {
    const src = 'export function f(ctx) {\n  const { state } = ctx.self;\n  state.hp = 1;\n  const w = ctx.place || {};\n  w.gravity.y;\n  let t;\n  t = ctx.world.state;\n  t.round;\n}';
    const got = chains(src);
    expect(got).toContain('self.state@2');
    expect(got).toContain('self.state.hp@3');
    expect(got).toContain('place.gravity.y@5');
    expect(got).toContain('world.state.round@8');
  });

  it('scopes aliases: a shadowing parameter or an inner rebinding hides the chain', () => {
    const src = 'export function f(ctx) {\n  const me = ctx.self;\n  [1].forEach((me) => me.feetPosition);\n  function g(me) { return me.state; }\n  me.id;\n}';
    const got = chains(src);
    expect(got).not.toContain('self.feetPosition@3');
    expect(got).not.toContain('self.state@4');
    expect(got).toContain('self.id@5');
  });

  it('keeps `<x>.ctx` as a root, marks computed keys and follows ctx.getObject results', () => {
    const src = 'export function f(k, ctx) {\n  k.ctx.sql.run();\n  ctx.world.places[id].state.x;\n  const o = ctx.getObject("a");\n  o.children;\n  ctx.getObject("b").material.dissolve = 1;\n}';
    const got = chains(src);
    expect(got).toContain('sql.run@2');
    expect(got).toContain('world.places.[*].state.x@3');
    expect(got).toContain('result:children@5');
    expect(got).toContain('result:material.dissolve@6');
    expect(got).toContain('getObject@4');
  });

  it('does not count a bare alias passed on as a value', () => {
    expect(chains('export function f(ctx) {\n  const me = ctx.self;\n  use(me);\n}')).toEqual(['self@2']);
  });
});

describe('builtin imports', () => {
  it('lists named, default and namespace imports of builtin modules only', () => {
    const src = 'import { raycast, getInputRay as ray } from "builtin/physics";\nimport * as T from "builtin/tween";\nimport x from "./local.js";\nimport "builtin/room-routing";';
    expect(scanJs(src).imports).toEqual([
      { module: 'builtin/physics', name: 'raycast', line: 1 },
      { module: 'builtin/physics', name: 'getInputRay', line: 1 },
      { module: 'builtin/tween', name: null, line: 2 },
      { module: 'builtin/room-routing', name: null, line: 4 },
    ]);
  });
});

describe('act topics', () => {
  it('reads literal topics through ctx.emit and an aliased emit, and flags computed ones', () => {
    const src = 'export function f(ctx, k) {\n  ctx.emit("squash", {});\n  const emit = ctx.emit;\n  emit("fx", {});\n  ctx.emit(k, {});\n  ctx.emit(`pp:ready`);\n}';
    expect(scanJs(src).emits).toEqual([
      { topic: 'squash', line: 2 },
      { topic: 'fx', line: 4 },
      { topic: null, line: 5 },
      { topic: 'pp:ready', line: 6 },
    ]);
  });
});

describe('exports and object specs', () => {
  it('lists exported names with the literal of a const', () => {
    const src = 'export const cadence = "1s";\nexport function onArrive(ctx) {}\nconst a = 1;\nexport { a as skeleton };\nexport default function () {}\nexport const n = 4;';
    expect(scanJs(src).exports).toEqual([
      { name: 'cadence', line: 1, value: '1s' },
      { name: 'onArrive', line: 2 },
      { name: 'skeleton', line: 4 },
      { name: 'default', line: 5 },
      { name: 'n', line: 6, value: '4' },
    ]);
  });

  it('reads spec keys of an exported template object and of a ctx.spawn argument', () => {
    const tpl = 'export const camera = { kind: "custom", projection: "orthographic", physics: { collisionGroups: 1 }, state: { a: 1 } };';
    expect(scanJs(tpl, { isTemplate: true }).specs.map((s) => s.path + (s.value ? `=${s.value}` : ''))).toEqual(['kind=custom', 'projection=orthographic', 'physics', 'physics.collisionGroups=1', 'state']);
    expect(scanJs(tpl).specs).toEqual([]);
    expect(scanJs('ctx.spawn("id", { vector: {}, layout: { box: {} } });').specs.map((s) => s.path)).toEqual(['vector', 'layout', 'layout.box']);
  });
});

describe('config keys', () => {
  it('flattens leaves, collapses game-named maps and finds line numbers', () => {
    const yaml = ['name: X', 'inputs:', '  actions:', '    dash:', '      keys: [space]', '      gamepad: Button0', 'atmosphere:', '  fog:', '    kind: linear', '    far: 140'].join('\n');
    const keys = scanConfig(yaml);
    expect(keys).toContainEqual({ path: 'name', value: 'X', line: 1 });
    expect(keys).toContainEqual({ path: 'inputs.actions.*.gamepad', value: 'Button0', line: 6 });
    expect(keys).toContainEqual({ path: 'atmosphere.fog.kind', value: 'linear', line: 9 });
    expect(keys.find((k) => k.path === 'inputs.actions.*.keys')?.line).toBe(5);
  });

  it('falls back to the parent line for keys inside a flow mapping', () => {
    const yaml = 'achievements:\n  win: { name: "W", trophy: "t.json" }\n';
    expect(scanConfig(yaml).map((k) => `${k.path}@${k.line}`)).toEqual(['achievements.*.name@2', 'achievements.*.trophy@2']);
    expect(keyLines(yaml).get('achievements\u0000win')).toBe(2);
  });

  it('rejects invalid YAML', () => {
    expect(() => scanConfig('a: [1, 2\n')).toThrow();
  });
});

describe('manifest matching', () => {
  const idx = new ManifestIndex(mini);

  it('prefers the longest entry and lets a prefix cover deeper members', () => {
    expect(idx.match('ctx.self.state.hp.max')?.id).toBe('ctx.self.state');
    expect(idx.match('ctx.self.bones.arm.pitch')?.id).toBe('ctx.self.bones');
  });

  it('matches a wildcard segment, including a computed key', () => {
    expect(idx.match('ctx.self.anim.walk')?.id).toBe('ctx.self.anim.*');
    expect(idx.match('ctx.self.anim')?.id).toBe('ctx.self.anim');
    expect(idx.match('ctx.world.places.[*].state.x')?.id).toBe('ctx.world.places.*');
    expect(idx.match('ctx.world.places.lobby')?.id).toBe('ctx.world.places.*');
  });

  it('refines by literal value and falls back to the plain entry', () => {
    expect(idx.match('hook:cadence', '100ms')?.status).toBe('implemented');
    expect(idx.match('hook:cadence', '1s')?.status).toBe('partial');
    expect(idx.match('config:atmosphere.fog.kind', 'linear')?.status).toBe('absent');
    expect(idx.match('config:atmosphere.fog.kind', 'exp2')?.status).toBe('partial');
    expect(idx.match('spec:projection', 'orthographic')?.status).toBe('absent');
    expect(idx.match('spec:projection', 'perspective')).toBeNull();
  });

  it('uses a module entry for any name imported from it', () => {
    expect(idx.match('builtin/room-routing.pickRoom')?.status).toBe('absent');
    expect(idx.match('builtin/physics.raycast')?.status).toBe('implemented');
    expect(idx.match('builtin/physics.overlapPoint')).toBeNull();
  });

  it('returns null for unknown surfaces and reports strict prefixes as containers', () => {
    expect(idx.match('ctx.nothing.here')).toBeNull();
    expect(idx.isContainer('ctx.self')).toBe(true);
    expect(idx.isContainer('ctx.nothing')).toBe(false);
    expect(idx.isContainer('ctx.world.places')).toBe(true);
  });
});

describe('scanTree and buildReport', () => {
  const game = {
    'world.config.yaml': 'name: G\ncamera: templates/camera.js#camera\nrouting:\n  script: scripts/routing.js\ninputs:\n  actions:\n    dash:\n      keys: [space]\n      gamepad: A\n',
    'places/main/config.yaml': 'atmosphere:\n  fog:\n    kind: linear\n    far: 9\ngravity:\n  y: -24\n',
    'sim.js': 'export const cadence = "1s";\nexport function tick(ctx) {\n  const me = ctx.self;\n  ctx.sql.run("x");\n  ctx.emit("squash", {});\n  ctx.emit("wake");\n  ctx.mystery.call();\n  me.bones.arm = 1;\n}\nexport function helper() {}\nexport function onWeird() {}',
    'scripts/arrival.js': 'import { raycast, overlapPoint } from "builtin/physics";\nimport { pickRoom } from "builtin/room-routing";\nexport function onArrive(ctx) { raycast(ctx); }',
    'templates/camera.js': 'export const camera = { projection: "orthographic" };',
    'jobs/cpu.js': 'export function run() {}',
    'docs/skip.js': 'ctx.sql.run();',
    '.spawn/skip.js': 'ctx.sql.run();',
    'node_modules/pkg/skip.js': 'ctx.sql.run();',
  };

  it('skips .spawn, docs and node_modules and counts files', () => {
    const scan = scanTree(tree(game));
    expect(scan.jsFiles).toBe(4);
    expect(scan.yamlFiles).toBe(2);
    expect(scan.usages.filter((u) => u.id === 'ctx.sql.run').length).toBe(1);
  });

  it('groups usages by status with samples, custom events and unknowns', () => {
    const report = buildReport('g', scanTree(tree(game)), mini);
    const ids = (s: keyof typeof report.groups): string[] => report.groups[s].map((m) => m.id).sort();
    expect(ids('loud')).toEqual(['ctx.sql']);
    expect(ids('absent')).toEqual(
      ['act:squash', 'builtin/room-routing', 'config:atmosphere.fog.kind=linear', 'config:inputs.actions.*.gamepad', 'config:routing', 'ctx.self.bones', 'hook:onArrive', 'spec:projection=orthographic'].sort(),
    );
    expect(ids('partial')).toEqual(['config:atmosphere.fog', 'hook:cadence']);
    expect(report.groups.absent.find((m) => m.id === 'ctx.self.bones')).toMatchObject({ plan: 'K3', uses: 1, samples: [{ file: 'sim.js', line: 8 }] });
    expect(report.customEvents.map((c) => c.id)).toEqual(['act:wake']);
    // physics.overlapPoint and ctx.mystery have no entry; `helper` is only a helper export; onWeird looks like a hook
    expect(report.unknown.map((u) => u.id).sort()).toEqual(['builtin/physics.overlapPoint', 'config:gravity.y', 'ctx.mystery', 'hook:onWeird']);
    expect(report.summary.loud).toEqual({ surfaces: 1, uses: 1 });
  });

  it('keeps at most three samples per surface', () => {
    const lines = Array.from({ length: 6 }, (_, i) => `ctx.sql.q${i}();`).join('\n');
    const report = buildReport('g', scanTree(tree({ 'a.js': lines })), mini);
    expect(report.groups.loud[0]).toMatchObject({ id: 'ctx.sql', uses: 6 });
    expect(report.groups.loud[0]?.samples).toHaveLength(3);
  });

  it('counts a custom job module', () => {
    const scan = scanTree(tree({ 'jobs/cpu.js': 'export function run() {}' }));
    expect(scan.usages).toContainEqual({ kind: 'hook', id: 'hook:job-module', file: 'jobs/cpu.js', line: 1 });
  });

  it('records a file that does not parse as a warning and keeps going', () => {
    const scan = scanTree(tree({ 'bad.js': 'export const = ;', 'ok.js': 'ctx.now();' }));
    expect(scan.warnings).toHaveLength(1);
    expect(scan.warnings[0]).toMatch(/^bad\.js: not parsed/);
    expect(scan.usages.some((u) => u.id === 'ctx.now')).toBe(true);
  });
});

describe('the shipped manifest', () => {
  const manifest = loadManifest();

  it('has 150 or more unique, well-formed entries', () => {
    expect(manifest.entries.length).toBeGreaterThanOrEqual(150);
    expect(new Set(manifest.entries.map((e) => e.id)).size).toBe(manifest.entries.length);
    expect(() => parseManifest(JSON.parse(JSON.stringify(manifest)))).not.toThrow();
  });

  it('names the surfaces the plan matrix calls out', () => {
    const idx = new ManifestIndex(manifest);
    const status = (id: string, value?: string): string | undefined => idx.match(id, value)?.status;
    expect(status('ctx.sql.run')).toBe('partial');
    expect(status('ctx.changed')).toBe('loud');
    expect(status('ctx.job')).toBe('partial');
    expect(status('ctx.awaitJob')).toBe('partial');
    for (const id of ['ctx.sql', 'ctx.job', 'ctx.awaitJob']) expect(idx.match(id)?.note).toMatch(/supplied (SqlPort|JobPort)/);
    expect(status('ctx.music.play')).toBe('absent');
    expect(status('ctx.bone')).toBe('partial');
    expect(status('hook:skeleton')).toBe('partial');
    expect(status('hook:migrate')).toBe('partial');
    expect(status('hook:job-module')).toBe('partial');
    expect(status('spec:material.dissolve')).toBe('partial');
    expect(status('spec:pointerLock', 'false')).toBe('implemented');
    expect(status('act:squash')).toBe('absent');
    expect(status('act:flash')).toBe('absent');
    expect(status('act:slash')).toBe('absent');
    expect(status('act:playSound')).toBe('implemented');
    expect(status('hook:cadence', '1s')).toBe('partial');
    expect(status('config:atmosphere.fog.kind', 'linear')).toBe('partial');
    expect(status('spec:projection', 'orthographic')).toBe('partial');
  });

  it('rejects malformed manifests', () => {
    expect(() => parseManifest({ version: 2, entries: [] })).toThrow(/version: 1/);
    expect(() => parseManifest({ version: 1, entries: [{ id: 'ctx.a', kind: 'ctx', status: 'maybe' }] })).toThrow(/bad status/);
    expect(() => parseManifest({ version: 1, entries: [{ id: 'a', kind: 'ctx', status: 'absent' }, { id: 'a', kind: 'ctx', status: 'absent' }] })).toThrow(/duplicate/);
  });
});

describe('the command', () => {
  const dir = (): string => tree({ 'sim.js': 'export const cadence = "1s";\nexport function tick(ctx) { ctx.sql.run(); ctx.music.play(); }' });
  const bin = join(import.meta.dirname, '..', 'src', 'bin.ts');

  it('renders markdown grouped by status with a summary line', () => {
    const { report, text } = runCoverage(dir());
    expect(text).toMatch(/^# Coverage: /);
    expect(text).toContain('## Absent');
    expect(text).toContain('## Loud');
    expect(text).toMatch(/Summary: \d+ implemented, \d+ partial, \d+ absent, \d+ loud, \d+ unknown/);
    expect(text).toContain('| `ctx.sql` | 1 |');
    expect(text).toContain('sim.js:2');
    expect(report.summary.loud.surfaces).toBe(0);
    expect(report.groups.partial.some((surface) => surface.id === 'ctx.sql')).toBe(true);
  });

  it('renders JSON and honours --manifest', () => {
    const d = dir();
    const manifestPath = join(d, 'm.json');
    writeFileSync(manifestPath, JSON.stringify({ version: 1, entries: [{ id: 'ctx.sql', kind: 'ctx', status: 'implemented' }] }));
    const out = JSON.parse(runCoverage(d, { json: true, manifestPath }).text) as { groups: { implemented: Array<{ id: string }> }; manifest: { entries: number } };
    expect(out.manifest.entries).toBe(1);
    expect(out.groups.implemented.map((m) => m.id)).toEqual(['ctx.sql']);
  });

  it('runs from the command line with --json and --out', () => {
    const d = dir();
    const stdout = execFileSync(process.execPath, [bin, 'coverage', d, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    expect((JSON.parse(stdout) as { summary: { loud: { surfaces: number } } }).summary.loud.surfaces).toBe(0);
    const out = join(d, 'report.md');
    execFileSync(process.execPath, [bin, 'coverage', d, '--out', out], { stdio: 'ignore' });
    expect(readFileSync(out, 'utf8')).toMatch(/^# Coverage: /);
  });

  it('keeps --json stdout parseable even when the streams are merged', () => {
    const r = spawnSync(process.execPath, [bin, 'coverage', dir(), '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    const md = spawnSync(process.execPath, [bin, 'coverage', dir()], { encoding: 'utf8' });
    expect(md.stderr).toMatch(/^coverage .*: /);
  });

  it('routes package to the Playgama packager', () => {
    const help = spawnSync(process.execPath, [bin, 'package', '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/spawn-standalone package/);
    const bad = spawnSync(process.execPath, [bin, 'package', dir()], { encoding: 'utf8' });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/--target is required/);
  });

  it('fails with a message for a missing directory or a bad option', () => {
    expect(() => runCoverage(join(tmpdir(), 'ss-cov-does-not-exist'))).toThrow(/not a directory/);
    expect(() => execFileSync(process.execPath, [bin, 'coverage', '--nope'], { stdio: 'ignore' })).toThrow();
  });
});
