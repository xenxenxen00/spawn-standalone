// Teammate highlights (docs/architecture.md X-47, §3.1, §9.3 RH1; `docs/analysis/system-rendering-look.md` Appendix C.1, C.3;
// `docs/analysis/spawn-engine-contract.md` §40): the renderer behind the engine acts `highlightSet` / `highlightClear`.
//
// The game (authored content, on the local player's machine only) marks every teammate twice a
// second, and sends a mark only when it changes: alive `{ color: 'oklch(0.85 0.13 200)', style: 'xray' }`, down or
// spectating `{ color: 'oklch(0.65 0.24 25)', style: 'pulse' }`, and `highlightClear { target }` when the teammate row is gone.
// The marks are state, kept outside the renderer by src/app/act-wiring.ts (the latest per target, dropped on clear and on the
// row's destruction) and handed here whole when this renderer attaches (`reset`), then change by change (`set`, `clear`).
// So a mark sent before the engine exists shows once it does, and a renderer rebuild (X3) gets the table again.
//
// Only the two styles the game sends are drawn. The engine's `outline` and `glow` (`api-reference.md:621`) have no live
// caller: they, a missing style and any other value are refused with one log line per style, and the target is left
// unmarked. How Spawn draws `xray` and `pulse` was not captured [I]; the port draws:
//
//   xray    a flat silhouette in the mark's colour, only where something hides the teammate (the depth test fails), and
//           nothing where he stands in plain view: "drawn only where a wall hides them" (`team-glow.js:3`)
//   pulse   the same silhouette where he is hidden plus a tint over the body where he is in view, both pulsing on the
//           presentation clock (`shaderTime`: frozen while the game is paused or in hitstop), so a downed teammate reads
//           anywhere on screen
//
// Every look constant is in `HIGHLIGHT_LOOK` (tuned by eye, X-27).
//
// HOW THE HIDDEN PART IS FOUND. An overlay mesh shares the target model's geometry, skeleton and bind matrix (a sibling of
// the model's own mesh under its root, so it moves, animates and is shown or hidden with it) and draws with `depthFunc`
// GREATER, without depth write, in the opaque list. Ordering does the rest: the silhouette draws after the world
// (`HIGHLIGHT_RENDER_ORDER`, above every map, prop and bucket order) and BEFORE the teammate's own body, whose meshes the
// renderer moves one order later while the mark lasts (and puts back on clear). So the depth it tests against is the world's
// without the teammate: where a wall is in front of him the test passes, where only the floor or the sky is behind him it
// fails, and his own limbs never hide each other. Silhouettes write no depth, so they are ordered far to near among
// themselves (`HighlightHost.eye`; fractional orders below the body's) and a nearer one lies over a farther one. The pulse's
// tint over the body draws after the body (`… + 2`) with
// LESS_EQUAL and a polygon offset toward the camera, so it covers the visible surface once.
//
// THE PART MASK AND LOOKS. The silhouette's position stage multiplies by the model's part-mask factor (look-table.ts
// `partKeepNode`: the same `ss` attribute and per-object `ssLookRow` as the model surface), so a part `setParts` hides is
// not outlined either. Slot and part looks change colours only: the silhouette ignores them. A model swap (a new instance
// for the row: another kit, a re-dress the instance could not take) is seen in `update()` by identity, and the overlays
// move to the new instance; a destroyed row loses its mark through the act wiring.
//
// PROGRAMS (render §7.2; the warm-up rule: no program after the LOADING release). The silhouette's colour and pulse switch
// are per-object uniforms (`onObjectUpdate`), and its two materials (`hidden`, `visible`) are one node graph with different
// depth and blend state, so every mark of every target draws with the programs of `warmObjects()` (a plain mesh and one
// skinned mesh per bone-count class, each with and without `uv`, per material), which the game's engine-load warm-up
// compiles against the scene-pass target (src/render/world/install.ts `warmHighlights`). A mark set, changed or cleared after
// that creates no program.
//
// Draw calls (render §15.5): one per marked target (`xray`), two for `pulse` (hidden + visible), plus nothing for a target
// whose model has not loaded yet (its mark waits). Five outlined teammates: 5 draws.
import {
  Color, CustomBlending, FrontSide, GreaterDepth, LessEqualDepth, Matrix4, Mesh, MeshBasicNodeMaterial, OneMinusSrcAlphaFactor, SrcAlphaFactor, AddEquation, Skeleton, Bone, SkinnedMesh,
} from 'three/webgpu';
import type { BufferGeometry, Object3D } from 'three/webgpu';
import { float, mix, positionLocal, sin, uniform } from 'three/tsl';
import type { RowNodeView } from '../bridge/bridge-types.ts';
import { cssToLinear } from '../color/color.ts';
import { BONE_CLASSES } from '../models/model-template.ts';
import { proxyGeometry } from '../models/shader-variants.ts';
import { shaderTime } from '../shader-time.ts';
import { LOOK_ROW_KEY, partKeepNode, type LookTable } from '../surface/look-table.ts';
import { OUTLINE_DEFAULT_ALPHA, OUTLINE_DEFAULT_WIDTH_PX, buildOutlineMaterial } from './highlight-outline.ts';

/** the look constants of both styles [I, tuned by eye] */
export const HIGHLIGHT_LOOK = Object.freeze({
  /** the `xray` silhouette's opacity over what hides the teammate */
  xrayAlpha: 0.85,
  /** the `pulse` period, seconds of presentation time */
  pulsePeriodS: 1.1,
  /** the `pulse` opacity at the bottom and the top of its wave */
  pulseMin: 0.15,
  pulseMax: 0.9,
  /** the pulse's tint over the visible body, relative to the hidden silhouette */
  visibleScale: 0.6,
  /** the visible tint's depth offset toward the camera (three's polygonOffset factor, units) */
  offsetFactor: -1,
  offsetUnits: -4,
  /** a mark whose colour does not parse */
  fallbackColor: '#ffffff',
});

/**
 * the hidden silhouette's render order: above every order the world uses (a row's `renderOrder` is small). Within it, the
 * silhouettes are spread over [order, order + 0.5) far to near (`HighlightHost.eye`): they write no depth, so the draw order
 * decides which lies on top where two overlap
 */
export const HIGHLIGHT_RENDER_ORDER = 1_000_000;
/** a marked target's own meshes, while the mark lasts */
export const HIGHLIGHT_BODY_ORDER = HIGHLIGHT_RENDER_ORDER + 1;
/** the pulse's tint over the visible body */
export const HIGHLIGHT_VISIBLE_ORDER = HIGHLIGHT_RENDER_ORDER + 2;

/** the styles drawn (the two the game sends; `outline` when the host enables it, K13b) */
export type HighlightStyle = 'xray' | 'pulse' | 'outline';

/** the act's payload as the wiring keeps it (src/app/act-wiring.ts `HighlightMark`) */
export interface HighlightMarkInput {
  color: unknown;
  style: unknown;
  /** K13b, `outline` only: pixels of a 1080p picture (default 2), seconds until the mark clears itself (default: never), opacity 0..1 (default 1) */
  width?: unknown;
  duration?: unknown;
  intensity?: unknown;
}

/** src/app/act-wiring.ts `HighlightSink`, structurally (render does not import the app layer) */
export interface HighlightSinkLike {
  reset(marks: ReadonlyMap<string, HighlightMarkInput>): void;
  set(target: string, mark: HighlightMarkInput): void;
  clear(target: string): void;
}

export interface HighlightHost {
  /** the render bridge's view of a row (`RenderBridge.node`) */
  node(rowId: string): RowNodeView | undefined;
  /** the model look table (the part mask the silhouette honours) */
  look: LookTable;
  /** the camera's world position: hidden silhouettes are drawn far to near, so a nearer one lies over a farther one */
  eye?: () => { x: number; y: number; z: number } | null;
  log?: (message: string) => void;
  /**
   * K13b: draw the engine's `outline` style (also the default of a mark with no style, api-reference.md:678). Default false: the legacy host
   * refuses it with one log line, as before.
   */
  outline?: boolean;
  /**
   * Opt-in, with `outline`: the meshes a row without a model draws with (a scripted row of the map, `RenderBridgeControl.rowMeshes`).
   * null while the row has none of its own yet (a batched row is promoted by the call; its meshes arrive on a later frame).
   * An `outline` mark on such a row hulls these meshes. Absent: the legacy host, only model rows are outlined
   */
  rowMeshes?(rowId: string): readonly Mesh[] | null;
}

export interface HighlightStats {
  /** marks held (drawn or waiting for their model) */
  marks: number;
  /** targets with overlays in the scene */
  drawn: number;
  /** overlay meshes in the scene */
  overlays: number;
  /** marks refused (a style the port does not draw) */
  refused: number;
}

/** `object.userData` key of an overlay's per-object values */
export const HIGHLIGHT_KEY = 'ssHighlight';

interface OverlayValues {
  color: Color;
  /** 1 for `pulse` */
  pulse: number;
  /** `outline`: pixels of a 1080p picture, and opacity */
  width?: number;
  alpha?: number;
}

/** what the renderer reads of a model instance (src/render/models/model-instance.ts `ModelInstance`) */
interface ModelLike {
  readonly root: Object3D;
  readonly opaqueMesh?: Mesh | SkinnedMesh;
  readonly lookRow?: number;
  readonly disposed?: boolean;
}

interface Entry {
  style: HighlightStyle;
  values: OverlayValues;
  /** the model the overlays hang on; null: not built (no node or no model yet) */
  model: ModelLike | null;
  source: Mesh | SkinnedMesh | null;
  overlays: Mesh[];
  /** the target's meshes this renderer re-ordered, with their own order */
  bodies: Map<Mesh, number>;
  /** K13b: seconds left of a timed mark; null = until cleared */
  remaining?: number | null;
  /** `rowMeshes`: the scripted row's meshes the overlays hull (one overlay each); null on a model row */
  rowSources?: readonly Mesh[] | null;
}

const WHITE = new Color(1, 1, 1);

// the per-object uniforms every overlay shares (three updates them before each draw, as `ssLookRow`)
const highlightColor = uniform(new Color(1, 1, 1))
  .setName('ssHighlightColor')
  .onObjectUpdate(({ object }) => ((object as Object3D | null)?.userData[HIGHLIGHT_KEY] as OverlayValues | undefined)?.color ?? WHITE);
const highlightPulse = uniform(0)
  .setName('ssHighlightPulse')
  .onObjectUpdate(({ object }) => ((object as Object3D | null)?.userData[HIGHLIGHT_KEY] as OverlayValues | undefined)?.pulse ?? 0);

/**
 * One of the two silhouette materials. Both are the same node graph (one program per object kind); `pass` sets only the
 * depth and blend state, and the opacity scale is a uniform value.
 */
export function buildHighlightMaterial(look: LookTable, pass: 'hidden' | 'visible'): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  m.name = `ss:highlight:${pass}`;
  const scale = uniform(pass === 'visible' ? HIGHLIGHT_LOOK.visibleScale : 1);
  const wave = sin(shaderTime.mul((2 * Math.PI) / HIGHLIGHT_LOOK.pulsePeriodS)).mul(0.5).add(0.5);
  const pulsing = mix(float(HIGHLIGHT_LOOK.pulseMin), float(HIGHLIGHT_LOOK.pulseMax), wave);
  m.colorNode = highlightColor;
  m.opacityNode = mix(float(HIGHLIGHT_LOOK.xrayAlpha), pulsing, highlightPulse).mul(scale);
  m.positionNode = positionLocal.mul(partKeepNode(look));
  m.fog = false;
  m.side = FrontSide;
  m.depthWrite = false;
  m.depthTest = true;
  m.depthFunc = pass === 'hidden' ? GreaterDepth : LessEqualDepth;
  if (pass === 'visible') {
    m.polygonOffset = true;
    m.polygonOffsetFactor = HIGHLIGHT_LOOK.offsetFactor;
    m.polygonOffsetUnits = HIGHLIGHT_LOOK.offsetUnits;
  }
  // in the opaque list (so the render order puts it between the world and the body) yet blended: custom blending keeps the
  // alpha the opaque path would force to 1 (NodeMaterial `isOpaque`)
  m.transparent = false;
  m.blending = CustomBlending;
  m.blendEquation = AddEquation;
  m.blendSrc = SrcAlphaFactor;
  m.blendDst = OneMinusSrcAlphaFactor;
  return m;
}

const isMesh = (o: Object3D): o is Mesh => (o as Mesh).isMesh === true;

/** K13b: the `outline` mark's own fields with the docs' defaults */
function outlineExtras(mark: HighlightMarkInput): { width: number; alpha: number; duration: number | null } {
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  return {
    width: fin(mark.width) && mark.width > 0 ? mark.width : OUTLINE_DEFAULT_WIDTH_PX,
    alpha: fin(mark.intensity) ? Math.min(1, Math.max(0, mark.intensity)) : OUTLINE_DEFAULT_ALPHA,
    duration: fin(mark.duration) && mark.duration > 0 ? mark.duration : null,
  };
}

/** the mark's colour, linear; null when it does not parse */
export function highlightColorOf(color: unknown): Color | null {
  if (typeof color === 'string') {
    const lin = cssToLinear(color);
    return lin === null ? null : new Color(lin[0], lin[1], lin[2]);
  }
  if (typeof color === 'number' && Number.isFinite(color)) return new Color().setHex(color & 0xffffff, 'srgb');
  return null;
}

/** The `highlightSet` / `highlightClear` renderer (see the header). Call `update()` once per frame, after the bridge. */
export class HighlightRenderer implements HighlightSinkLike {
  readonly #host: HighlightHost;
  readonly #log: (message: string) => void;
  readonly #entries = new Map<string, Entry>();
  readonly #warned = new Set<string>();
  readonly hidden: MeshBasicNodeMaterial;
  readonly visible: MeshBasicNodeMaterial;
  /** K13b: the outline hull, built only when the host enabled outlines */
  readonly outlineMaterial: MeshBasicNodeMaterial | null;
  /** the hull for scripted rows (no part mask), built only with `outline` and `rowMeshes` */
  readonly rowOutlineMaterial: MeshBasicNodeMaterial | null;
  #refused = 0;
  #disposed = false;
  #warmGeometries: BufferGeometry[] = [];

  constructor(host: HighlightHost) {
    this.#host = host;
    this.#log = host.log ?? ((m) => console.warn(m));
    this.hidden = buildHighlightMaterial(host.look, 'hidden');
    this.visible = buildHighlightMaterial(host.look, 'visible');
    this.outlineMaterial = host.outline === true ? buildOutlineMaterial(host.look) : null;
    this.rowOutlineMaterial = host.outline === true && host.rowMeshes !== undefined ? buildOutlineMaterial(host.look, { partMask: false }) : null;
  }

  #warn(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    if (this.#warned.size < 64) this.#warned.add(key);
    this.#log(`[highlight] ${message}`);
  }

  // ── the sink ────────────────────────────────────────────────────────────────────────────────────────────────────────

  reset(marks: ReadonlyMap<string, HighlightMarkInput>): void {
    for (const id of [...this.#entries.keys()]) this.clear(id);
    for (const [id, mark] of marks) this.set(id, mark);
  }

  set(target: string, mark: HighlightMarkInput): void {
    if (this.#disposed) return;
    // K13b: with outlines on, a mark with no style is the engine's default, an outline
    const style = this.outlineMaterial !== null && mark.style === undefined ? 'outline' : mark.style;
    if (style !== 'xray' && style !== 'pulse' && !(style === 'outline' && this.outlineMaterial !== null)) {
      // a new mark replaces the old one: a refused mark leaves the target unmarked
      this.clear(target);
      this.#refused++;
      const shown = typeof style === 'string' ? `'${style}'` : String(style);
      this.#warn(`style:${shown}`, `highlightSet style ${shown} is not drawn (the port draws 'xray' and 'pulse', the two the game sends)`);
      return;
    }
    let color = highlightColorOf(mark.color);
    if (color === null) {
      this.#warn(`color:${String(mark.color)}`, `highlightSet colour ${JSON.stringify(mark.color)} does not parse; drawn in ${HIGHLIGHT_LOOK.fallbackColor}`);
      color = highlightColorOf(HIGHLIGHT_LOOK.fallbackColor)!;
    }
    const entry = this.#entries.get(target);
    const outline = style === 'outline' ? outlineExtras(mark) : null;
    if (entry !== undefined) {
      entry.values.color.copy(color);
      entry.values.pulse = style === 'pulse' ? 1 : 0;
      if (outline !== null) {
        entry.values.width = outline.width;
        entry.values.alpha = outline.alpha;
      }
      entry.remaining = outline === null ? null : outline.duration;
      if (entry.style !== style) {
        // the pulse has a second overlay: rebuild on the next update
        this.#detach(entry);
        entry.style = style;
      }
      return;
    }
    const values: OverlayValues = { color, pulse: style === 'pulse' ? 1 : 0 };
    if (outline !== null) {
      values.width = outline.width;
      values.alpha = outline.alpha;
    }
    this.#entries.set(target, { style, values, model: null, source: null, overlays: [], bodies: new Map(), remaining: outline === null ? null : outline.duration });
  }

  clear(target: string): void {
    const entry = this.#entries.get(target);
    if (entry === undefined) return;
    this.#detach(entry);
    this.#entries.delete(target);
  }

  // ── per frame ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Builds, moves and refreshes the overlays (once per frame, after the bridge placed the rows and before the draw). `dtS` is the
   * frame's presentation seconds; only a timed mark (K13b `duration`) uses it.
   */
  update(dtS = 0): void {
    if (this.#disposed) return;
    if (dtS > 0) {
      for (const [id, entry] of [...this.#entries]) {
        if (entry.remaining === null || entry.remaining === undefined) continue;
        entry.remaining -= dtS;
        if (entry.remaining <= 0) this.clear(id);
      }
    }
    const eye = this.#host.eye?.() ?? null;
    const drawn: Array<{ entry: Entry; d: number }> = [];
    for (const [id, entry] of this.#entries) {
      const node = this.#host.node(id);
      const model = (node?.model ?? null) as ModelLike | null;
      const source = model !== null && model.disposed !== true ? (model.opaqueMesh ?? null) : null;
      if ((source === null || source.parent === null) && entry.style === 'outline' && this.rowOutlineMaterial !== null) {
        this.#updateRow(id, entry);
        continue;
      }
      if (source === null || source.parent === null) {
        // no row yet (a mark sent before the engine), no model yet (it loads), or the row lost its model: wait
        if (entry.model !== null) this.#detach(entry);
        continue;
      }
      if (entry.model !== model || entry.source !== source) {
        this.#detach(entry);
        this.#attach(entry, model!, source);
      }
      const row = model!.lookRow ?? 0;
      for (const o of entry.overlays) {
        if (o.parent !== source.parent) source.parent!.add(o);
        o.userData[LOOK_ROW_KEY] = row;
        o.layers.mask = source.layers.mask;
        o.visible = source.visible;
        o.frustumCulled = source.frustumCulled;
        // a skinned mesh culls with its own sphere (three computes it from the bones): share the model's; a plain mesh
        // culls with the shared geometry's
        const sphere = (source as SkinnedMesh).boundingSphere as SkinnedMesh['boundingSphere'] | undefined;
        if (sphere !== undefined && sphere !== null && (o as SkinnedMesh).isSkinnedMesh === true) (o as SkinnedMesh).boundingSphere = sphere;
        o.position.copy(source.position);
        o.quaternion.copy(source.quaternion);
        o.scale.copy(source.scale);
      }
      if (eye !== null) {
        const e = source.parent!.matrixWorld.elements;
        drawn.push({ entry, d: (e[12]! - eye.x) ** 2 + (e[13]! - eye.y) ** 2 + (e[14]! - eye.z) ** 2 });
      }
      // the target's own meshes draw after the hidden silhouette (see the header); gear hung on the row later is caught too
      const body = node!.object ?? model!.root;
      body.traverse((o) => {
        if (!isMesh(o) || o.userData[HIGHLIGHT_KEY] !== undefined || entry.bodies.has(o)) return;
        entry.bodies.set(o, o.renderOrder);
        o.renderOrder = HIGHLIGHT_BODY_ORDER;
      });
    }
    // far to near: the farthest hidden silhouette first (the opaque list would otherwise draw them near to far)
    drawn.sort((a, b) => b.d - a.d);
    drawn.forEach(({ entry }, i) => {
      const hidden = entry.overlays[0];
      if (hidden !== undefined) hidden.renderOrder = HIGHLIGHT_RENDER_ORDER + (0.5 * i) / drawn.length;
    });
  }

  /** an `outline` on a scripted row (`rowMeshes`): one hull per mesh of the row, as its sibling, carrying the mesh's own matrix */
  #updateRow(id: string, entry: Entry): void {
    const sources = this.#host.rowMeshes?.(id) ?? null;
    if (sources === null || sources.length === 0) {
      if (entry.overlays.length > 0 || entry.model !== null) this.#detach(entry);
      return;
    }
    const held = entry.rowSources ?? null;
    const same = held !== null && held.length === sources.length && sources.every((m, i) => held[i] === m);
    if (!same || entry.model !== null) {
      this.#detach(entry);
      entry.rowSources = [...sources];
      for (const src of sources) entry.overlays.push(this.#overlay(src, this.rowOutlineMaterial!, HIGHLIGHT_VISIBLE_ORDER, entry.values));
    }
    sources.forEach((src, i) => {
      const o = entry.overlays[i]!;
      if (src.parent === null) {
        o.removeFromParent();
        return;
      }
      if (o.parent !== src.parent) src.parent.add(o);
      o.matrixAutoUpdate = false;
      o.matrix.copy(src.matrix);
      o.matrixWorldNeedsUpdate = true;
      o.layers.mask = src.layers.mask;
      o.visible = src.visible;
      o.frustumCulled = src.frustumCulled;
      const sphere = (src as SkinnedMesh).boundingSphere as SkinnedMesh['boundingSphere'] | undefined;
      if (sphere !== undefined && sphere !== null && (o as SkinnedMesh).isSkinnedMesh === true) (o as SkinnedMesh).boundingSphere = sphere;
    });
  }

  #overlay(source: Mesh | SkinnedMesh, material: MeshBasicNodeMaterial, order: number, values: OverlayValues): Mesh {
    const skinned = (source as SkinnedMesh).isSkinnedMesh === true;
    let o: Mesh;
    if (skinned) {
      const src = source as SkinnedMesh;
      const s = new SkinnedMesh(src.geometry, material);
      s.bindMode = src.bindMode;
      s.bind(src.skeleton, src.bindMatrix);
      o = s;
    } else o = new Mesh(source.geometry, material);
    o.name = `ss:highlight:${material === this.hidden ? 'hidden' : material === this.visible ? 'visible' : material === this.rowOutlineMaterial ? 'outline:row' : 'outline'}`;
    o.renderOrder = order;
    o.castShadow = false;
    o.receiveShadow = false;
    o.userData[HIGHLIGHT_KEY] = values;
    return o;
  }

  #attach(entry: Entry, model: ModelLike, source: Mesh | SkinnedMesh): void {
    entry.model = model;
    entry.source = source;
    if (entry.style === 'outline') {
      entry.overlays.push(this.#overlay(source, this.outlineMaterial!, HIGHLIGHT_VISIBLE_ORDER, entry.values));
      return;
    }
    entry.overlays.push(this.#overlay(source, this.hidden, HIGHLIGHT_RENDER_ORDER, entry.values));
    if (entry.style === 'pulse') entry.overlays.push(this.#overlay(source, this.visible, HIGHLIGHT_VISIBLE_ORDER, entry.values));
    // K13b: the hull draws after the body, which only shows its rim
  }

  #detach(entry: Entry): void {
    for (const o of entry.overlays.splice(0)) o.removeFromParent();
    for (const [mesh, order] of entry.bodies) if (mesh.renderOrder === HIGHLIGHT_BODY_ORDER) mesh.renderOrder = order;
    entry.bodies.clear();
    entry.model = null;
    entry.source = null;
    entry.rowSources = null;
  }

  // ── the warm-up ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Stand-ins for every program a silhouette can draw with (see the header): per material, a plain mesh and a skinned mesh
   * per bone-count class, each with and without `uv` (the attribute sets of model templates). For the engine-load warm-up
   * (`compileAsync` under the warm-up rule, against the scene-pass target).
   */
  warmObjects(): Object3D[] {
    if (this.#disposed) return [];
    const out: Object3D[] = [];
    const materials = [this.hidden, this.visible, ...(this.outlineMaterial === null ? [] : [this.outlineMaterial]), ...(this.rowOutlineMaterial === null ? [] : [this.rowOutlineMaterial])];
    for (const material of materials) {
      for (const withUv of [false, true]) {
        const plain = proxyGeometry(false, withUv);
        this.#warmGeometries.push(plain);
        const mesh = new Mesh(plain, material);
        mesh.name = `ss:warm-up:${material.name}:mesh${withUv ? ':uv' : ''}`;
        out.push(mesh);
        for (const count of BONE_CLASSES) {
          const g = proxyGeometry(true, withUv);
          this.#warmGeometries.push(g);
          const s = new SkinnedMesh(g, material);
          const bone = new Bone();
          s.add(bone);
          s.bind(new Skeleton(Array.from({ length: count }, () => bone), Array.from({ length: count }, () => new Matrix4())), new Matrix4());
          s.boundingSphere = g.boundingSphere!.clone();
          s.name = `ss:warm-up:${material.name}:skinned${count}${withUv ? ':uv' : ''}`;
          out.push(s);
        }
      }
    }
    return out;
  }

  /** the warm-up's stand-in geometries are not needed after it ran */
  releaseWarmObjects(): void {
    for (const g of this.#warmGeometries.splice(0)) g.dispose();
  }

  // ── state ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** the overlays of a target, for tests and tools */
  overlaysOf(target: string): readonly Mesh[] {
    return this.#entries.get(target)?.overlays ?? [];
  }

  /** the style held for a target; null: none */
  styleOf(target: string): HighlightStyle | null {
    return this.#entries.get(target)?.style ?? null;
  }

  stats(): HighlightStats {
    let drawn = 0;
    let overlays = 0;
    for (const e of this.#entries.values()) {
      if (e.overlays.length > 0) drawn++;
      overlays += e.overlays.length;
    }
    return { marks: this.#entries.size, drawn, overlays, refused: this.#refused };
  }

  dispose(): void {
    if (this.#disposed) return;
    for (const entry of this.#entries.values()) this.#detach(entry);
    this.#entries.clear();
    this.releaseWarmObjects();
    this.hidden.dispose();
    this.visible.dispose();
    this.outlineMaterial?.dispose();
    this.rowOutlineMaterial?.dispose();
    this.#disposed = true;
  }
}
