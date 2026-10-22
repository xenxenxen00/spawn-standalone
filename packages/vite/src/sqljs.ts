// sql.js's Emscripten glue falls back to `window.prompt("Input: ")` when a program reads stdin and no stdin is set. The SQL port
// never reads stdin, so that branch is never reached, but the call stays in the bundle and a store scan for `prompt(` (the
// Playgama pack check PG-13) flags it. This transform turns the fallback into "no input" (the branch it would take on a cancelled
// prompt). It touches only files under `sql.js/dist/` and only the exact glue shape; an unknown shape is left as it is.
import type { Plugin } from 'vite';

const SQLJS_FILE = /[\/]sql\.js[\/]dist[\/][^\/]+\.js(?:\?.*)?$/;
/** `window.prompt("Input: ")` (any `window`/`globalThis.window` spelling) and the `globalThis.window?.prompt` guard before it */
const PROMPT_CALL = /\b(?:globalThis\.)?window\.prompt\(\s*"Input: "\s*\)/g;
const PROMPT_GUARD = /\b(?:globalThis\.)?window\?\.prompt\b/g;

/** the glue with its stdin prompt fallback made a no-op; null when the code has none */
export function stripSqlJsPrompt(code: string): string | null {
  if (!/\bprompt\b/.test(code)) return null;
  const out = code.replace(PROMPT_CALL, 'null').replace(PROMPT_GUARD, 'void 0');
  return out === code ? null : out;
}

/** Vite plugin: rewrite the sql.js glue's stdin prompt fallback (see the file comment). */
export function ssSqlJs(): Plugin {
  return {
    name: 'ss:sqljs-no-prompt',
    enforce: 'pre',
    transform(code, id) {
      if (!SQLJS_FILE.test(id)) return null;
      const out = stripSqlJsPrompt(code);
      return out === null ? null : { code: out, map: null };
    },
  };
}
