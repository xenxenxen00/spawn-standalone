// The idiomorph 0.8.0 wrapper (io §3.4 step 6). Idiomorph matches by id sets: a kept id keeps its element (and its running CSS
// animation); a new transient id (`ann<t>`, `pop<t>`, `hit<t>`, `ss-death-<t>`, …) is a fresh element whose animation plays
// (system-ui.md §2.4). `ignoreActiveValue` keeps a range slider's value while the player drags it; `restoreFocus` keeps the
// focused control focused across a morph.
import { Idiomorph } from 'idiomorph';

const BASE = { ignoreActiveValue: true, restoreFocus: true } as const;

/** `root`'s content becomes `html` (a screen change, or a render that cannot be split per child) */
export function morphInto(root: Element, html: string): void {
  Idiomorph.morph(root, html, { ...BASE, morphStyle: 'innerHTML' });
}

/** `el` itself becomes `html` (one changed top-level child of #game) */
export function morphChild(el: Element, html: string): void {
  Idiomorph.morph(el, html, { ...BASE, morphStyle: 'outerHTML' });
}

const ATTR_TPL = new WeakMap<Document, HTMLTemplateElement>();

/** the attributes of an open tag string, entity-decoded by the HTML parser (`<div id='game' class="…" style="…">`) */
export function attributesOf(doc: Document, openTag: string): Array<[string, string]> {
  let tpl = ATTR_TPL.get(doc);
  if (!tpl) ATTR_TPL.set(doc, (tpl = doc.createElement('template')));
  tpl.innerHTML = `${openTag}</div>`;
  const el = tpl.content.firstElementChild;
  const out: Array<[string, string]> = el ? Array.from(el.attributes, (a) => [a.name, a.value]) : [];
  tpl.innerHTML = '';
  return out;
}

/** sets `el`'s attributes to exactly `attrs`: changed ones written, missing ones removed, equal ones untouched */
export function patchAttributes(el: Element, attrs: ReadonlyArray<readonly [string, string]>): void {
  const want = new Map(attrs);
  for (const a of Array.from(el.attributes)) if (!want.has(a.name)) el.removeAttribute(a.name);
  for (const [name, value] of want) if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}
