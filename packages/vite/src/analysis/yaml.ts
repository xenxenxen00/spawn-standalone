// Copied from purge-protocol-web ebab692 tools/vite/plugin-yaml.ts (plugin renamed ssYaml).
// ssYaml (build §3.3, core §12.6, contract §29): `import CFG from './x.yml'` yields the parsed object.
//
// `.yml` / `.yaml` modules become `export default <literal>` at build time, parsed with js-yaml 5.4.3 in the YAML 1.2 core
// schema with `json: true` (duplicate keys: last wins, as JSON.parse). Parity with the live oracle's `yaml@2.9.1` is a test
// (tests/unit/build/data-parity.node.test.ts). A query (`?raw`, `?url`) is never handled here: Vite serves those itself.
//
// The pure functions are shared with plugin-scene.ts and the Node hook (tools/node/register.ts, WP B4c), which must turn the
// same files into the same modules. This file stays erasable-syntax TS and imports `vite` for types only.
import { CORE_SCHEMA, loadAll } from 'js-yaml';
import type { Plugin } from 'vite';

/** ids this plugin transforms; an id with a query never matches */
export const YAML_ID = /\.ya?ml$/;

/** Parses one YAML data file. Empty or comment-only text gives `null` (as `yaml.parse`); several documents are refused. */
export function parseYaml(text: string, file = '<yaml>'): unknown {
  let docs: unknown[];
  try {
    docs = loadAll(text, { schema: CORE_SCHEMA, json: true, filename: file });
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`, { cause: e });
  }
  if (docs.length > 1) throw new Error(`${file}: ${docs.length} YAML documents; a data module holds exactly one`);
  return docs.length === 0 ? null : docs[0];
}

const isPlainObject = (v: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * A JavaScript expression that evaluates to a fresh copy of `value`. Unlike JSON it keeps `Infinity`/`NaN`/`-0` (`.inf`,
 * `.nan`, `-0.0` are YAML core floats) and spells a `__proto__` key as a computed key, so it stays an own property instead of
 * setting the prototype. Anything YAML core data cannot hold (dates, binaries, functions, undefined) is refused.
 */
export function jsLiteral(value: unknown, path = '$'): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (Number.isNaN(value)) return 'NaN';
      if (value === Infinity) return 'Infinity';
      if (value === -Infinity) return '-Infinity';
      return Object.is(value, -0) ? '-0' : JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v, i) => jsLiteral(v, `${path}[${i}]`)).join(',')}]`;
      if (!isPlainObject(value)) throw new Error(`${path}: ${Object.prototype.toString.call(value)} is not YAML core data`);
      const parts = Object.keys(value).map((k) => {
        const key = k === '__proto__' ? '["__proto__"]' : JSON.stringify(k);
        return `${key}:${jsLiteral((value as Record<string, unknown>)[k], `${path}.${k}`)}`;
      });
      return `{${parts.join(',')}}`;
    }
    default:
      throw new Error(`${path}: ${typeof value} is not YAML core data`);
  }
}

/** ES module source whose default export is `value`. */
export function toModuleSource(value: unknown): string {
  return `export default ${jsLiteral(value)};\n`;
}

/** `.yml`/`.yaml` text → ES module source (the transform of ssYaml and of the Node hook). */
export function yamlModuleSource(text: string, file?: string): string {
  return toModuleSource(parseYaml(text, file));
}

/** Strips a Vite/Rolldown id down to its file path (`\0` prefix, query). */
export const idPath = (id: string): string => id.replace(/^\0/, '').split('?')[0]!;

export function ssYaml(): Plugin {
  return {
    name: 'ss:yaml',
    enforce: 'pre',
    transform: {
      filter: { id: YAML_ID },
      handler(code, id) {
        if (!YAML_ID.test(id)) return null; // hosts without hook filters
        return { code: yamlModuleSource(code, idPath(id)), map: { mappings: '' }, moduleType: 'js' };
      },
    },
  };
}
