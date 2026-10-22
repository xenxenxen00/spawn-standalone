// Copied from purge-protocol-web ebab692 tools/vite/plugin-scene.ts (plugin renamed ssScene).
// ssScene (build §3.3, core §11.2, contract §3.7): a place cell `places/<p>/cells/<key>.scene` becomes
// `export default { header, rows }`.
//
// Format: first line `# spawn-scene v2 yaml <cellKey>` (the key is the file's base name: x<cx>z<cz>, `objects`, or a
// non-standard name such as frostline-relay's `dress`), then one YAML mapping per row keyed by id. Rows keep file order (an
// array, so an integer-like id cannot be reordered the way object keys are) and carry their id; `spec` is the row as authored
// (template merge, filtering and validation happen in tools/places/compile.ts and at runtime). A row that repeats `id:` must
// repeat its own key. `?raw` is Vite's (the 11 power-grid places ship raw cell text for ctx.files.read, core §12.5).
import { CORE_SCHEMA, load, realMapTag } from 'js-yaml';
import type { Plugin } from 'vite';
import { idPath, parseYaml, toModuleSource } from './yaml.ts';

export const SCENE_ID = /\.scene$/;

export interface SceneHeader {
  version: 2;
  format: 'yaml';
  cellKey: string;
}
export interface SceneRow {
  id: string;
  spec: Record<string, unknown>;
}
export interface SceneModule {
  header: SceneHeader;
  rows: SceneRow[];
}

const HEADER = /^# spawn-scene v2 yaml (\S+)[ \t]*\r?$/;
/** keys a JS object would enumerate first, ahead of insertion order */
const ARRAY_INDEX = /^(0|[1-9]\d{0,9})$/;

const baseName = (file: string): string => (file.split('/').pop() ?? file).replace(SCENE_ID, '');

/** Top-level keys in source order (only needed when an integer-like key would be reordered by a plain object). */
function sourceKeyOrder(text: string, file: string): string[] {
  const doc = load(text, { schema: CORE_SCHEMA.withTags(realMapTag), json: true, filename: file });
  return doc instanceof Map ? [...doc.keys()].map(String) : [];
}

export function parseScene(text: string, file = '<scene>'): SceneModule {
  const first = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
  const m = HEADER.exec(first);
  if (!m) throw new Error(`${file}: missing scene header "# spawn-scene v2 yaml <cellKey>" (found ${JSON.stringify(first.slice(0, 60))})`);
  const cellKey = m[1]!;
  if (file !== '<scene>' && cellKey !== baseName(file)) {
    throw new Error(`${file}: header cell key "${cellKey}" does not match the file name "${baseName(file)}"`);
  }
  const doc = parseYaml(text, file);
  if (doc !== null && (typeof doc !== 'object' || Array.isArray(doc))) {
    throw new Error(`${file}: a scene is a mapping of rows keyed by id`);
  }
  const byId = (doc ?? {}) as Record<string, unknown>;
  let ids = Object.keys(byId);
  if (ids.some((k) => ARRAY_INDEX.test(k))) ids = sourceKeyOrder(text, file);
  const rows = ids.map((id): SceneRow => {
    const spec = byId[id];
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error(`${file}: row "${id}" is not a mapping`);
    }
    const own = (spec as Record<string, unknown>)['id'];
    if (own !== undefined && own !== id) throw new Error(`${file}: row "${id}" repeats a different id "${String(own)}"`);
    return { id, spec: spec as Record<string, unknown> };
  });
  return { header: { version: 2, format: 'yaml', cellKey }, rows };
}

/** `.scene` text → ES module source (the transform of ssScene and of the Node hook). */
export function sceneModuleSource(text: string, file?: string): string {
  return toModuleSource(parseScene(text, file));
}

export function ssScene(): Plugin {
  return {
    name: 'ss:scene',
    enforce: 'pre',
    transform: {
      filter: { id: SCENE_ID },
      handler(code, id) {
        if (!SCENE_ID.test(id)) return null;
        return { code: sceneModuleSource(code, idPath(id)), map: { mappings: '' }, moduleType: 'js' };
      },
    },
  };
}
