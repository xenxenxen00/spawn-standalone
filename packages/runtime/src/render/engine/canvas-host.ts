// Canvas sizing with host-selected aspect limits and device-pixel caps. Without an aspect range, the canvas fills
// its available area. Resize notices are coalesced into flush(); render scale changes only the scene pass.
import type { TierConfig } from '../perf/budget.ts';

/** `setRenderScale` range: a fraction of the capped device pixels */
export const RENDER_SCALE_MIN = 0.5;
export const RENDER_SCALE_MAX = 1;

export interface FieldRect {
  /** offset inside the available area, css px */
  x: number;
  y: number;
  width: number;
  height: number;
}

const whole = (n: number): number => (Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1);

/** [min, max] of width/height the active field may have; `null` = no clamp (the field is the whole area, nothing is letterboxed) */
export type AspectRange = readonly [min: number, max: number] | null;

/**
 * The active field of an `availW × availH` area: the largest centred rectangle with `range[0]` ≤ width/height ≤ `range[1]`
 * (default no clamp), in whole css px. `range` null: the whole area.
 */
export function clampAspect(availW: number, availH: number, range: AspectRange = null): FieldRect {
  const w = whole(availW);
  const h = whole(availH);
  let width = w;
  let height = h;
  if (range !== null) {
    const [lo, hi] = range;
    if (w > h * hi) width = whole(h * hi);
    else if (w < h * lo) height = whole(w / lo);
  }
  return { x: Math.floor((w - width) / 2), y: Math.floor((h - height) / 2), width, height };
}

/** `r = min(devicePixelRatio, tier.maxDpr, sqrt(tier.maxPixels / (cssW · cssH)))` (render §3.3) */
export function capPixelRatio(cssW: number, cssH: number, devicePixelRatio: number, tier: Pick<TierConfig, 'maxDpr' | 'maxPixels'>): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const area = Math.max(1, cssW) * Math.max(1, cssH);
  return Math.min(dpr, tier.maxDpr, Math.sqrt(tier.maxPixels / area));
}

/** the drawing-buffer size three's `setSize(cssW, cssH)` produces at pixel ratio `r` (`Math.floor(css · r)`) */
export function backingStoreSize(cssW: number, cssH: number, r: number): { pxW: number; pxH: number } {
  return { pxW: Math.max(1, Math.floor(cssW * r)), pxH: Math.max(1, Math.floor(cssH * r)) };
}

/** render §3.3 */
export interface CanvasHost {
  readonly canvas: HTMLCanvasElement;
  /** the active field after the aspect clamp */
  readonly cssRect: DOMRectReadOnly;
  /** 0.5..1 of the capped device pixels, applied to the scene pass */
  setRenderScale(scale: number): void;
  onResize(cb: (r: ResizeInfo) => void): () => void;
  /** device-loss rebuild (render §3.1) */
  replaceCanvas(): HTMLCanvasElement;
  /** surfaced as Renderer.onCanvasReplaced */
  onReplace(cb: (next: HTMLCanvasElement, prev: HTMLCanvasElement) => void): () => void;
}

export interface ResizeInfo {
  cssW: number;
  cssH: number;
  pxW: number;
  pxH: number;
  aspect: number;
}

export interface CanvasSize extends ResizeInfo {
  /** the capped ratio handed to `setPixelRatio` */
  pixelRatio: number;
}

/** what the host sizes: three's renderer (`setPixelRatio`, `setSize`) */
export interface SizeTarget {
  setPixelRatio(ratio: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
}

/** what the render scale reaches: the scene `PassNode` */
export interface ResolutionScaled {
  setResolutionScale(scale: number): unknown;
}

export interface AvailableArea {
  /** viewport css px */
  left: number;
  top: number;
  width: number;
  height: number;
}

/** the browser facts the host reads; every member can be replaced (tests, an external stage fit) */
export interface CanvasEnv {
  devicePixelRatio(): number;
  /** the area the canvas may use */
  available(canvas: HTMLCanvasElement): AvailableArea;
  /** Calls `changed` whenever that area or the pixel ratio may have changed; returns the stop function. */
  observe(canvas: HTMLCanvasElement, changed: () => void): () => void;
  createCanvas(prev: HTMLCanvasElement): HTMLCanvasElement;
}

export interface CanvasHostOptions {
  canvas: HTMLCanvasElement;
  tier: TierConfig;
  /** the renderer; null while there is none (before creation, during a rebuild) */
  target?: SizeTarget | null;
  env?: Partial<CanvasEnv>;
  /**
   * true (default): the host positions the canvas over the active field (`position: absolute`, left/top/width/height in px
   * from the origin of its parent's box). false: something else lays the canvas out and the available area is the canvas's own
   * box.
   */
  styleCanvas?: boolean;
  /** the clamp on the field's width/height; default no clamp; `null` turns the letterboxing off (invalid pairs disable the clamp) */
  aspectRange?: AspectRange;
}

/** the host as the render lane drives it */
export interface CanvasHostControl extends CanvasHost {
  readonly size: CanvasSize;
  readonly renderScale: number;
  /**
   * A new tier: its caps and its start render scale, applied at once. True when the drawing buffer changed: the canvas is
   * blank until it is drawn again (the caller asks the render loop for a frame).
   */
  setTier(tier: TierConfig): boolean;
  /** the renderer of a rebuild (it gets the current size at once), or null while there is none */
  setTarget(target: SizeTarget | null): void;
  /** the scene pass the render scale is written to (R5b's pipeline); null unbinds */
  bindScenePass(pass: ResolutionScaled | null): void;
  /** marks the layout stale (a resize was observed); applied by the next `flush()` */
  invalidate(): void;
  /** Applies a pending resize. True when the drawing buffer changed (the frame must be rendered again). */
  flush(): boolean;
  dispose(): void;
}

function defaultEnv(styleCanvas: boolean): CanvasEnv {
  return {
    devicePixelRatio: () => (typeof window !== 'undefined' ? window.devicePixelRatio : 1),
    available(canvas) {
      if (!styleCanvas) {
        const r = canvas.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      }
      const parent = canvas.parentElement;
      if (parent !== null && parent !== undefined) {
        const r = parent.getBoundingClientRect();
        return { left: r.left + parent.clientLeft, top: r.top + parent.clientTop, width: parent.clientWidth, height: parent.clientHeight };
      }
      return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    },
    observe(canvas, changed) {
      const stops: Array<() => void> = [];
      window.addEventListener('resize', changed);
      stops.push(() => window.removeEventListener('resize', changed));
      if (typeof ResizeObserver !== 'undefined') {
        const watched = styleCanvas ? canvas.parentElement : canvas;
        if (watched !== null && watched !== undefined) {
          const ro = new ResizeObserver(changed);
          ro.observe(watched);
          stops.push(() => ro.disconnect());
        }
      }
      // a move between monitors changes devicePixelRatio without a resize event
      if (typeof window.matchMedia === 'function') {
        let stopMedia: (() => void) | null = null;
        const watchRatio = (): void => {
          const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
          const onChange = (): void => {
            stopMedia?.();
            watchRatio();
            changed();
          };
          mq.addEventListener('change', onChange);
          stopMedia = () => mq.removeEventListener('change', onChange);
        };
        watchRatio();
        stops.push(() => stopMedia?.());
      }
      return () => {
        for (const stop of stops.splice(0)) stop();
      };
    },
    createCanvas: (prev) => prev.ownerDocument.createElement('canvas'),
  };
}

function rectOf(left: number, top: number, width: number, height: number): DOMRectReadOnly {
  if (typeof DOMRectReadOnly !== 'undefined') return new DOMRectReadOnly(left, top, width, height);
  const rect = { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height }) };
  return Object.freeze(rect);
}

function callAll<A extends unknown[]>(listeners: Iterable<(...args: A) => void>, ...args: A): void {
  for (const cb of [...listeners]) {
    try {
      cb(...args);
    } catch (e) {
      console.error('canvas host: a listener threw', e);
    }
  }
}

/** a usable range (0 < min ≤ max, finite) or null; anything else disables the clamp */
function validRange(r: AspectRange | undefined): AspectRange {
  if (r === null) return null;
  if (r === undefined) return null;
  const [lo, hi] = r;
  return Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && lo <= hi ? [lo, hi] : null;
}

export function createCanvasHost(opts: CanvasHostOptions): CanvasHostControl {
  const styleCanvas = opts.styleCanvas ?? true;
  const aspectRange = validRange(opts.aspectRange);
  const env: CanvasEnv = { ...defaultEnv(styleCanvas), ...opts.env };
  const resizeListeners = new Set<(r: ResizeInfo) => void>();
  const replaceListeners = new Set<(next: HTMLCanvasElement, prev: HTMLCanvasElement) => void>();

  let canvas = opts.canvas;
  let tier = opts.tier;
  let target: SizeTarget | null = opts.target ?? null;
  let scenePass: ResolutionScaled | null = null;
  let renderScale = tier.startRenderScale;
  let size: CanvasSize = { cssW: 1, cssH: 1, pxW: 1, pxH: 1, aspect: 1, pixelRatio: 1 };
  let cssRect = rectOf(0, 0, 1, 1);
  let dirty = false;
  let disposed = false;

  const invalidate = (): void => {
    dirty = true;
  };
  let stopObserving = env.observe(canvas, invalidate);

  const applyToTarget = (): void => {
    if (target === null) return;
    target.setPixelRatio(size.pixelRatio);
    target.setSize(size.cssW, size.cssH, false);
  };

  /** Measures and applies. Returns true when the drawing buffer (css size or pixel ratio) changed. */
  const layout = (): boolean => {
    const area = env.available(canvas);
    const field = clampAspect(area.width, area.height, aspectRange);
    const pixelRatio = capPixelRatio(field.width, field.height, env.devicePixelRatio(), tier);
    const { pxW, pxH } = backingStoreSize(field.width, field.height, pixelRatio);
    const next: CanvasSize = { cssW: field.width, cssH: field.height, pxW, pxH, aspect: field.width / field.height, pixelRatio };
    const changed = next.cssW !== size.cssW || next.cssH !== size.cssH || next.pixelRatio !== size.pixelRatio;
    size = next;
    cssRect = rectOf(area.left + field.x, area.top + field.y, field.width, field.height);
    if (styleCanvas) {
      const s = canvas.style;
      s.position = 'absolute';
      s.left = `${field.x}px`;
      s.top = `${field.y}px`;
      s.width = `${field.width}px`;
      s.height = `${field.height}px`;
    }
    if (changed) applyToTarget();
    return changed;
  };

  const flush = (): boolean => {
    if (!dirty || disposed) return false;
    dirty = false;
    if (!layout()) return false;
    callAll(resizeListeners, { cssW: size.cssW, cssH: size.cssH, pxW: size.pxW, pxH: size.pxH, aspect: size.aspect });
    return true;
  };

  layout();

  return {
    get canvas(): HTMLCanvasElement {
      return canvas;
    },
    get cssRect(): DOMRectReadOnly {
      return cssRect;
    },
    get size(): CanvasSize {
      return size;
    },
    get renderScale(): number {
      return renderScale;
    },
    setRenderScale(scale: number): void {
      if (typeof scale !== 'number' || Number.isNaN(scale)) throw new RangeError(`canvas host: render scale must be a number, got ${String(scale)}`);
      renderScale = Math.min(RENDER_SCALE_MAX, Math.max(RENDER_SCALE_MIN, scale));
      scenePass?.setResolutionScale(renderScale);
    },
    bindScenePass(pass: ResolutionScaled | null): void {
      scenePass = pass;
      scenePass?.setResolutionScale(renderScale);
    },
    setTier(next: TierConfig): boolean {
      tier = next;
      renderScale = Math.min(RENDER_SCALE_MAX, Math.max(RENDER_SCALE_MIN, tier.startRenderScale));
      scenePass?.setResolutionScale(renderScale);
      dirty = true;
      return flush();
    },
    setTarget(next: SizeTarget | null): void {
      target = next;
      applyToTarget();
    },
    onResize(cb) {
      resizeListeners.add(cb);
      return () => void resizeListeners.delete(cb);
    },
    invalidate,
    flush,
    replaceCanvas(): HTMLCanvasElement {
      const prev = canvas;
      const next = env.createCanvas(prev);
      // same id and CSS (class, inline style, data-*, tabindex …); the drawing-buffer size is the new renderer's to set
      for (const name of prev.getAttributeNames()) {
        if (name === 'width' || name === 'height') continue;
        next.setAttribute(name, prev.getAttribute(name) ?? '');
      }
      stopObserving();
      if (prev.parentNode !== null) prev.replaceWith(next);
      canvas = next;
      target = null; // the old renderer drew to `prev`; the rebuild hands the new one over with setTarget()
      stopObserving = env.observe(canvas, invalidate);
      layout();
      callAll(replaceListeners, next, prev);
      return next;
    },
    onReplace(cb) {
      replaceListeners.add(cb);
      return () => void replaceListeners.delete(cb);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopObserving();
      resizeListeners.clear();
      replaceListeners.clear();
      target = null;
      scenePass = null;
    },
  };
}
