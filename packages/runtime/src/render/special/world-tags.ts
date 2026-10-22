// World tags (opt-in `GameDeps.worldTags`; K12): a row's `ui` string that asks to face the player,
// `<div facing="player" width="1.8m">…</div>` (billboard name tags over bots, podium labels), drawn as HTML instead of a canvas
// panel. The authored markup is kept as written (backgrounds, borders, fonts), so it looks as the game styled it.
//
// Each tag is a `position:fixed` element in a container over the canvas, with `data-world-anchor` / `data-anchor-offset="0 0 0"`:
// `AnchorProjector` (runtime/ui/anchors.ts, the same one the UI host uses for nameplates) places it every frame at the projected
// world position of the row's node, hides it behind the camera or off the field, and writes `--anchor-depth`. The tag then scales
// its content so that `width` (metres, from the markup) spans that many metres on screen at that depth: the authored pixels are
// only a design size. HTML faces the screen, so `facing="player"` costs nothing more; an occluded tag still shows, as nameplates do.
//
// Not three.js: the node is read as a matrix (`matrixWorld.elements`, translation in 12..14), the camera arrives as callbacks.
import type { Vec3 } from '../../compat/core/types.ts';
import type { RowSnapshot } from '../../compat/core/ports.ts';
import { AnchorProjector, type AnchorRow } from '../../runtime/ui/anchors.ts';
import type { RowExtensionBinding } from '../bridge/bridge-types.ts';

/** the part of a node a tag reads: its interpolated world matrix (column-major, translation in 12..14) */
export interface TagNode {
  readonly matrixWorld: { readonly elements: ArrayLike<number> };
}

/** does a `ui` string ask to face the player: its first element carries `facing="player"` */
export function isFacingPlayerUi(ui: unknown): boolean {
  if (typeof ui !== 'string') return false;
  const open = /^\s*<[a-zA-Z][\w-]*((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/.exec(ui);
  return open !== null && /\sfacing\s*=\s*(?:"player"|'player'|player(?=[\s/>]|$))/i.test(open[1]!);
}

/** the `width="1.8m"` of the first element in metres, else null */
export function tagWidthM(ui: string): number | null {
  const open = /^\s*<[a-zA-Z][\w-]*((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/.exec(ui);
  const m = open === null ? null : /\swidth\s*=\s*["']?\s*([\d.]+)\s*m\b/i.exec(open[1]!);
  const n = m === null ? NaN : Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface WorldTagsOptions {
  /** where the tags live: a layer over the canvas (`position:absolute; inset:0; pointer-events:none`) */
  container: HTMLElement;
  /** the presented camera: eye and forward direction; null before the first */
  camera(): { readonly eye: Vec3; readonly aim: Vec3 } | null;
  /** CSS px from the top-left of the active field, unclamped; null = no engine yet */
  project(p: Vec3): { readonly x: number; readonly y: number } | null;
  /** the active field in viewport CSS px */
  viewport(): { readonly width: number; readonly height: number; readonly left?: number; readonly top?: number };
  /** CSS px that one metre spans at `depthM` from the eye (perspective: height / (2 · depth · tan(fov / 2))) */
  pxPerMetre(depthM: number): number;
  /** the content's natural width in CSS px; default `offsetWidth` (0 without layout: the tag then keeps scale 1) */
  measure?(content: HTMLElement): number;
  log?(message: string): void;
}

interface Tag {
  readonly el: HTMLElement;
  readonly content: HTMLElement;
  readonly node: TagNode;
  widthM: number | null;
  scale: number;
}

const DEPTH_VAR = '--anchor-depth';
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export class WorldTags {
  readonly #opts: WorldTagsOptions;
  readonly #tags = new Map<string, Tag>();
  readonly #projector: AnchorProjector;
  readonly #feet: Vec3 = { x: 0, y: 0, z: 0 };
  #disposed = false;

  constructor(opts: WorldTagsOptions) {
    this.#opts = opts;
    this.#projector = new AnchorProjector({
      project: (p) => opts.project(p),
      camera: () => opts.camera(),
      viewport: () => opts.viewport(),
      getObject: (id) => this.#rowOf(id),
    });
  }

  /** the bridge's `ui` extension for a row that faces the player; null for anything else */
  readonly extension = (row: RowSnapshot, node: TagNode): RowExtensionBinding | null => {
    if (this.#disposed) return null;
    const ui = row.props['ui'];
    if (!isFacingPlayerUi(ui)) return null;
    const tag = this.#make(row.id, node, ui as string);
    return {
      update: (next) => {
        const html = next.props['ui'];
        if (typeof html === 'string') this.#fill(tag, html);
      },
      dispose: () => {
        if (this.#tags.get(row.id) === tag) this.#tags.delete(row.id);
        tag.el.remove();
      },
    };
  };

  #make(id: string, node: TagNode, html: string): Tag {
    const doc = this.#opts.container.ownerDocument;
    const el = doc.createElement('div');
    el.setAttribute('data-world-anchor', id);
    el.setAttribute('data-anchor-offset', '0 0 0');
    el.setAttribute('data-world-tag', id);
    el.style.visibility = 'hidden';
    el.style.pointerEvents = 'none';
    const content = doc.createElement('div');
    content.style.width = 'max-content';
    content.style.transformOrigin = 'center center';
    content.style.transform = 'translate(-50%, -50%)';
    el.append(content);
    const tag: Tag = { el, content, node, widthM: null, scale: 1 };
    this.#fill(tag, html);
    this.#opts.container.append(el);
    this.#tags.set(id, tag);
    return tag;
  }

  #fill(tag: Tag, html: string): void {
    tag.content.innerHTML = html;
    tag.widthM = tagWidthM(html);
    tag.scale = Number.NaN; // re-applied on the next frame
  }

  #rowOf(id: string): AnchorRow | null {
    const tag = this.#tags.get(id);
    if (tag === undefined) return null;
    const e = tag.node.matrixWorld.elements;
    const p = this.#feet;
    p.x = e[12] ?? 0;
    p.y = e[13] ?? 0;
    p.z = e[14] ?? 0;
    return { feetPosition: p, bounds: undefined };
  }

  /** once per rendered frame, after the bridge placed the rows */
  frame(): void {
    if (this.#disposed || this.#tags.size === 0) return;
    try {
      this.#projector.project(this.#opts.container);
    } catch (e) {
      this.#opts.log?.(`[tags] projection failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const measure = this.#opts.measure ?? ((c: HTMLElement) => c.offsetWidth);
    for (const tag of this.#tags.values()) {
      if (tag.el.style.visibility === 'hidden' || tag.widthM === null) continue;
      const depth = Number(tag.el.style.getPropertyValue(DEPTH_VAR));
      const natural = measure(tag.content);
      if (!(depth > 0) || !(natural > 0)) continue;
      const k = round3((tag.widthM * this.#opts.pxPerMetre(depth)) / natural);
      if (!(k > 0) || k === tag.scale) continue;
      tag.scale = k;
      tag.content.style.transform = `translate(-50%, -50%) scale(${k})`;
    }
  }

  stats(): { tags: number } {
    return { tags: this.#tags.size };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const t of this.#tags.values()) t.el.remove();
    this.#tags.clear();
  }
}
