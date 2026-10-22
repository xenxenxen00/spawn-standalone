// The `outline` style of `highlightSet` (K13b; engine api-reference.md:678, :654): `highlightSet { target, color?, style = "outline",
// duration?, width?, intensity? }`, "width is in pixels of a 1080p picture; when omitted it is 2 for outline".
//
// HOW. The inverted hull: an overlay sharing the model's geometry, skeleton and bind matrix (highlight.ts) drawn with back faces
// only, every vertex pushed outward in clip space along its screen-space normal by `width` pixels of a 1080-high picture (the
// push is a share of the picture's height, so the line keeps its share at any resolution, and it is scaled by the vertex's
// clip `w`, so it is the same number of pixels near and far). The direction is the geometric normal, not `normalView`, which three
// flips on back faces (that would push the hull inward). The hull is depth tested against the world and the target's own
// body (it draws after the body, highlight.ts `HIGHLIGHT_VISIBLE_ORDER`), so only the rim around the silhouette shows and a wall
// in front hides it: unlike `xray`, an outline does not show through walls. The part mask of the look table applies.
//
// Per-object values (colour, width, opacity) are read from the same `userData` record as the other styles (`'ssHighlight'`).
// One material, one program per object kind: `HighlightRenderer.warmObjects()` includes it when the host enabled outlines.
import { BackSide, CustomBlending, AddEquation, LessEqualDepth, Color, MeshBasicNodeMaterial, OneMinusSrcAlphaFactor, SrcAlphaFactor } from 'three/webgpu';
import type { Object3D } from 'three/webgpu';
import { cameraProjectionMatrix, modelViewMatrix, normalViewGeometry, positionLocal, uniform, vec2, vec4, viewportSize } from 'three/tsl';
import { partKeepNode, type LookTable } from '../surface/look-table.ts';

/** `object.userData` key shared with highlight.ts (`HIGHLIGHT_KEY`) */
const KEY = 'ssHighlight';

/** [I] and docs: the default `width` of an outline, in pixels of a 1080p picture (api-reference.md:654) */
export const OUTLINE_DEFAULT_WIDTH_PX = 2;
/** the picture height the width is measured against */
export const OUTLINE_REFERENCE_HEIGHT = 1080;
/** [I] opacity of an outline whose `intensity` is not given */
export const OUTLINE_DEFAULT_ALPHA = 1;

export interface OutlineValues {
  color: Color;
  /** pixels of a 1080p picture */
  width?: number;
  /** 0..1 */
  alpha?: number;
}

const WHITE = new Color(1, 1, 1);
const values = (object: Object3D | null): OutlineValues | undefined => object?.userData[KEY] as OutlineValues | undefined;

const outlineColor = uniform(new Color(1, 1, 1)).setName('ssOutlineColor').onObjectUpdate(({ object }) => values(object as Object3D | null)?.color ?? WHITE);
const outlineWidth = uniform(OUTLINE_DEFAULT_WIDTH_PX).setName('ssOutlineWidth').onObjectUpdate(({ object }) => values(object as Object3D | null)?.width ?? OUTLINE_DEFAULT_WIDTH_PX);
const outlineAlpha = uniform(OUTLINE_DEFAULT_ALPHA).setName('ssOutlineAlpha').onObjectUpdate(({ object }) => values(object as Object3D | null)?.alpha ?? OUTLINE_DEFAULT_ALPHA);

/** the clip-space offset (NDC units per unit of clip `w`) of one outline pixel count: 2 NDC units are the picture's height */
export function outlineNdcPerPixel(): number {
  return 2 / OUTLINE_REFERENCE_HEIGHT;
}

/** `partMask: false`: a hull for meshes without the model part attribute (`ss`): the map's scripted rows (`HighlightHost.rowMeshes`) */
export function buildOutlineMaterial(look: LookTable, opts: { partMask?: boolean } = {}): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  m.name = opts.partMask === false ? 'ss:highlight:outline:row' : 'ss:highlight:outline';
  m.colorNode = outlineColor;
  m.opacityNode = outlineAlpha;
  const local = opts.partMask === false ? positionLocal : positionLocal.mul(partKeepNode(look));
  const clip = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(local, 1));
  const nClip = cameraProjectionMatrix.mul(vec4(normalViewGeometry, 0)).xy;
  const dir = nClip.div(nClip.length().max(1e-5));
  // x is stretched by the aspect so a pixel is a pixel on both axes
  const ndc = vec2(viewportSize.y.div(viewportSize.x), 1).mul(outlineWidth.mul(outlineNdcPerPixel()));
  const push = dir.mul(ndc).mul(clip.w);
  m.vertexNode = vec4(clip.x.add(push.x), clip.y.add(push.y), clip.z, clip.w);
  m.fog = false;
  m.side = BackSide;
  m.depthWrite = false;
  m.depthTest = true;
  m.depthFunc = LessEqualDepth;
  m.transparent = false;
  m.blending = CustomBlending;
  m.blendEquation = AddEquation;
  m.blendSrc = SrcAlphaFactor;
  m.blendDst = OneMinusSrcAlphaFactor;
  return m;
}
