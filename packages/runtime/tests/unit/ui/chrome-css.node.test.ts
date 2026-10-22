// chrome.css (io §3.9 row 3, §3.10, §3.8; WP UI2a): the resume prompt is a 35 % dim over the whole viewport that takes the
// click, set in Geist (the port's chrome font), hidden by the `hidden` attribute, with no external URL.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../../src/runtime/ui/css/chrome.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ');

describe('chrome.css: the resume prompt', () => {
  const rule = /\.pc-resume \{([^}]*)\}/.exec(css)?.[1] ?? '';

  it('covers the viewport on the chrome layer with a 35 % dim', () => {
    expect(rule).toMatch(/position: fixed;/);
    expect(rule).toMatch(/inset: 0;/);
    expect(rule).toMatch(/z-index: 20;/);
    expect(rule).toMatch(/background: rgba\(0, 0, 0, 0\.35\);/);
  });

  it('takes the click (the layers around it are pointer-events:none)', () => {
    expect(rule).toMatch(/pointer-events: auto;/);
    expect(rule).toMatch(/cursor: pointer;/);
  });

  it('uses an overridable system font without bundled game assets', () => {
    expect(rule).toContain('font-family: var(--ss-font, system-ui, sans-serif)');
    expect(css).not.toContain('cdn/');
  });

  it('stays hidden by the hidden attribute although the rule sets display', () => {
    expect(rule).toMatch(/display: flex;/);
    expect(css).toMatch(/\.pc-resume\[hidden\] \{ display: none; \}/);
  });

  it('names no URL at all (local fonts only, no external request)', () => {
    expect(css).not.toMatch(/https?:|url\(|@import/);
  });
});

describe('chrome.css: the UI2b layer (io §3.2, §3.10, §5.5)', () => {
  const ruleOf = (selector: string): string => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\} )${esc} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  };

  it('#port-chrome is a fixed full-viewport layer at z-index 20 that takes no input itself', () => {
    const rule = ruleOf('#port-chrome');
    expect(rule).toMatch(/position: fixed;/);
    expect(rule).toMatch(/inset: 0;/);
    expect(rule).toMatch(/z-index: 20;/);
    expect(rule).toMatch(/pointer-events: none;/);
    expect(rule).toContain('font-family: var(--ss-font, system-ui, sans-serif)');
  });

  it('the hidden attribute wins over every display the layer sets', () => {
    expect(css).toMatch(/#port-chrome \[hidden\] \{ display: none !important; \}/);
  });

  it('the rail sits in the Spawn rail band (right 0, top 180 px, 50 x 360 px, re-centred on short screens) and takes clicks', () => {
    const rule = ruleOf('#port-chrome .ss-rail');
    expect(rule).toMatch(/right: 0;/);
    expect(rule).toMatch(/top: max\(8px, calc\(50vh - 180px\)\);/);
    expect(rule).toMatch(/width: 50px;/);
    expect(rule).toMatch(/height: min\(360px, calc\(100vh - 16px\)\);/);
    expect(rule).toMatch(/pointer-events: auto;/);
    // the icons have a size (an unsized inline svg would fill the button's width)
    expect(ruleOf('#port-chrome .ss-rail-btn svg')).toMatch(/width: 22px;/);
    expect(css).toMatch(/#port-chrome \.ss-rail-mute\.is-muted::after \{/);
  });

  it('the pause overlay covers the viewport above the toast and takes clicks; the flash and damage layers do not', () => {
    const pause = ruleOf('#port-chrome .ss-pause');
    expect(pause).toMatch(/inset: 0;/);
    expect(pause).toMatch(/z-index: 40;/);
    expect(pause).toMatch(/pointer-events: auto;/);
    expect(ruleOf('#port-chrome .ss-toast')).toMatch(/z-index: 30;/);
    const flash = ruleOf('#port-chrome .ss-flash');
    expect(flash).toMatch(/inset: 0;/);
    expect(flash).toMatch(/pointer-events: none;/);
    expect(ruleOf('#port-chrome .ss-damage-layer')).toMatch(/pointer-events: none;/);
    expect(ruleOf('#port-chrome .ss-damage')).toMatch(/animation: ss-damage-rise var\(--ss-dmg-life, 900ms\)/);
  });
});
