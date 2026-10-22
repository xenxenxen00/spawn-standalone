// Render-string surgery for the UI host (io §3.4 steps 3-4; X-39).
//
// The live render returns `<style>…</style><div id='game' …>${curtain}${sprite(weapons)}${body}</div>` (scripts/ui/main.js:131):
// ~66 KB of CSS, then a hidden zero-size `<svg>` whose one `<defs>` holds the shared gradients and every `<symbol>` (51 icons,
// plus 135 KB of weapon drawings on the shop and loadout; scripts/ui/icons.js:10-16), then the screen. This module
//   - splits off the leading `<style>` text and the `#game` open tag (`parseRender`),
//   - cuts `#game`'s content into its top-level children with a small depth-counting scanner (`scanTopLevel`: tags, void
//     elements, comments, quoted attributes, raw-text elements, `/>` only inside svg/math; on any parse doubt it returns null
//     and the caller falls back to one chunk),
//   - hoists the style into the page-level `<style id="ss-style">` and every sprite `<svg>` into the hidden
//     `<svg id="ss-sprites">` (`Hoister`): symbols and gradients merged by id, so `<use href="#pi-…">` / `#pw-…` and
//     `fill="url(#…)"` resolve document-wide, and the weapon symbols stay once added (the shop no longer re-sends them).
// The structural normaliser of build §8.6 (tools/ui-ref/dom-normalize.ts) hoists the same nodes on the origin side: the declared
// UI structural-diff delta `ui-sprite-hoist`.

/** one top-level element of a fragment: `[start, end)` offsets, lower-case tag, its `id` attribute when it has one */
export interface Chunk {
  readonly start: number;
  readonly end: number;
  readonly tag: string;
  readonly id: string | null;
}

/** a top-level child of `#game`: its key (`tag#id`, or `tag@position` without an id) and its markup */
export interface ChildPart {
  readonly key: string;
  readonly tag: string;
  readonly html: string;
}

export interface RenderParts {
  /** the text of the leading `<style>` elements (joined by a newline), null when the render starts with none */
  readonly style: string | null;
  /** everything after the leading styles */
  readonly body: string;
  /** the `<div id='game' …>` open tag when `body` is exactly that one element, else null */
  readonly ssOpen: string | null;
  /** `#game`'s content ('' when there is no #game) */
  readonly inner: string;
  /** `#game`'s top-level children, null when there is no #game or its content cannot be split */
  readonly children: readonly ChildPart[] | null;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noembed', 'noframes', 'iframe', 'noscript', 'plaintext']);
const FOREIGN = new Set(['svg', 'math']);

const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
const isAlpha = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameChar = (c: number): boolean => isAlpha(c) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95 || c === 46;

interface Tag {
  /** offset just past the closing `>` */
  end: number;
  name: string;
  selfClosing: boolean;
  /** the attribute text is `[attrsStart, attrsEnd)` (unparsed; sliced only where the id is needed) */
  attrsStart: number;
  attrsEnd: number;
}

/** reads a start tag at `i` (s[i] === '<', s[i+1] a letter); null when it does not end */
function readStartTag(s: string, i: number, to: number): Tag | null {
  let j = i + 1;
  while (j < to && isNameChar(s.charCodeAt(j))) j++;
  const name = s.slice(i + 1, j).toLowerCase();
  const attrsStart = j;
  while (j < to) {
    const c = s.charCodeAt(j);
    if (c === 34 || c === 39) {
      const close = s.indexOf(c === 34 ? '"' : "'", j + 1);
      if (close === -1 || close >= to) return null;
      j = close + 1;
      continue;
    }
    if (c === 62) {
      const selfClosing = s.charCodeAt(j - 1) === 47;
      return { end: j + 1, name, selfClosing, attrsStart, attrsEnd: selfClosing ? j - 1 : j };
    }
    j++;
  }
  return null;
}

/** the offset of `</name` (any case) at or after `from`, or -1 */
function findClose(s: string, name: string, from: number, to: number): number {
  let k = from;
  for (;;) {
    k = s.indexOf('</', k);
    if (k === -1 || k >= to) return -1;
    if (s.slice(k + 2, k + 2 + name.length).toLowerCase() === name) return k;
    k += 2;
  }
}

const ID_ATTR = /(?:^|[\s"'])id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

function idOf(attrs: string): string | null {
  const m = ID_ATTR.exec(attrs);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/**
 * The top-level elements of `s[from, to)`. Null on parse doubt: non-whitespace text at the top level, a close tag that does not
 * match the open element (the HTML parser would auto-close or repair it), `/>` on a non-void HTML element, raw text or a
 * comment or tag that does not end, an element still open at the end.
 */
export function scanTopLevel(s: string, from = 0, to = s.length): Chunk[] | null {
  const out: Chunk[] = [];
  const stack: string[] = [];
  let foreign = 0; // depth of svg/math ancestors on the stack
  let chunkStart = -1;
  let chunkTag = '';
  let chunkId: string | null = null;
  let i = from;
  while (i < to) {
    const c = s.charCodeAt(i);
    if (c !== 60) {
      // text: jump to the next '<' (at the top level only whitespace may stand between elements)
      const lt = s.indexOf('<', i);
      const stop = lt === -1 || lt > to ? to : lt;
      if (stack.length === 0) for (let k = i; k < stop; k++) if (!isSpace(s.charCodeAt(k))) return null;
      i = stop;
      continue;
    }
    // '<'
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      if (end === -1 || end + 3 > to) return null;
      i = end + 3;
      continue;
    }
    const n = s.charCodeAt(i + 1);
    if (n === 47) {
      // '</'
      if (!isAlpha(s.charCodeAt(i + 2))) {
        if (stack.length === 0) return null;
        i++;
        continue;
      }
      let j = i + 2;
      while (j < to && isNameChar(s.charCodeAt(j))) j++;
      const name = s.slice(i + 2, j).toLowerCase();
      const gt = s.indexOf('>', j);
      if (gt === -1 || gt >= to) return null;
      const open = stack.pop();
      if (open !== name) return null;
      if (FOREIGN.has(name)) foreign--;
      i = gt + 1;
      if (stack.length === 0) {
        out.push({ start: chunkStart, end: i, tag: chunkTag, id: chunkId });
        chunkStart = -1;
      }
      continue;
    }
    if (n === 33 || n === 63) {
      // '<!doctype', '<?…' : not something the render emits
      return null;
    }
    if (!isAlpha(n)) {
      // a '<' that does not start a tag is text
      if (stack.length === 0) return null;
      i++;
      continue;
    }
    const tag = readStartTag(s, i, to);
    if (!tag) return null;
    if (stack.length === 0) {
      chunkStart = i;
      chunkTag = tag.name;
      chunkId = idOf(s.slice(tag.attrsStart, tag.attrsEnd));
    }
    let leaf = false;
    if (VOID.has(tag.name)) leaf = true;
    else if (tag.selfClosing) {
      if (foreign === 0 && !FOREIGN.has(tag.name)) return null; // `<div/>` opens a div in HTML: doubt
      leaf = true;
    }
    i = tag.end;
    if (leaf) {
      if (stack.length === 0) {
        out.push({ start: chunkStart, end: i, tag: chunkTag, id: chunkId });
        chunkStart = -1;
      }
      continue;
    }
    if (foreign === 0 && RAW_TEXT.has(tag.name)) {
      const close = findClose(s, tag.name, i, to);
      if (close === -1 || close >= to) return null;
      const gt = s.indexOf('>', close);
      if (gt === -1 || gt >= to) return null;
      i = gt + 1;
      if (stack.length === 0) {
        out.push({ start: chunkStart, end: i, tag: chunkTag, id: chunkId });
        chunkStart = -1;
      }
      continue;
    }
    stack.push(tag.name);
    if (FOREIGN.has(tag.name)) foreign++;
  }
  if (stack.length !== 0) return null;
  return out;
}

/** the key of a top-level child: its id, or its position among the morphed children */
export function childKey(tag: string, id: string | null, position: number): string {
  return id !== null ? `${tag}#${id}` : `${tag}@${position}`;
}

const STYLE_OPEN = /^\s*<style(?:\s[^>]*)?>/i;

/** splits a render string into the hoistable style, the #game open tag and #game's top-level children */
export function parseRender(html: string, rootId = 'game'): RenderParts {
  let i = 0;
  const styles: string[] = [];
  for (;;) {
    const m = STYLE_OPEN.exec(html.slice(i, i + 64));
    if (!m) break;
    const textStart = i + m[0].length;
    const close = html.indexOf('</style>', textStart);
    if (close === -1) break;
    styles.push(html.slice(textStart, close));
    i = close + '</style>'.length;
  }
  const body = i === 0 ? html : html.slice(i);
  const style = styles.length > 0 ? styles.join('\n') : null;
  const none: RenderParts = { style, body, ssOpen: null, inner: '', children: null };
  const split = (ssOpen: string, inner: string): RenderParts => {
    const kids = scanTopLevel(inner);
    const children = kids ? kids.map((c, n) => ({ key: childKey(c.tag, c.id, n), tag: c.tag, html: inner.slice(c.start, c.end) })) : null;
    return { style, body, ssOpen, inner, children };
  };
  // fast path, one scan: `<div id='game' …>` + content + `</div>`; when the content splits it is balanced, so the body is
  // exactly that one element
  let a = 0;
  while (a < body.length && isSpace(body.charCodeAt(a))) a++;
  let e = body.length;
  while (e > a && isSpace(body.charCodeAt(e - 1))) e--;
  if (body.startsWith('<div', a) && body.slice(e - 6, e).toLowerCase() === '</div>') {
    const open = readStartTag(body, a, e);
    if (open && open.name === 'div' && !open.selfClosing && idOf(body.slice(open.attrsStart, open.attrsEnd)) === rootId && open.end <= e - 6) {
      const parts = split(body.slice(a, open.end), body.slice(open.end, e - 6));
      if (parts.children !== null) return parts;
    }
  }
  // slow path: a full scan decides whether the body is one #game element whose content cannot be split
  const top = scanTopLevel(body);
  if (!top || top.length !== 1) return none;
  const ss = top[0]!;
  if (ss.tag !== 'div' || ss.id !== rootId) return none;
  const open = readStartTag(body, ss.start, ss.end);
  if (!open) return none;
  return split(body.slice(ss.start, open.end), body.slice(open.end, body.lastIndexOf('</', ss.end)));
}

/** the cheap string test before a DOM check: an `<svg>` that holds a `<symbol>` */
export function looksLikeSprite(chunk: string): boolean {
  return chunk.startsWith('<svg') && chunk.includes('<symbol');
}

/**
 * A sprite `<svg>` (scripts/ui/icons.js:10-16): no element child other than `<defs>` and `<symbol>`, at least one `<symbol>`
 * among its children and its `<defs>`' children. `<svg><use/></svg>` icons are not sprites. (Same rule as the normaliser's
 * `isSpriteSvg`, tools/ui-ref/dom-normalize.ts.)
 */
export function isSpriteSvg(el: Element): boolean {
  if (el.localName !== 'svg') return false;
  let symbols = 0;
  for (const c of Array.from(el.children)) {
    if (c.localName === 'symbol') symbols++;
    else if (c.localName === 'defs') {
      for (const d of Array.from(c.children)) if (d.localName === 'symbol') symbols++;
    } else return false;
  }
  return symbols > 0;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** the page-level hoist targets (io §3.2): `<style id="ss-style">` and the hidden `<svg id="ss-sprites"><defs/></svg>` */
export class Hoister {
  readonly style: HTMLStyleElement;
  readonly sprites: SVGSVGElement;
  readonly #defs: SVGDefsElement;
  readonly #byId = new Map<string, { el: Element; html: string }>();
  #styleText: string | null = null;
  /** sprite chunk text → it was a sprite (and is merged); bounded */
  readonly #seen = new Map<string, boolean>();

  constructor(doc: Document, ids: { style?: string; sprites?: string } = {}) {
    this.style = doc.createElement('style');
    this.style.id = ids.style ?? 'ss-style';
    this.sprites = doc.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    this.sprites.id = ids.sprites ?? 'ss-sprites';
    this.sprites.setAttribute('width', '0');
    this.sprites.setAttribute('height', '0');
    this.sprites.setAttribute('aria-hidden', 'true');
    // hidden by size, never display:none: gradients inside a display:none svg do not paint (the live sprite is position:absolute, 0×0)
    this.sprites.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
    this.#defs = doc.createElementNS(SVG_NS, 'defs') as SVGDefsElement;
    this.sprites.append(this.#defs);
  }

  /** the hoisted stylesheet text, replaced only when it changes; true when it changed */
  setStyle(css: string): boolean {
    if (css === this.#styleText) return false;
    this.#styleText = css;
    this.style.textContent = css;
    return true;
  }

  /**
   * Hoists a sprite chunk: true when it is a sprite (then it never reaches the morph). A text seen before costs one map lookup;
   * a new one is parsed once and merged by id (new ids appended, changed ones replaced, none removed).
   */
  hoistSprite(chunk: string): boolean {
    const seen = this.#seen.get(chunk);
    if (seen !== undefined) return seen;
    if (!looksLikeSprite(chunk)) return this.#remember(chunk, false);
    const tpl = this.style.ownerDocument.createElement('template');
    tpl.innerHTML = chunk;
    const svg = tpl.content.firstElementChild;
    if (!svg || tpl.content.childElementCount !== 1 || !isSpriteSvg(svg)) return this.#remember(chunk, false);
    for (const c of Array.from(svg.children)) {
      if (c.localName === 'defs') for (const d of Array.from(c.children)) this.#merge(d);
      else this.#merge(c);
    }
    return this.#remember(chunk, true);
  }

  /** ids currently hoisted */
  get ids(): string[] {
    return [...this.#byId.keys()];
  }

  #remember(chunk: string, verdict: boolean): boolean {
    if (this.#seen.size >= 16) this.#seen.clear();
    this.#seen.set(chunk, verdict);
    return verdict;
  }

  #merge(node: Element): void {
    const id = node.id;
    const html = node.outerHTML;
    if (id === '') {
      // no id, nothing can reference it: keep one copy of each distinct node
      if (!this.#byId.has(`\u0000${html}`)) this.#byId.set(`\u0000${html}`, { el: this.#adopt(node), html });
      return;
    }
    const prev = this.#byId.get(id);
    if (prev && prev.html === html) return;
    const el = this.#adopt(node, prev?.el);
    this.#byId.set(id, { el, html });
  }

  #adopt(node: Element, replace?: Element): Element {
    const el = this.style.ownerDocument.importNode(node, true);
    if (replace) replace.replaceWith(el);
    else this.#defs.append(el);
    return el;
  }

  /** forget the hoisted nodes (dispose) */
  clear(): void {
    this.#byId.clear();
    this.#seen.clear();
    this.#defs.replaceChildren();
    this.#styleText = null;
    this.style.textContent = '';
  }
}
