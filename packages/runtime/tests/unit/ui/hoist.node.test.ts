// hoist.ts string side (io §3.4 steps 3-4, X-39): the leading <style> split, the #game open tag, and the depth-counting scanner
// that cuts #game's content into its top-level children (tags, void elements, comments, quoted attributes, raw text, foreign
// self-closing); on any parse doubt it gives up (null) and the host falls back to one chunk.
import { describe, expect, it } from 'vitest';
import { parseRender, scanTopLevel, looksLikeSprite } from '../../../src/runtime/ui/hoist.ts';
import { renderString, spriteSvg, icon } from './fakes.ts';

const texts = (html: string): string[] | null => scanTopLevel(html)?.map((c) => html.slice(c.start, c.end)) ?? null;

describe('scanTopLevel', () => {
  it('cuts top-level elements and reads their tag and id', () => {
    const html = `<div id="a" class="x"><span>1</span></div><section><p>t</p></section><img src="/cdn/x.png"/><br>`;
    const chunks = scanTopLevel(html)!;
    expect(chunks.map((c) => [c.tag, c.id])).toEqual([
      ['div', 'a'],
      ['section', null],
      ['img', null],
      ['br', null],
    ]);
    expect(texts(html)).toEqual([`<div id="a" class="x"><span>1</span></div>`, `<section><p>t</p></section>`, `<img src="/cdn/x.png"/>`, `<br>`]);
  });

  it('honours quoted attributes holding > and tag-like text', () => {
    const html = `<div id="q" onclick="ssSelect('a>b')" data-x='<div>'><b>x</b></div><i></i>`;
    expect(texts(html)).toEqual([`<div id="q" onclick="ssSelect('a>b')" data-x='<div>'><b>x</b></div>`, `<i></i>`]);
  });

  it('skips comments and raw text (style, script, textarea)', () => {
    const html = `<!-- <div> --><div id="s"><style>#game .a>b{x:1}</style><textarea></div></textarea></div><p>x</p>`;
    expect(texts(html)).toEqual([`<div id="s"><style>#game .a>b{x:1}</style><textarea></div></textarea></div>`, `<p>x</p>`]);
  });

  it('treats /> as self-closing inside svg (foreign content) and void elements as leaves', () => {
    const html = `${icon('cr')}<div><input type="range" value="3"><svg><path d="M0 0"/><circle r="1"/></svg></div>`;
    expect(texts(html)).toEqual([icon('cr'), `<div><input type="range" value="3"><svg><path d="M0 0"/><circle r="1"/></svg></div>`]);
  });

  it('reads unquoted and single-quoted ids', () => {
    expect(scanTopLevel(`<div id=x1></div><div id='y2'></div><div data-id="no"></div>`)!.map((c) => c.id)).toEqual(['x1', 'y2', null]);
  });

  it('accepts < that does not start a tag as text inside an element', () => {
    expect(texts(`<div>a < b and 1<2</div><b></b>`)).toEqual([`<div>a < b and 1<2</div>`, `<b></b>`]);
  });

  it('gives up on parse doubt: top-level text, mismatched or missing closes, html self-closing, unterminated input', () => {
    expect(scanTopLevel(`text<div></div>`)).toBeNull();
    expect(scanTopLevel(`<div><span></div>`)).toBeNull();
    expect(scanTopLevel(`<div>`)).toBeNull();
    expect(scanTopLevel(`<div/>`)).toBeNull();
    expect(scanTopLevel(`<div class="x`)).toBeNull();
    expect(scanTopLevel(`<ul><li>a<li>b</ul>`)).toBeNull();
  });

  it('ignores whitespace between top-level elements', () => {
    expect(texts(` <a></a>\n <b></b> `)).toEqual([`<a></a>`, `<b></b>`]);
  });
});

describe('parseRender', () => {
  it('splits the leading style, the #game open tag and #game children (the live render shape, main.js:131)', () => {
    const html = renderString({ css: '#game .x{a:b}', cls: 'cb', scale: 1.25, sprite: spriteSvg(['pi-a']), body: `<div id="hud"></div><div class="xhair"><i></i></div>` });
    const p = parseRender(html);
    expect(p.style).toBe('#game .x{a:b}');
    expect(p.ssOpen).toBe(`<div id='game' class="cb" style="--ss-scale:1.25">`);
    expect(p.children!.map((c) => c.key)).toEqual(['svg@0', 'div#hud', 'div@2']);
    expect(p.children![1]!.html).toBe('<div id="hud"></div>');
  });

  it('joins several leading styles and keeps a body without #game as it is', () => {
    const p = parseRender(`<style>a{}</style><style>b{}</style><div style="position:fixed">UI error: x</div>`);
    expect(p.style).toBe('a{}\nb{}');
    expect(p.ssOpen).toBeNull();
    expect(p.children).toBeNull();
    expect(p.body).toBe('<div style="position:fixed">UI error: x</div>');
  });

  it('an empty render (main.js not loaded yet, ui.js:27) has no style and no #game', () => {
    expect(parseRender('')).toMatchObject({ style: null, ssOpen: null, children: null, body: '' });
  });

  it('keeps #game but no children when its content cannot be split', () => {
    const p = parseRender(`<div id='game'>loose text<b></b></div>`);
    expect(p.ssOpen).toBe("<div id='game'>");
    expect(p.children).toBeNull();
    expect(p.inner).toBe('loose text<b></b>');
  });
});

describe('looksLikeSprite', () => {
  it('flags an svg with symbols and leaves icons alone', () => {
    expect(looksLikeSprite(spriteSvg(['pi-a']))).toBe(true);
    expect(looksLikeSprite(icon('a'))).toBe(false);
    expect(looksLikeSprite('<div><symbol></symbol></div>')).toBe(false);
  });
});
