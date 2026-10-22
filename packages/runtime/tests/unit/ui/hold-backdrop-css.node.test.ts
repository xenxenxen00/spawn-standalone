// hold-backdrop.css (docs/architecture.md §5.3; io §3.8; WP X2): the gate's progress bar sits on the bottom edge of the stage,
// and the sheet is set in the bundled fonts with no external URL.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('hold-backdrop.css', () => {
  const css = readFileSync(new URL('../../../src/runtime/ui/css/hold-backdrop.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');
  const rule = (sel: string): string => new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';

  it('puts the bar on the bottom edge of the stage, 3 px thin', () => {
    expect(rule('.ss-hold-bar')).toMatch(/position: absolute;/);
    expect(rule('.ss-hold-bar')).toMatch(/height: 3px;/);
    expect(rule('.ss-hold-bar')).toMatch(/var\(--ss-stage-y, 0px\) \+ var\(--ss-stage-h, 100%\)/);
    expect(rule('.ss-hold-bar')).toMatch(/left: var\(--ss-stage-x, 0px\);/);
    expect(rule('.ss-hold-bar')).toMatch(/width: var\(--ss-stage-w, 100%\);/);
  });

  it('is set in the bundled fonts and requests nothing from outside', () => {
    expect(rule('.ss-hold-error')).toContain('font-family: var(--ss-font, system-ui, sans-serif)');
    expect(css).not.toMatch(/url\(/);
    expect(css).not.toMatch(/https?:/);
  });
});
