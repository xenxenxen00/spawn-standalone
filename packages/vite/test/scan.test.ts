import { describe, expect, it } from 'vitest';
import { scanJs } from '../src/analysis/index.ts';

const values = (src: string): string[] => scanJs(src).strings.map((s) => s.value);

describe('scanJs template expressions', () => {
  it('a division inside ${} is not a regex', () => {
    const src = 'const a = `<span>${i / 2 + 1}.</span>${"x"}`; const p = "scripts/after.js";';
    expect(values(src)).toContain('scripts/after.js');
    expect(values(src)).toContain('x');
  });

  it('a regex literal with a quote inside ${} does not swallow the rest of the file', () => {
    const src = 'const o = `<b onclick="f(${JSON.stringify(v).replace(/"/g, "&quot;")})">`;\nconst p = "scripts/after.js";\nimport q from "./next.js";';
    const s = scanJs(src);
    expect(s.strings.map((x) => x.value)).toContain('scripts/after.js');
    expect(s.imports.map((x) => x.spec)).toEqual(['./next.js']);
  });

  it('regex classes, braces and comments inside ${} are skipped', () => {
    const src = 'const o = `${a.replace(/[`"}]/g, "")}${/* a } " */ b}${c // }\n}`; const p = "scripts/after.js";';
    expect(values(src)).toContain('scripts/after.js');
  });

  it('line numbers stay right across a multi-line expression', () => {
    const src = 'const o = `${x\n/ 2\n}`;\nconst p = "scripts/after.js";';
    expect(scanJs(src).strings.find((s) => s.value === 'scripts/after.js')!.line).toBe(4);
  });
});
