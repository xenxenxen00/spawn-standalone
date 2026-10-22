// World-space UI panels: parse the supported markup/style subset, rasterize it into a canvas texture, and place it
// on the authored box face. Font families and defaults come from the host. Lit and emissive surfaces reuse the
// world lighting module; a missing module draws unlit. Unsupported markup never executes scripts.
import { CanvasTexture, DataTexture, LinearMipmapLinearFilter, Mesh, MeshBasicNodeMaterial, PlaneGeometry, RGBAFormat, SRGBColorSpace } from 'three/webgpu';
import type { Object3D, Texture, UniformNode } from 'three/webgpu';
import { float, texture, uniform, vec4 } from 'three/tsl';
import type { RowSnapshot } from '../../compat/core/ports.ts';
import type { RowExtensionBinding } from '../bridge/bridge-types.ts';
import { cssToLinear, linearToSrgb8 } from '../color/color.ts';
import { SurfaceMaterial, SurfaceVariant } from '../surface/surface-material.ts';
import type { LightingScript } from '../surface/script-types.ts';

/** CSS pixels per metre of a face for a fill panel [I] */
export const PANEL_PX_PER_M = 1000;
/** the long side of a panel texture, texels */
export const PANEL_MAX_TEXTURE = 2048;
/** the plane's distance out of the face, metres */
export const PANEL_OFFSET_M = 0.003;
/**
 * [I]. `emissiveGain`: the emissive term of an `emissive` panel (and its colour when unlit); `diffuseGain`: the colour of an
 * unlit panel that is not `emissive`; `albedoGain`, `roughness`: the lit surface of every panel.
 */
export const PANEL_LOOK = Object.freeze({ emissiveGain: 2, diffuseGain: 0.6, albedoGain: 1, roughness: 0.85 });
/** the lit panel's surface variant (one program for every panel) */
export const PANEL_VARIANT: number = SurfaceVariant.SRC_PRIM | SurfaceVariant.TEX_ALBEDO | SurfaceVariant.TRANSPARENT;
/** how long a raster waits for its faces */
export const PANEL_FONT_TIMEOUT_MS = 3000;

export type PanelFace = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
const FACES: readonly PanelFace[] = ['front', 'back', 'left', 'right', 'top', 'bottom'];

// ── the markup ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PanelElement {
  tag: string;
  attrs: Record<string, string | true>;
  children: Array<PanelElement | string>;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·' };
const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** Parses the `ui` markup into an element tree; null when it holds no element. */
export function parsePanelMarkup(html: string): PanelElement | null {
  const root: PanelElement = { tag: '#root', attrs: {}, children: [] };
  const stack: PanelElement[] = [root];
  const re = /<\/?([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/g;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const top = stack[stack.length - 1]!;
    if (m[3] !== undefined) {
      const text = decode(m[3]);
      if (text.trim() !== '') top.children.push(text);
      else if (text.length > 0 && top.children.length > 0) top.children.push(' ');
      continue;
    }
    const tag = m[1]!.toLowerCase();
    if (m[0].startsWith('</')) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs: Record<string, string | true> = {};
    const ar = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    for (let a = ar.exec(m[2] ?? ''); a !== null; a = ar.exec(m[2] ?? '')) attrs[a[1]!.toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? true;
    for (const k of Object.keys(attrs)) if (typeof attrs[k] === 'string') attrs[k] = decode(attrs[k]);
    const el: PanelElement = { tag, attrs, children: [] };
    top.children.push(el);
    if (!m[0].endsWith('/>') && tag !== 'br') stack.push(el);
  }
  return root.children.find((c): c is PanelElement => typeof c !== 'string') ?? null;
}

// ── styles ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Tailwind v3 colours the live rows name, plus the plain ones [I: Spawn's Tailwind version is unknown] */
export const TAILWIND_COLORS: Readonly<Record<string, string>> = Object.freeze({
  white: '#ffffff', black: '#000000',
  'amber-100': '#fef3c7', 'amber-200': '#fde68a', 'amber-300': '#fcd34d', 'amber-400': '#fbbf24', 'amber-500': '#f59e0b',
  'red-300': '#fca5a5', 'red-400': '#f87171', 'red-500': '#ef4444', 'red-600': '#dc2626',
  'slate-100': '#f1f5f9', 'slate-200': '#e2e8f0', 'slate-300': '#cbd5e1', 'slate-400': '#94a3b8',
  'zinc-200': '#e4e4e7', 'yellow-300': '#fde047', 'orange-400': '#fb923c', 'cyan-300': '#67e8f9', 'emerald-400': '#34d399',
});
const TRACKING_EM: Readonly<Record<string, number>> = { tighter: -0.05, tight: -0.025, normal: 0, wide: 0.025, wider: 0.05, widest: 0.1 };
const WEIGHTS: Readonly<Record<string, number>> = { thin: 100, extralight: 200, light: 300, normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 };

/** what children inherit */
export interface PanelTextStyle {
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  color: string;
  /** px; an `em` value is resolved against the element's own font size */
  letterSpacing: number;
  /** a factor of the font size */
  lineHeight: number;
  textAlign: 'left' | 'center' | 'right';
  shadow: { blur: number; color: string } | null;
}

/** what an element has of its own */
export interface PanelBoxStyle {
  width: number | null;
  padding: [number, number, number, number];
  marginBottom: number;
  gap: number;
  fill: boolean;
  centred: boolean;
}

export const DEFAULT_TEXT_STYLE: Readonly<PanelTextStyle> = Object.freeze({
  fontSize: 16, fontFamily: 'sans-serif', fontWeight: 400, color: '#000000', letterSpacing: 0, lineHeight: 1.2, textAlign: 'left', shadow: null,
});

/** families a row names that the build does not carry: the face they fall back to [I] */
export interface PanelFonts {
  default?: string;
  families?: Readonly<Record<string, string>>;
}

const px = (v: string): number | null => {
  const m = /^(-?[\d.]+)px$/.exec(v.trim());
  return m ? Number(m[1]) : null;
};

/** a CSS colour as canvas can always draw it: oklch() and the hex forms through the shared parser, anything else as written */
export function canvasColor(css: string): string {
  const lin = cssToLinear(css.trim());
  if (lin === null) return css.trim();
  const [r, g, b] = linearToSrgb8(lin);
  return `rgb(${r}, ${g}, ${b})`;
}

function family(v: string, fonts: PanelFonts): string {
  const first = v.split(',')[0]!.trim().replace(/^['"]|['"]$/g, '');
  const fb = fonts.families?.[first.toLowerCase()];
  if (fb !== undefined) return fb;
  return v.split(',').map((f) => {
    const t = f.trim();
    return /\s/.test(t) && !/^['"]/.test(t) ? `"${t}"` : t;
  }).join(', ');
}

/** The element's own and inherited style (classes first, then the inline style, as CSS would cascade them). */
export function resolveStyle(el: PanelElement, parent: Readonly<PanelTextStyle>, fonts: PanelFonts = {}): { text: PanelTextStyle; box: PanelBoxStyle } {
  const text: PanelTextStyle = { ...parent, shadow: parent.shadow };
  const box: PanelBoxStyle = { width: null, padding: [0, 0, 0, 0], marginBottom: 0, gap: 0, fill: false, centred: false };
  let trackingEm: number | null = null;
  const cls = typeof el.attrs['class'] === 'string' ? el.attrs['class'].split(/\s+/).filter(Boolean) : [];
  let wFull = false;
  let hFull = false;
  for (const c of cls) {
    let m: RegExpExecArray | null;
    if (c === 'w-full') wFull = true;
    else if (c === 'h-full') hFull = true;
    else if (c === 'justify-center' || c === 'items-center') box.centred = true;
    else if ((m = /^text-\[(\d+(?:\.\d+)?)px\]$/.exec(c))) text.fontSize = Number(m[1]);
    else if ((m = /^text-(left|center|right)$/.exec(c))) text.textAlign = m[1] as PanelTextStyle['textAlign'];
    else if ((m = /^text-([a-z]+(?:-\d{2,3})?)$/.exec(c)) && TAILWIND_COLORS[m[1]!] !== undefined) text.color = TAILWIND_COLORS[m[1]!]!;
    else if ((m = /^tracking-\[(-?\d+(?:\.\d+)?)px\]$/.exec(c))) {
      text.letterSpacing = Number(m[1]);
      trackingEm = null;
    } else if ((m = /^tracking-([a-z]+)$/.exec(c)) && TRACKING_EM[m[1]!] !== undefined) trackingEm = TRACKING_EM[m[1]!]!;
    else if ((m = /^font-([a-z]+)$/.exec(c)) && WEIGHTS[m[1]!] !== undefined) text.fontWeight = WEIGHTS[m[1]!]!;
    else if ((m = /^gap-\[(\d+(?:\.\d+)?)px\]$/.exec(c))) box.gap = Number(m[1]);
  }
  box.fill = wFull && hFull;
  const style = typeof el.attrs['style'] === 'string' ? el.attrs['style'] : '';
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    const n = px(value);
    switch (prop) {
      case 'width':
        if (n !== null) box.width = n;
        break;
      case 'font-size':
        if (n !== null) text.fontSize = n;
        break;
      case 'font-family':
        text.fontFamily = family(value, fonts);
        break;
      case 'font-weight': {
        const w = Number(value);
        if (Number.isFinite(w)) text.fontWeight = w;
        else if (WEIGHTS[value] !== undefined) text.fontWeight = WEIGHTS[value]!;
        break;
      }
      case 'color':
        text.color = value;
        break;
      case 'letter-spacing': {
        const em = /^(-?[\d.]+)em$/.exec(value);
        if (n !== null) {
          text.letterSpacing = n;
          trackingEm = null;
        } else if (em) trackingEm = Number(em[1]);
        break;
      }
      case 'line-height': {
        const f = Number(value);
        if (Number.isFinite(f)) text.lineHeight = f;
        else if (n !== null && text.fontSize > 0) text.lineHeight = n / text.fontSize;
        break;
      }
      case 'text-align':
        if (value === 'left' || value === 'center' || value === 'right') text.textAlign = value;
        break;
      case 'padding': {
        const parts = value.split(/\s+/).map((v) => px(v) ?? 0);
        const [t = 0, r = t, b = t, l = r] = parts;
        box.padding = [t, r, b, l];
        break;
      }
      case 'margin-bottom':
        if (n !== null) box.marginBottom = n;
        break;
      case 'text-shadow': {
        // `x y blur colour`: the glow of the sign (offsets of the live rows are 0)
        const m = /^(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+([\d.]+)px\s+(.+)$/.exec(value);
        if (m) text.shadow = { blur: Number(m[3]), color: m[4]!.trim() };
        break;
      }
      default:
        break;
    }
  }
  if (trackingEm !== null) text.letterSpacing = trackingEm * text.fontSize;
  return { text, box };
}

// ── layout ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** one run of text drawn with one style */
export interface PanelRun {
  text: string;
  style: PanelTextStyle;
  /** CSS px: the left edge and the vertical middle of the run's line box */
  x: number;
  y: number;
  width: number;
}

export interface PanelLayout {
  mode: 'fill' | 'block';
  face: PanelFace;
  emissive: boolean;
  /** CSS px of the canvas */
  width: number;
  height: number;
  /** metres of the plane */
  widthM: number;
  heightM: number;
  /** the runs scale by this when drawn (a fill line that overflowed its face) */
  scale: number;
  runs: PanelRun[];
}

/** a run's advance: the font's width of the text plus one letter spacing per character */
export type PanelMeasure = (text: string, font: string, letterSpacing: number) => number;

export const fontOf = (s: Readonly<PanelTextStyle>, scale = 1): string => `${s.fontWeight} ${Math.max(1, s.fontSize * scale)}px ${s.fontFamily}`;

interface Inline {
  text: string;
  style: PanelTextStyle;
  /** gap before the item (flex `gap` between items) */
  gapBefore: number;
}

function inlines(el: PanelElement, style: PanelTextStyle, out: Inline[], gap: number, item: { first: boolean }, fonts: PanelFonts): void {
  for (const c of el.children) {
    if (typeof c === 'string') {
      out.push({ text: c, style, gapBefore: item.first ? 0 : gap });
      item.first = false;
      continue;
    }
    const s = resolveStyle(c, style, fonts).text;
    const before = out.length;
    inlines(c, s, out, 0, { first: true }, fonts);
    if (out.length > before) {
      out[before]!.gapBefore = item.first ? 0 : gap;
      item.first = false;
    }
  }
}

/** the face of a box primitive, metres (width × height as the plane lies on it) */
export function faceSize(face: PanelFace, dims: { width: number; height: number; depth: number }): [number, number] {
  switch (face) {
    case 'front':
    case 'back':
      return [dims.width, dims.height];
    case 'left':
    case 'right':
      return [dims.depth, dims.height];
    case 'top':
    case 'bottom':
      return [dims.width, dims.depth];
  }
}

function wrap(text: string, style: PanelTextStyle, maxWidth: number, measure: PanelMeasure): string[] {
  const font = fontOf(style);
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line === '' ? w : `${line} ${w}`;
    if (line !== '' && measure(next, font, style.letterSpacing) > maxWidth) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line !== '') lines.push(line);
  return lines;
}

/** Lays a parsed panel out on a face of `dims` (the row's box, metres). Null when the markup holds no text. */
export function layoutPanel(root: PanelElement, dims: { width: number; height: number; depth: number }, measure: PanelMeasure, fonts: PanelFonts = {}): PanelLayout | null {
  const faceAttr = typeof root.attrs['face'] === 'string' ? root.attrs['face'].toLowerCase() : 'front';
  const face: PanelFace = (FACES as readonly string[]).includes(faceAttr) ? (faceAttr as PanelFace) : 'front';
  const emissive = root.attrs['emissive'] !== undefined && root.attrs['emissive'] !== 'false';
  const [faceW, faceH] = faceSize(face, dims);
  const widthAttr = typeof root.attrs['width'] === 'string' ? /^([\d.]+)m$/.exec(root.attrs['width'].trim()) : null;
  const { text: rootText, box } = resolveStyle(root, { ...DEFAULT_TEXT_STYLE, fontFamily: fonts.default ?? DEFAULT_TEXT_STYLE.fontFamily }, fonts);
  const runs: PanelRun[] = [];

  if (box.fill || box.width === null) {
    // one centred line over the whole face
    const W = Math.max(1, faceW * PANEL_PX_PER_M);
    const H = Math.max(1, faceH * PANEL_PX_PER_M);
    const items: Inline[] = [];
    inlines(root, rootText, items, box.gap, { first: true }, fonts);
    if (items.every((i) => i.text.trim() === '')) return null;
    let x = 0;
    let lineH = 0;
    for (const it of items) {
      x += it.gapBefore;
      const width = measure(it.text, fontOf(it.style), it.style.letterSpacing);
      runs.push({ text: it.text, style: it.style, x, y: 0, width });
      x += width;
      lineH = Math.max(lineH, it.style.fontSize * it.style.lineHeight);
    }
    const innerW = W - box.padding[1] - box.padding[3];
    const scale = Math.min(1, x > 0 ? innerW / x : 1, lineH > 0 ? H / lineH : 1);
    const align = box.centred ? 'center' : rootText.textAlign;
    const left = align === 'center' ? (W - x * scale) / 2 : align === 'right' ? W - box.padding[1] - x * scale : box.padding[3];
    for (const r of runs) {
      r.x = left + r.x * scale;
      r.y = H / 2;
    }
    return { mode: 'fill', face, emissive, width: W, height: H, widthM: faceW, heightM: faceH, scale, runs };
  }

  // block: lines stacked in `width` CSS px
  const W = box.width;
  const innerW = W - box.padding[1] - box.padding[3];
  let y = box.padding[0];
  const block = (el: PanelElement, style: PanelTextStyle, own: PanelBoxStyle): void => {
    const items: Inline[] = [];
    const flow: Array<PanelElement | string> = [];
    const flush = (): void => {
      if (flow.length === 0) return;
      const holder: PanelElement = { tag: 'div', attrs: {}, children: flow.splice(0) };
      items.length = 0;
      inlines(holder, style, items, 0, { first: true }, fonts);
      const textAll = items.map((i) => i.text).join('');
      if (textAll.trim() === '') return;
      const s = items[0]!.style;
      for (const line of wrap(textAll, s, innerW, measure)) {
        const lh = s.fontSize * s.lineHeight;
        const width = measure(line, fontOf(s), s.letterSpacing);
        const x = s.textAlign === 'center' ? box.padding[3] + (innerW - width) / 2 : s.textAlign === 'right' ? W - box.padding[1] - width : box.padding[3];
        runs.push({ text: line, style: s, x, y: y + lh / 2, width });
        y += lh;
      }
    };
    for (const c of el.children) {
      if (typeof c !== 'string' && c.tag !== 'span' && c.tag !== 'b' && c.tag !== 'i' && c.tag !== 'br') {
        flush();
        const r = resolveStyle(c, style, fonts);
        block(c, r.text, r.box);
      } else flow.push(c);
    }
    flush();
    y += own.marginBottom;
  };
  block(root, rootText, { ...box, marginBottom: 0 });
  if (runs.length === 0) return null;
  const H = Math.max(1, y + box.padding[2]);
  const widthM = widthAttr ? Number(widthAttr[1]) : faceW;
  return { mode: 'block', face, emissive, width: W, height: H, widthM, heightM: (H * widthM) / W, scale: 1, runs };
}

// ── the raster ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** the part of a 2D context the raster uses */
export interface PanelContext2D {
  font: string;
  fillStyle: unknown;
  textBaseline: string;
  textAlign: string;
  shadowBlur: number;
  shadowColor: string;
  measureText(text: string): { width: number };
  fillText(text: string, x: number, y: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
}

export interface PanelCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): PanelContext2D | null;
}

/** A measure over a 2D context: the font's width of the text, letter spacing added per character. */
export function contextMeasure(ctx: Pick<PanelContext2D, 'font' | 'measureText'>): PanelMeasure {
  return (text, font, spacing) => {
    ctx.font = font;
    return ctx.measureText(text).width + spacing * [...text].length;
  };
}

/** texels per CSS px of the layout */
export const textureScaleOf = (layout: Pick<PanelLayout, 'width' | 'height'>): number => Math.min(2, PANEL_MAX_TEXTURE / Math.max(layout.width, layout.height));

/** Draws the layout into `canvas` (sized here). */
export function drawPanel(canvas: PanelCanvas, layout: PanelLayout): void {
  const k = textureScaleOf(layout);
  canvas.width = Math.max(1, Math.round(layout.width * k));
  canvas.height = Math.max(1, Math.round(layout.height * k));
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('world panel: no 2d context');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const s = layout.scale * k;
  for (const r of layout.runs) {
    ctx.font = fontOf(r.style, s);
    ctx.fillStyle = canvasColor(r.style.color);
    ctx.shadowBlur = r.style.shadow ? r.style.shadow.blur * s : 0;
    ctx.shadowColor = r.style.shadow ? canvasColor(r.style.shadow.color) : 'rgba(0, 0, 0, 0)';
    const y = r.y * k;
    if (r.style.letterSpacing === 0) {
      ctx.fillText(r.text, r.x * k, y);
      continue;
    }
    // letter by letter: the spacing of CSS (after every character) on any canvas
    let x = r.x * k;
    for (const ch of r.text) {
      ctx.fillText(ch, x, y);
      x += ctx.measureText(ch).width + r.style.letterSpacing * s;
    }
  }
}

/** the font strings a layout draws with (what `document.fonts.load` is asked for) */
export const fontsOf = (layout: PanelLayout): string[] => [...new Set(layout.runs.map((r) => fontOf(r.style)))];

// ── the renderer ────────────────────────────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);

/** the box a `ui` row's face is measured on: its `primitive` (a box; any other kind is measured as a unit box) */
export function panelBoxOf(row: Pick<RowSnapshot, 'props'>): { width: number; height: number; depth: number } {
  const p = row.props['primitive'];
  const spec = isObj(p) ? p : {};
  const s = num(spec['size'], 1);
  return { width: num(spec['width'], s), height: num(spec['height'], s), depth: num(spec['depth'], s) };
}

/** the plane on the face: position and the rotation that turns the plane's +Z to the face's outward normal */
export function placePanel(mesh: Object3D, layout: Pick<PanelLayout, 'face' | 'widthM' | 'heightM'>, dims: { width: number; height: number; depth: number }): void {
  const o = PANEL_OFFSET_M;
  const cy = dims.height / 2;
  mesh.scale.set(layout.widthM, layout.heightM, 1);
  mesh.rotation.set(0, 0, 0);
  switch (layout.face) {
    case 'front':
      mesh.position.set(0, cy, -dims.depth / 2 - o);
      mesh.rotation.y = Math.PI;
      break;
    case 'back':
      mesh.position.set(0, cy, dims.depth / 2 + o);
      break;
    case 'left':
      mesh.position.set(-dims.width / 2 - o, cy, 0);
      mesh.rotation.y = -Math.PI / 2;
      break;
    case 'right':
      mesh.position.set(dims.width / 2 + o, cy, 0);
      mesh.rotation.y = Math.PI / 2;
      break;
    case 'top':
      mesh.position.set(0, dims.height + o, 0);
      mesh.rotation.x = -Math.PI / 2;
      break;
    case 'bottom':
      mesh.position.set(0, -o, 0);
      mesh.rotation.x = Math.PI / 2;
      break;
  }
}

export interface WorldPanelsOptions {
  fonts?: PanelFonts;
  /** a canvas for a raster; default: an OffscreenCanvas, else a DOM canvas */
  canvas?: () => PanelCanvas;
  /** waits for a face; default `document.fonts.load` with `PANEL_FONT_TIMEOUT_MS` */
  loadFont?: (font: string) => Promise<unknown>;
  /**
   * The world's lighting module (`scripts/lighting.js`, as `SurfaceMaterials` has it): panels are lit surfaces with the
   * texture on the emissive (render §14.4). Null or absent: unlit panels (see the header).
   */
  script?: LightingScript | null;
  log?: (message: string) => void;
}

export interface WorldPanelStats {
  panels: number;
  rastered: number;
}

interface PanelMaterial {
  material: SurfaceMaterial | MeshBasicNodeMaterial;
  map: ReturnType<typeof texture>;
  /** the emissive gain of a lit panel; the colour gain of an unlit one */
  gain: UniformNode<'float', number>;
}

function defaultCanvas(): PanelCanvas {
  const g = globalThis as { OffscreenCanvas?: new (w: number, h: number) => PanelCanvas; document?: { createElement(tag: 'canvas'): PanelCanvas } };
  if (g.OffscreenCanvas !== undefined) return new g.OffscreenCanvas(1, 1);
  if (g.document !== undefined) return g.document.createElement('canvas');
  throw new Error('world panel: no canvas in this environment');
}

function defaultLoadFont(font: string): Promise<unknown> {
  const fonts = (globalThis as { document?: { fonts?: { load(font: string): Promise<unknown> } } }).document?.fonts;
  if (fonts === undefined) return Promise.resolve();
  return Promise.race([fonts.load(font).catch(() => undefined), new Promise((r) => setTimeout(r, PANEL_FONT_TIMEOUT_MS))]);
}

/** the `ui` rows' renderer: `extension` is the bridge's `ui` row extension */
export class WorldPanels {
  readonly #opts: WorldPanelsOptions;
  readonly #geometry = new PlaneGeometry(1, 1);
  /** transparent 1 × 1: what a panel samples until its raster is there */
  readonly #blank: DataTexture;
  readonly #live = new Set<{ dispose(): void }>();
  #rastered = 0;
  #warm: PanelMaterial[] = [];
  #disposed = false;

  constructor(opts: WorldPanelsOptions = {}) {
    this.#opts = opts;
    this.#blank = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat);
    this.#blank.colorSpace = SRGBColorSpace;
    this.#blank.needsUpdate = true;
  }

  /** the one material shape of every panel: lit, the texture as albedo and emissive (× gain), alpha from the texture */
  #material(emissive: boolean): PanelMaterial {
    const map = texture(this.#blank as Texture);
    const script = this.#opts.script ?? null;
    if (script === null) {
      const gain = uniform(emissive ? PANEL_LOOK.emissiveGain : PANEL_LOOK.diffuseGain);
      const material = new MeshBasicNodeMaterial();
      material.name = 'ss:panel';
      material.transparent = true;
      material.depthWrite = false;
      material.colorNode = vec4(map.rgb.mul(gain), map.a);
      return { material, map, gain };
    }
    const gain = uniform(emissive ? PANEL_LOOK.emissiveGain : 0);
    const albedo = uniform(PANEL_LOOK.albedoGain);
    const material = new SurfaceMaterial({ variant: PANEL_VARIANT, script });
    material.name = 'ss:panel';
    material.depthWrite = false;
    material.colorNode = map.rgb.mul(albedo);
    material.emissiveNode = map.rgb.mul(gain);
    material.opacityNode = map.a;
    material.roughnessNode = float(PANEL_LOOK.roughness);
    material.metalnessNode = float(0);
    return { material, map, gain };
  }

  readonly extension = (row: RowSnapshot, node: Object3D): RowExtensionBinding | null => {
    if (this.#disposed) return null;
    const ui = row.props['ui'];
    if (typeof ui !== 'string' || ui.trim() === '') return null;
    const root = parsePanelMarkup(ui);
    if (root === null) {
      this.#opts.log?.(`[panels] ${row.id}: the \`ui\` markup holds no element`);
      return null;
    }
    const canvas = (this.#opts.canvas ?? defaultCanvas)();
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    const dims = panelBoxOf(row);
    const layout = layoutPanel(root, dims, contextMeasure(ctx), this.#opts.fonts);
    if (layout === null) return null;
    const mat = this.#material(layout.emissive);
    const mesh = new Mesh(this.#geometry, mat.material);
    mesh.name = `ss:panel:${row.id}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    placePanel(mesh, layout, dims);
    node.add(mesh);
    let tex: CanvasTexture | null = null;
    let gone = false;
    const binding = {
      dispose: (): void => {
        if (gone) return;
        gone = true;
        this.#live.delete(binding);
        mesh.removeFromParent();
        mat.material.dispose();
        tex?.dispose();
      },
    };
    this.#live.add(binding);
    const loadFont = this.#opts.loadFont ?? defaultLoadFont;
    void Promise.all(fontsOf(layout).map((f) => loadFont(f)))
      .then(() => {
        if (gone) return;
        // measured again with the faces in place
        const again = layoutPanel(root, dims, contextMeasure(ctx), this.#opts.fonts) ?? layout;
        placePanel(mesh, again, dims);
        drawPanel(canvas, again);
        tex = new CanvasTexture(canvas as unknown as HTMLCanvasElement);
        tex.colorSpace = SRGBColorSpace;
        tex.minFilter = LinearMipmapLinearFilter;
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        mat.map.value = tex;
        this.#rastered++;
      })
      .catch((e: unknown) => this.#opts.log?.(`[panels] ${row.id}: the raster failed: ${e instanceof Error ? e.message : String(e)}`));
    return binding;
  };

  /** stand-ins of both gains for the engine-load warm-up (one program; kept until dispose) */
  warmObjects(): Object3D[] {
    if (this.#disposed) return [];
    if (this.#warm.length === 0) this.#warm = [this.#material(true), this.#material(false)];
    return this.#warm.map((m, i) => {
      const mesh = new Mesh(this.#geometry, m.material);
      mesh.name = `ss:warm-up:panel:${i === 0 ? 'emissive' : 'diffuse'}`;
      return mesh;
    });
  }

  stats(): WorldPanelStats {
    return { panels: this.#live.size, rastered: this.#rastered };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const b of [...this.#live]) b.dispose();
    for (const m of this.#warm) m.material.dispose();
    this.#warm = [];
    this.#geometry.dispose();
    this.#blank.dispose();
  }
}
