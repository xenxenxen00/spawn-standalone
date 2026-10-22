#!/usr/bin/env node
// spawn-standalone <command>: Node 24 runs the shipped TypeScript directly.
//   coverage [<source-or-game-dir>] [--check] [--json] [--manifest <path>] [--out <file>]
//   init <export-dir> --name <slug> [--out <game-dir>]
//   import [<game-dir>] [--check]
//   assets build|verify [<game-dir>] [--export <dir>] [--out <file>]
//   build|dev [<game-dir>] [--target web|playgama] [--out <dir>]
//   package [<game-dir>] --target playgama [--out <dir>] [--no-covers] [--json]
import { writeFileSync } from 'node:fs';
import { runCoverage } from './coverage/command.ts';
import { summaryLine } from './coverage/report.ts';
import { runImport, runInit, summary } from './import/command.ts';
import { assetsSummary, runAssetsBuild } from './assets/build.ts';
import { runPackage } from './package/index.ts';
import { runBuild, runDev, type BuildTarget } from './build.ts';
import { runAssetsVerify } from './assets/check.ts';
import { CONFIG_NAMES, loadGameConfig } from './import/config.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const USAGE = [
  'usage: spawn-standalone coverage [<source-or-game-dir>] [--check] [--json] [--manifest <path>] [--out <file>]',
  '       spawn-standalone init <export-dir> --name <slug> [--out <game-dir>]',
  '       spawn-standalone import [<game-dir>] [--check]',
  '       spawn-standalone assets build|verify [<game-dir>] [--export <dir>] [--out <file>]',
  '       spawn-standalone build|dev [<game-dir>] [--target web|playgama] [--out <dir>]',
  '       spawn-standalone package [<game-dir>] --target playgama [--out <dir>] [--no-covers] [--json]',
].join('\n');

async function importCommand(rest: string[]): Promise<number> {
  let dir: string | undefined;
  let check = false;
  for (const a of rest) {
    if (a === '--check') check = true;
    else if (a.startsWith('--')) {
      console.error(`unknown option: ${a}\n${USAGE}`);
      return 2;
    } else if (dir === undefined) dir = a;
    else {
      console.error(`unexpected argument: ${a}\n${USAGE}`);
      return 2;
    }
  }
  try {
    const o = await runImport(dir ?? process.cwd(), { check });
    console.error(summary(o));
    return o.ok ? 0 : 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

function initCommand(rest: string[]): number {
  let dir: string | undefined;
  let name: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--name' || a === '--out') {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) {
        console.error(`${a} needs a value\n${USAGE}`);
        return 2;
      }
      if (a === '--name') name = v;
      else out = v;
    } else if (a.startsWith('--')) {
      console.error(`unknown option: ${a}\n${USAGE}`);
      return 2;
    } else if (dir === undefined) dir = a;
    else {
      console.error(`unexpected argument: ${a}\n${USAGE}`);
      return 2;
    }
  }
  if (dir === undefined || name === undefined) {
    console.error(USAGE);
    return 2;
  }
  try {
    const r = runInit(dir, { name, ...(out !== undefined ? { out } : {}) });
    console.error(`init: ${r.dir} (${r.files.join(', ')})`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function assetsCommand(rest: string[]): Promise<number> {
  const [sub, ...args] = rest;
  if (sub !== 'build' && sub !== 'verify') {
    console.error(USAGE);
    return 2;
  }
  let dir: string | undefined;
  const o: { exportDir?: string; out?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--export' || a === '--out') {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) {
        console.error(`${a} needs a value\n${USAGE}`);
        return 2;
      }
      if (a === '--export') o.exportDir = v;
      else o.out = v;
    } else if (a.startsWith('--')) {
      console.error(`unknown option: ${a}\n${USAGE}`);
      return 2;
    } else if (dir === undefined) dir = a;
    else {
      console.error(`unexpected argument: ${a}\n${USAGE}`);
      return 2;
    }
  }
  try {
    if (sub === 'verify') {
      const r = await runAssetsVerify(dir ?? process.cwd(), o);
      console.error(`assets verify: ${r.ok ? 'pass' : 'fail'}${r.problems.length ? '\n  ' + r.problems.join('\n  ') : ''}`);
      return r.ok ? 0 : 1;
    }
    console.error(assetsSummary(await runAssetsBuild(dir ?? process.cwd(), o)));
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function buildCommand(command: 'build' | 'dev', argv: string[]): Promise<number> {
  let dir: string | undefined;
  let target: BuildTarget = 'web';
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--target' || a === '--out') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) { console.error(`${a} needs a value\n${USAGE}`); return 2; }
      if (a === '--target') {
        if (v !== 'web' && v !== 'playgama') { console.error(`unknown target: ${v}`); return 2; }
        target = v;
      } else out = v;
    } else if (a.startsWith('--') || dir !== undefined) { console.error(`unexpected argument: ${a}\n${USAGE}`); return 2; }
    else dir = a;
  }
  try {
    const options = { target, ...(out ? { out } : {}) };
    if (command === 'build') await runBuild(dir ?? process.cwd(), options);
    else (await runDev(dir ?? process.cwd(), options)).printUrls();
    return 0;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command === 'import') return importCommand(rest);
  if (command === 'init') return initCommand(rest);
  if (command === 'assets') return assetsCommand(rest);
  if (command === 'package') return runPackage(rest);
  if (command === 'build' || command === 'dev') return buildCommand(command, rest);
  if (command !== 'coverage') {
    console.error(`unknown command: ${command}\n${USAGE}`);
    return 2;
  }
  let dir: string | undefined;
  let json = false;
  let check = false;
  let manifestPath: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--json') json = true;
    else if (a === '--check') check = true;
    else if (a === '--manifest' || a === '--out') {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) {
        console.error(`${a} needs a value\n${USAGE}`);
        return 2;
      }
      if (a === '--manifest') manifestPath = v;
      else out = v;
    } else if (a.startsWith('--')) {
      console.error(`unknown option: ${a}\n${USAGE}`);
      return 2;
    } else if (dir === undefined) dir = a;
    else {
      console.error(`unexpected argument: ${a}\n${USAGE}`);
      return 2;
    }
  }
  try {
    dir ??= process.cwd();
    let drift = false;
    if (CONFIG_NAMES.some((n) => existsSync(join(dir!, n)))) {
      const { config } = await loadGameConfig(dir);
      if (check && (config.lock === true || existsSync(join(dir, 'standalone.lock.json')))) {
        const imported = await runImport(dir, { check: true });
        drift = !imported.ok;
        if (drift) console.error(summary(imported));
      }
      dir = existsSync(join(dir, 'game/world.config.yaml')) ? join(dir, 'game') : config.source.dir;
    }
    const { report, text } = runCoverage(dir, { json, ...(manifestPath !== undefined ? { manifestPath } : {}) });
    if (out !== undefined) {
      writeFileSync(out, text);
      console.error(`wrote ${out}`);
    } else process.stdout.write(text);
    // with --json on stdout the line stays out of the way: a caller that merges the streams still gets parseable JSON
    if (!(json && out === undefined)) console.error(`coverage ${report.source}: ${summaryLine(report)}`);
    return check && (drift || report.summary.absent.surfaces + report.summary.loud.surfaces + report.summary.unknown.surfaces > 0 || report.warnings.length > 0) ? 1 : 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
