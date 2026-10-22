// The screen disc (opt-in, `createRenderer({ atmosphere: { screenDisc } })`): a soft round glow pinned to a spot of the screen,
// drawn behind every depth-writing row and in front of anything that writes no depth.
//
// Why: a side-view world may hang a full-screen backdrop plane far behind the play (an opaque scripted material with
// `depthWrite = false`). The sky node is drawn before the scene (three's background), so the backdrop covers its moon or sun
// disc. The original shows the disc over such a backdrop, at a fixed place on the screen whatever the camera height, and
// behind the rows that write depth. That is a far, camera-locked card drawn after the opaque pass and depth-tested: this.
//
// The card is a quad that follows the rendering camera (`onBeforeRender`), placed by unprojecting its NDC spot at
// the depth `depth` (NDC z), so it works for a perspective and an orthographic camera. `radius` is a fraction of the view
// height. The colour is linear HDR and goes through the post chain like any row. It casts and receives no shadow, has no fog,
// and is never frustum-culled.
import { DoubleSide, Mesh, MeshBasicNodeMaterial, PlaneGeometry, Vector3 } from 'three/webgpu';
import type { Camera } from 'three/webgpu';
import { float, smoothstep, uv, vec3 } from 'three/tsl';

export interface ScreenDiscOptions {
  /** the disc's centre in NDC, [-1, 1] each; default [0.5, 0.5] (the upper right quarter's centre) */
  ndc?: readonly [number, number];
  /** the disc's radius as a fraction of the view height; default 0.045 */
  radius?: number;
  /** the fraction of the radius that fades out at the edge, 0..1; default 0.5 */
  softness?: number;
  /** linear rgb; default [1, 1, 1] */
  color?: readonly [number, number, number];
  /** the centre's opacity, 0..1; default 1 */
  opacity?: number;
  /** NDC depth of the card, in (-1, 1); default 0.999 (just inside the far plane) */
  depth?: number;
}

export interface ResolvedScreenDisc {
  ndc: [number, number];
  radius: number;
  softness: number;
  color: [number, number, number];
  opacity: number;
  depth: number;
}

const num = (v: unknown, d: number, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** the options with every default filled and every number clamped to its range */
export function resolveScreenDisc(o: ScreenDiscOptions): ResolvedScreenDisc {
  const c = Array.isArray(o.color) && o.color.length === 3 ? o.color : [1, 1, 1];
  const n = Array.isArray(o.ndc) && o.ndc.length === 2 ? o.ndc : [0.5, 0.5];
  return {
    ndc: [num(n[0], 0.5, -1, 1), num(n[1], 0.5, -1, 1)],
    radius: num(o.radius, 0.045, 0.001, 1),
    softness: num(o.softness, 0.5, 0, 1),
    color: [num(c[0], 1, 0, 1e4), num(c[1], 1, 0, 1e4), num(c[2], 1, 0, 1e4)],
    opacity: num(o.opacity, 1, 0, 1),
    depth: num(o.depth, 0.999, -0.999999, 0.999999),
  };
}

/**
 * Where the card goes for `camera` (its matrices current): the world centre and the world radius, both from unprojecting
 * NDC points at the card's depth (the radius is half of the NDC height 2 · radius, measured along the camera's up).
 */
export function placeScreenDisc(camera: Camera, d: ResolvedScreenDisc, centre = new Vector3(), edge = new Vector3()): { centre: Vector3; radius: number } {
  centre.set(d.ndc[0], d.ndc[1], d.depth).unproject(camera);
  edge.set(d.ndc[0], d.ndc[1] + 2 * d.radius, d.depth).unproject(camera);
  return { centre, radius: centre.distanceTo(edge) };
}

export interface ScreenDisc {
  /** add it to the scene root (not under a moving parent) */
  readonly mesh: Mesh;
  readonly options: Readonly<ResolvedScreenDisc>;
  dispose(): void;
}

export function createScreenDisc(opts: ScreenDiscOptions): ScreenDisc {
  const d = resolveScreenDisc(opts);
  const material = new MeshBasicNodeMaterial();
  material.name = 'ss:screen-disc';
  // r = 0 at the centre, 1 at the rim; opacity falls over the outer `softness` of the radius
  const r = uv().sub(0.5).length().mul(2);
  const inner = Math.max(0, 1 - d.softness - 1e-4);
  material.colorNode = vec3(...d.color);
  material.opacityNode = float(1).sub(smoothstep(inner, 1, r)).mul(d.opacity);
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = true;
  material.fog = false;
  material.side = DoubleSide;
  const mesh = new Mesh(new PlaneGeometry(2, 2), material);
  mesh.name = 'ss:screen-disc';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  const centre = new Vector3();
  const edge = new Vector3();
  // the rendering camera places the card (in world space: the card hangs from the scene root, whose matrix is the identity)
  mesh.onBeforeRender = (_r: unknown, _s: unknown, camera: Camera): void => {
    const p = placeScreenDisc(camera, d, centre, edge);
    mesh.position.copy(p.centre);
    camera.getWorldQuaternion(mesh.quaternion);
    mesh.scale.setScalar(p.radius);
    mesh.updateMatrix();
    mesh.matrixWorld.copy(mesh.matrix);
  };
  return {
    mesh,
    options: d,
    dispose() {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
