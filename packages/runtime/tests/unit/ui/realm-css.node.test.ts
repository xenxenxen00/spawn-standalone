// realm.css (M5 ui-pixels): the live realm's base rules (tome-ui-styles + the Tailwind v3.4.14 preflight of tome-ui-cooked,
// docs/reference/original/ui-welcome-1.html) carried for the game UI only. Every selector is scoped to #tome-ui-container, so
// nothing reaches the port chrome, the blood lens or the canvas, and the preflight keeps its live specificity (`:where()`).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../../src/runtime/ui/css/realm.css', import.meta.url), 'utf8').replaceAll('\r\n', '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const host = readFileSync(new URL('../../../src/runtime/ui/ui-host.ts', import.meta.url), 'utf8');

/** a selector list split on its top-level commas (not those inside `:where(…)`) */
const splitList = (list: string): string[] => {
  const out: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(list.slice(from, i));
      from = i + 1;
    }
  }
  out.push(list.slice(from));
  return out.map((s) => s.trim());
};
/** the selectors of every rule (the file has no at-rules) */
const selectors = (text: string): string[] => [...text.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => splitList(m[1]!)).filter((s) => s !== '');

const SCOPED = /^(?::where\(#tome-ui-container\) |#tome-ui-container(?: |$))/;
const body = (sel: string): string => {
  const at = css.indexOf(`${sel} {`);
  expect(at, sel).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
};

describe('realm.css: the live realm base rules, scoped to the game UI container', () => {
  it('is imported by the UI host, before the port chrome styles', () => {
    expect(host.indexOf("import './css/realm.css';")).toBeGreaterThan(host.indexOf("import './css/root-vars.css';"));
    expect(host.indexOf("import './css/realm.css';")).toBeLessThan(host.indexOf("import './css/chrome.css';"));
  });

  it('every selector is scoped to #tome-ui-container (no at-rule, no global rule)', () => {
    expect(css).not.toMatch(/@/);
    const sels = selectors(css);
    expect(sels.length).toBeGreaterThan(60);
    expect(sels.filter((s) => !SCOPED.test(s))).toEqual([]);
  });

  it('negative control: the scope check catches an unscoped rule and a look-alike id', () => {
    expect(selectors('button { margin: 0; } #tome-ui-containerx a { color: red; } :where(#tome-ui-container) p { margin: 0; }').filter((s) => !SCOPED.test(s))).toEqual(['button', '#tome-ui-containerx a']);
  });

  it('carries the live form-control reset the game layout depends on (font, line-height, letter-spacing inherit; no margin or padding)', () => {
    const b = body(':where(#tome-ui-container) button,\n:where(#tome-ui-container) input,\n:where(#tome-ui-container) optgroup,\n:where(#tome-ui-container) select,\n:where(#tome-ui-container) textarea');
    for (const decl of ['font-family: inherit', 'font-size: 100%', 'font-weight: inherit', 'line-height: inherit', 'letter-spacing: inherit', 'color: inherit', 'margin: 0', 'padding: 0']) expect(b).toContain(decl);
  });

  it('carries the container font and line-height, border-box, block replaced elements and the modal-sibling dimming', () => {
    const c = body('#tome-ui-container');
    expect(c).toContain("font-family: 'Geist', system-ui, sans-serif");
    expect(c).toContain('line-height: 1.5');
    expect(css).toMatch(/box-sizing: border-box;\s*border-width: 0;\s*border-style: solid;/);
    expect(css).toMatch(/:where\(#tome-ui-container\) img,[^{]*\{\s*display: block;\s*vertical-align: middle;/);
    expect(body('#tome-ui-container *:has(> [data-modal]) > :not([data-modal])')).toContain('opacity: 0.25');
  });
});
