import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build, createServer, loadConfigFromFile, type InlineConfig, type ViteDevServer } from 'vite';
import { playgamaBridge } from '@playgama/bridge/vite';
import { CONFIG_NAMES, loadGameConfig } from './import/config.ts';

export type BuildTarget = 'web' | 'playgama';
export interface BuildOptions {
  target?: BuildTarget;
  out?: string;
  logLevel?: InlineConfig['logLevel'];
}

export async function gameViteConfig(gameDir: string, options: BuildOptions = {}, command: 'build' | 'serve' = 'build'): Promise<InlineConfig> {
  const root = resolve(gameDir);
  const target = options.target ?? 'web';
  if (target !== 'web' && target !== 'playgama') throw new Error(`unknown target: ${String(target)}`);
  if (!existsSync(join(root, 'index.html'))) throw new Error(`build: no index.html in ${root} (run init for a runnable scaffold)`);
  const outDir = resolve(root, options.out ?? 'dist');
  const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(dir + '/');
  const slash = (path: string): string => path.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
  const output = slash(outDir);
  const source = CONFIG_NAMES.some((n) => existsSync(join(root, n))) ? (await loadGameConfig(root)).config.source.dir : null;
  if (inside(slash(root), output) || ['src', 'game'].some((p) => inside(output, slash(join(root, p)))) || (source !== null && (inside(output, slash(source)) || inside(slash(source), output)))) {
    throw new Error(`build: output ${outDir} overlaps the workspace or source files`);
  }
  const configFile = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'].map((n) => join(root, n)).find(existsSync);
  const mode = target === 'playgama' ? 'playgama' : command === 'serve' ? 'development' : 'production';
  const loaded = configFile ? await loadConfigFromFile({ command, mode, isSsrBuild: false, isPreview: false }, configFile, root, 'error', undefined, 'runner') : null;
  const names: string[] = [];
  const walk = async (plugins: unknown): Promise<void> => {
    const p = await plugins;
    if (Array.isArray(p)) for (const x of p) await walk(x);
    else if (p && typeof p === 'object' && 'name' in p) names.push(String(p.name));
  };
  await walk(loaded?.config.plugins);
  return {
    root, configFile: configFile ?? false, configLoader: 'runner', mode, base: './',
    logLevel: options.logLevel ?? (command === 'serve' ? 'info' : 'warn'),
    plugins: target === 'playgama' && !names.includes('playgama-bridge') ? [playgamaBridge({ mode: 'cdn' })] : [],
    build: { outDir, emptyOutDir: true, sourcemap: false },
  };
}

export async function runBuild(gameDir: string, options: BuildOptions = {}): Promise<void> {
  await build(await gameViteConfig(gameDir, options));
}

export async function runDev(gameDir: string, options: BuildOptions = {}): Promise<ViteDevServer> {
  const server = await createServer(await gameViteConfig(gameDir, options, 'serve'));
  await server.listen();
  return server;
}
