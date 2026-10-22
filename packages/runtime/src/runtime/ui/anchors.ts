// `data-world-anchor` projection (io §3.7; spawn-engine-contract.md §14.1-14.2; X-04, X-39, X-46; WP UI2a).
//
// `project(root)` runs once per UI frame, after the morph and the modal scan (frame step 8 of ui-host.ts, docs/architecture.md
// §4.2 step 7), also when the render string did not change and while the sim is paused: the camera and the rows move without
// the DOM changing. For every `[data-world-anchor="<row id>"]` element under `root`:
//   1. the row comes from the runtime registry (`getObject`); an unknown or empty id hides the element
//   2. the anchor point is the row's feet plus `data-anchor-offset="x y z"` (metres); with no offset it is the X/Z of the feet
//      at the top of the row's bounds (`bounds.max.y`)
//   3. the point is projected with this frame's presented world camera and written as
//      `transform: translate3d(Xpx, Ypx, 0)` on a `position:fixed; left:0; top:0` element, with `--anchor-depth` = metres from
//      the eye; the inner element's own `translate(-50%,-100%)` (scripts/ui/hud.js:153,159) centres the plate over the point
//   4. a point behind the camera or outside the field extended by 10 % on each edge gets `visibility:hidden`
//   5. no occlusion test (live draws plates through walls, system-ui.md §3.11)
// Live users: the teammate nameplates (offset `0 2.15 0`) and the terminal marker (`0 2.3 0`).
//
// Decisions the design leaves open, each one tested (tests/unit/ui/anchors.{three,dom}.test.ts):
//   - No three.js here (rule three-confined: the UI host is in the boot chunk, X-26). The camera arrives as callbacks
//     (`AnchorDeps`); the composition root passes rendering's `project()` (render §4.2) and the camera port's
//     `presentedCamera()`.
//   - What `project()` must deliver: `x`, `y` in CSS pixels measured from the top-left corner of the active stage field, for
//     ANY point in front of the camera, also one outside the field (the 10 % margin is cut here, from `x`, `y` and
//     `viewport()`; a `project()` that clamped to the screen or returned nothing off-screen would lose the margin). Its `depth`
//     and `onScreen` members are NOT read: render §4.2 does not define `depth` (NDC z and view-space metres are both natural
//     readings) and `onScreen` is the strict screen. `null` means there is no render engine yet (the lobby before the engine
//     chunk loads, X-04): every anchor is hidden.
//   - Behind the camera = `(point − eye) · aim ≤ 0`, from `camera()` (`aim` is the forward direction, io §5.6: the same pose
//     the projection matrices of this frame were built from). `Vector3.project` mirrors such a point back into the field, so
//     the pixel test alone cannot see it. A point in the eye plane has no projection and is hidden by the same test.
//   - `--anchor-depth` is the straight-line distance from the eye to the anchor point in metres, a unitless number kept to
//     0.01 (the game's CSS divides it: `calc(1.25 - var(--anchor-depth, 0) / 45)`). It is not the view-axis depth.
//   - The row point is `worldFeetPosition` (falling back to `feetPosition`): the anchored rows are unparented, where the two
//     are equal, and a parented row would otherwise be placed by its local coordinates.
//   - `bounds` undefined (model not measured yet) with no offset: hidden.
//   - A malformed `data-anchor-offset` (anything but three finite numbers separated by whitespace) counts as no offset. It
//     never throws: a throw here would drop every anchor of the frame (ui-host catches and logs once).
//   - No element cache. io §3.7 says "collect (cached until the next morph)", but `project(root)` is not told about morphs, and
//     the HUD morphs on most frames, so an observer would cost more than it saves: the root is queried once per frame
//     (one `querySelectorAll`, no layout read). Nothing can go stale across a whole-root morph, a re-created node or a changed
//     id. Parsed offsets are cached by their text.
//   - Every frame is written from the element's CURRENT inline style, never from what this module wrote last: the morph may
//     have reset the style attribute to the render string's a moment ago, and the same frame repairs it (no flicker).
//   - Only `transform`, `visibility`, `position`, `left`, `top` and `--anchor-depth` are written, each through `el.style`; the
//     style attribute is never replaced and the game-authored `opacity` is never touched. A hidden anchor gets only
//     `visibility:hidden`; a shown one gets `visibility` cleared.
//   - `viewport()` is read once per frame and never cached: the canvas may be replaced (X3) and the field resized.
import type { Vec3 } from '../../compat/core/types.ts';

/** io §3.7 step 4: the field is extended by this fraction of its width / height on each edge */
export const ANCHOR_MARGIN = 0.1;

/** the part of a row (`ObjectView`) an anchor reads */
export interface AnchorRow {
  /** local feet position (world for unparented rows) */
  readonly feetPosition: Vec3;
  /** world feet position; used when present */
  readonly worldFeetPosition?: Vec3;
  /** world AABB, undefined until the model is measured */
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 } | undefined;
}

/** the active stage field in viewport CSS pixels (`left`/`top` default 0: the field starts at the viewport corner) */
export interface AnchorViewport {
  readonly width: number;
  readonly height: number;
  readonly left?: number;
  readonly top?: number;
}

export interface AnchorDeps {
  /**
   * Rendering's `project()` (render §4.2): CSS pixels from the top-left of the active stage field, unclamped. `null` = no
   * render engine yet. `p` is a scratch object reused between calls: read it, do not keep it.
   */
  project(p: Vec3): { readonly x: number; readonly y: number } | null;
  /** the presented camera of this frame (`CameraPort.presentedCamera()`): eye and forward direction; `null` before the first */
  camera(): { readonly eye: Vec3; readonly aim: Vec3 } | null;
  /** the runtime registry (`UiCtx.getObject`) */
  getObject(id: string): AnchorRow | null;
  viewport(): AnchorViewport;
}

/** the inline-style members written (a `CSSStyleDeclaration`) */
interface AnchorStyle {
  transform: string;
  visibility: string;
  position: string;
  left: string;
  top: string;
  setProperty(name: string, value: string): void;
  getPropertyValue(name: string): string;
}

interface AnchorElement {
  getAttribute(name: string): string | null;
  readonly style: AnchorStyle;
}

/** what `project` needs of the root (an `HTMLElement`) */
export interface AnchorRoot {
  querySelectorAll(selectors: string): ArrayLike<object>;
}

const SELECTOR = '[data-world-anchor]';
const DEPTH_VAR = '--anchor-depth';
/** distinct offset texts kept (live has two) */
const OFFSET_CACHE_MAX = 64;

/** `"x y z"` metres → a vector; null for anything that is not three finite numbers separated by whitespace */
export function parseAnchorOffset(text: string): Vec3 | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const x = toNumber(parts[0]!);
  const y = toNumber(parts[1]!);
  const z = toNumber(parts[2]!);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

/** `Number()` without its empty-string-is-zero rule */
const toNumber = (s: string): number => (s === '' ? Number.NaN : Number(s));

/** px and metres are written with two decimals at most (stable strings, sub-pixel placement kept) */
const round2 = (n: number): number => Math.round(n * 100) / 100;

function hide(style: AnchorStyle): void {
  if (style.visibility !== 'hidden') style.visibility = 'hidden';
}

export class AnchorProjector {
  readonly #deps: AnchorDeps;
  readonly #offsets = new Map<string, Vec3 | null>();
  /** the anchor point of the element being placed (handed to `deps.project`) */
  readonly #point: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(deps: AnchorDeps) {
    this.#deps = deps;
  }

  /** the UI host's frame step 8; never throws */
  project(root: AnchorRoot): void {
    const els = root.querySelectorAll(SELECTOR) as ArrayLike<AnchorElement>;
    const n = els.length;
    if (n === 0) return;

    let camera: { readonly eye: Vec3; readonly aim: Vec3 } | null = null;
    let width = 0;
    let height = 0;
    let left = 0;
    let top = 0;
    try {
      camera = this.#deps.camera();
      const field = this.#deps.viewport();
      width = field.width;
      height = field.height;
      left = field.left ?? 0;
      top = field.top ?? 0;
    } catch {
      camera = null;
    }
    const live = camera !== null && width > 0 && height > 0 && Number.isFinite(left) && Number.isFinite(top);

    for (let i = 0; i < n; i++) {
      const el = els[i]!;
      let shown = false;
      if (live) {
        try {
          shown = this.#place(el, camera!, width, height, left, top);
        } catch {
          shown = false; // a row accessor or the projector threw: this anchor only
        }
      }
      if (!shown) hide(el.style);
    }
  }

  /** true when the element was placed; false when it has to be hidden */
  #place(el: AnchorElement, camera: { readonly eye: Vec3; readonly aim: Vec3 }, width: number, height: number, left: number, top: number): boolean {
    const id = el.getAttribute('data-world-anchor');
    if (id === null || id === '') return false;
    const row = this.#deps.getObject(id);
    if (row === null || row === undefined) return false;

    const feet = row.worldFeetPosition ?? row.feetPosition;
    const offsetText = el.getAttribute('data-anchor-offset');
    const offset = offsetText === null ? null : this.#offset(offsetText);
    const p = this.#point;
    if (offset !== null) {
      p.x = feet.x + offset.x;
      p.y = feet.y + offset.y;
      p.z = feet.z + offset.z;
    } else {
      const bounds = row.bounds;
      if (bounds === undefined || bounds === null) return false;
      p.x = feet.x;
      p.y = bounds.max.y;
      p.z = feet.z;
    }

    const { eye, aim } = camera;
    const dx = p.x - eye.x;
    const dy = p.y - eye.y;
    const dz = p.z - eye.z;
    // in front of the camera; false for NaN too
    if (!(dx * aim.x + dy * aim.y + dz * aim.z > 0)) return false;
    const depth = Math.sqrt(dx * dx + dy * dy + dz * dz);

    const at = this.#deps.project(p);
    if (at === null || at === undefined) return false;
    const x = at.x;
    const y = at.y;
    // the field extended by the margin; false for NaN and ±Infinity
    if (!(x >= -ANCHOR_MARGIN * width && x <= (1 + ANCHOR_MARGIN) * width && y >= -ANCHOR_MARGIN * height && y <= (1 + ANCHOR_MARGIN) * height)) return false;

    const style = el.style;
    if (style.position !== 'fixed') style.position = 'fixed';
    if (style.left !== '0px') style.left = '0px';
    if (style.top !== '0px') style.top = '0px';
    style.transform = `translate3d(${round2(left + x)}px, ${round2(top + y)}px, 0)`;
    const metres = String(round2(depth));
    if (style.getPropertyValue(DEPTH_VAR) !== metres) style.setProperty(DEPTH_VAR, metres);
    if (style.visibility !== '') style.visibility = '';
    return true;
  }

  #offset(text: string): Vec3 | null {
    const hit = this.#offsets.get(text);
    if (hit !== undefined) return hit;
    const parsed = parseAnchorOffset(text);
    if (this.#offsets.size >= OFFSET_CACHE_MAX) this.#offsets.clear();
    this.#offsets.set(text, parsed);
    return parsed;
  }
}
