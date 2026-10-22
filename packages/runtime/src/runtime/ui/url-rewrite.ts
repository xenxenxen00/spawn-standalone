// H02: `/cdn/<name>` in the render string → the bundled relative URL (io §3.4 step 5; build §5.9). The live render names its
// media by Spawn CDN path: the menu video (scripts/ui/main.js:28), the death splat (death.js:5), the operator webps
// (loadout.js:151) and the weapon renders (weapon-art.js:457); none is edited. The rewrite itself is B8's `rewriteCdnInText`
// (src/assets/resolver.ts): `src=`, `poster=`, `url(...)` and quoted `cdn/…`, a 256-entry LRU keyed by the text, an unknown or
// silent name → a transparent data URI plus the resolver's `onMissing` hook (set at install, the per-name dev log). The UI host
// calls it per changed top-level child, so the memo key is the child substring.
import { rewriteCdnInText } from '../../assets/resolver.ts';

export type TextRewriter = (text: string) => string;

/** the page rewriter: the installed asset index (installAssetIndex, X1) */
export const cdnRewriter: TextRewriter = (text) => rewriteCdnInText(text);

/** `/cdn/` URLs in an HTML or CSS fragment → shipped URLs; text without `cdn/` is returned as is (no index lookup) */
export function rewriteCdnUrls(html: string, rewrite: TextRewriter = cdnRewriter): string {
  return html.includes('cdn/') ? rewrite(html) : html;
}

/** an `onMissing` hook for installAssetIndex: one dev log line per name (io §3.4 step 5) */
export function logMissingCdn(log: (msg: string) => void = (m) => console.warn(m)): (name: string) => void {
  return (name) => log(`ui: no shipped file for /cdn/${name}; drawn as an empty image`);
}
