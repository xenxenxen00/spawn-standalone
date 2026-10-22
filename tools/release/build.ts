import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const packageNames = ['runtime', 'vite', 'cli', 'testing'] as const;
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);

/** Runtime modules and worker URLs need emitted extensions; declaration-file imports keep their names. */
export function rewriteModulePaths(source: string, declaration = false): string {
  const code = source.replace(/(['"])(\.{1,2}\/[^'"\r\n]+)\.ts(?=\1)/g,
    (match, quote: string, path: string) => path.endsWith('.d') ? match : quote + path + '.js')
    .replace(/(['"])builtin\//g, '$1@spawn-standalone/runtime/builtin/');
  // Stylesheets have runtime side effects but supply no declaration types.
  return declaration ? code.replace(/^[ \t]*import[ \t]+(['"])[^'"\r\n]+\.css(?:\?[^'"\r\n]*)?\1;?[ \t]*(?:\r?\n|$)/gm, '') : code;
}

/** Build each installed package boundary; no test corpus, checkout paths or source maps ship. */
export function buildPackages(): void {
  for (const name of packageNames) {
    const root = join(repository, 'packages', name);
    const out = join(root, 'dist');
    assert.equal(dirname(out), root);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out);
    const inputs = ['src', ...(name === 'runtime' ? ['capabilities'] : [])].flatMap((p) => files(join(root, p))).filter((p) => !/(?:[\\/](?:legacy)[\\/]|[\\/]platform[\\/]save-schema\.ts$|[\\/]src[\\/]types[\\/]virtual\.d\.ts$)/.test(p));
    const config = join(out, 'tsconfig.build.json');
    writeFileSync(config, JSON.stringify({ compilerOptions: {
      target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', rootDir: root, outDir: out,
      declaration: true, removeComments: true, noCheck: true, skipLibCheck: true, rewriteRelativeImportExtensions: true,
      resolveJsonModule: true, types: ['node', 'vite/client'],
    }, files: inputs.filter((p) => p.endsWith('.ts')) }));
    const result = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.resolve('typescript/package.json'))), 'bin/tsc'), '-p', config], { cwd: repository, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
    rmSync(config);
    for (const input of inputs) {
      if (input.endsWith('.ts') && !input.endsWith('.d.ts')) continue;
      if (input.endsWith('.md')) continue;
      const target = join(out, relative(root, input)); mkdirSync(dirname(target), { recursive: true }); copyFileSync(input, target);
    }
    for (const excluded of ['src/compat/legacy', 'src/runtime/legacy', 'src/platform/save-schema.js', 'src/platform/save-schema.d.ts']) {
      const target = resolve(out, excluded); assert.ok(target.startsWith(out + sep));
      rmSync(target, { recursive: true, force: true });
    }
    for (const emitted of files(out).filter((p) => /\.(js|ts)$/.test(p))) {
      const original = readFileSync(emitted, 'utf8');
      // TypeScript rewrites imports, while Vite's new URL worker entries also need emitted extensions.
      const code = rewriteModulePaths(original, emitted.endsWith('.d.ts'));
      if (code !== original) writeFileSync(emitted, code);
    }
    for (const legal of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
      const input = join(repository, legal);
      if (existsSync(input)) copyFileSync(input, join(root, legal));
    }
    console.log(`built @spawn-standalone/${name}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildPackages();
