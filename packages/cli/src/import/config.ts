// The per-game config (`<gameDir>/standalone.config.ts` | `.js` | `.json`; plan §6.2). Only what `import` reads is typed
// strictly here; the shell's options (ui, save, platform, boot) ride along and are read by the game's own composition.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RuntimeEdge } from '@spawn-standalone/vite/analysis';

/** the built-in exclusion rules */
export type BuiltInExclusion = 'platform-roots';

export interface PathExclusion {
  path: string;
  reason: string;
}

export interface GameConfig {
  name: string;
  slug: string;
  version?: string;
  /** opt-in: maintain standalone.lock.json and include it in import --check (init enables this) */
  lock?: boolean;
  /** the export's git clone (or a plain folder) and the pinned commit (export-info.json `commit`) */
  source: { dir: string; commit?: string };
  engine?: { semver?: string; docs?: string; docsSha?: string };
  places?: {
    /** 'world.config' (default): the world config's defaultPlace; a list adds those places to the roster */
    roster?: 'world.config' | string[];
    /** place ids that are not roots */
    exclude?: string[];
    /** the behaviour path of portal rows (`state.to` names the target place); default none */
    portalBehavior?: string | null;
  };
  roots?: {
    /** extra root files (tree paths) */
    extra?: string[];
    /** paths the game builds at run time: followed when `from` is reached */
    runtimeEdges?: RuntimeEdge[];
    /** opt-in: the `jobs:` modules and every `jobs/<id>.js` are roots (carried with what they import); default false */
    jobs?: boolean;
  };
  exclude?: {
    /** default ['platform-roots']: drops ui/nametag.js and routing.js (Spawn platform-only roots) */
    builtIn?: BuiltInExclusion[];
    paths?: (string | PathExclusion)[];
    /** dangling edges that are known and accepted after the edits */
    knownDangling?: { from: string; target: string; why: string }[];
  };
  edits?: { dir?: string; order?: string };
  /**
   * Job modules (`ctx.job`): job id to a tree path. With `roots.jobs: true` each file is a reach root with what it imports, and
   * so is every `jobs/<id>.js` the source has. The Vite plugin's `ssJobs({ jobs })` reads the same key.
   */
  jobs?: Record<string, string>;
  /** a JSON file of port flags (relative to the game dir); default 'flags.json' when it exists */
  flags?: string;
  preload?: {
    /** RegExp source of the `actors` set's entry templates; default none */
    actorEntry?: string;
  };
  /** `node --check` every edited JS file (default true) */
  syntaxCheck?: boolean;
  [extra: string]: unknown;
}

/** identity, for a typed `standalone.config.ts` */
export function defineGame(config: GameConfig): GameConfig {
  return config;
}

export const CONFIG_NAMES = ['standalone.config.ts', 'standalone.config.js', 'standalone.config.json'] as const;

export function findConfigFile(gameDir: string): string {
  for (const n of CONFIG_NAMES) {
    const f = join(gameDir, n);
    if (existsSync(f)) return f;
  }
  throw new Error(`no ${CONFIG_NAMES.join(' | ')} in ${gameDir}`);
}

function check(c: unknown, file: string): GameConfig {
  if (typeof c !== 'object' || c === null) throw new Error(`${file}: the config is not an object`);
  const g = c as Partial<GameConfig>;
  if (typeof g.name !== 'string' || g.name === '') throw new Error(`${file}: "name" is missing`);
  if (typeof g.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(g.slug)) throw new Error(`${file}: "slug" must be lowercase kebab-case`);
  if (typeof g.source !== 'object' || g.source === null || typeof g.source.dir !== 'string') throw new Error(`${file}: "source.dir" is missing`);
  return g as GameConfig;
}

/** Reads the game's config. A relative `source.dir` is resolved against the game dir. */
export async function loadGameConfig(gameDir: string): Promise<{ config: GameConfig; file: string }> {
  const file = findConfigFile(gameDir);
  let raw: unknown;
  if (file.endsWith('.json')) raw = JSON.parse(readFileSync(file, 'utf8'));
  else {
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    raw = mod.default;
  }
  const config = check(raw, file);
  const dir = isAbsolute(config.source.dir) ? config.source.dir : resolve(gameDir, config.source.dir);
  return { config: { ...config, source: { ...config.source, dir: dir.replaceAll('\\', '/') } }, file };
}
