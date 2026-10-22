// The `flash` act (K8; engine api-reference.md:674): `flash { target, color?, duration = 0.1, intensity = 0.9 }`. The target
// row's body is tinted toward `color` (white when none is given [I]) with `intensity` as the mix at the start, fading linearly
// to nothing over `duration` seconds of presentation time. A second flash of the same target replaces the first.
//
// HOW. Like the highlight (highlight.ts): an overlay mesh sharing the model's geometry, skeleton and bind matrix, a sibling
// of the model's own mesh, drawn with ONE shared node material whose colour and mix are per-object uniforms. It blends over
// the body (alpha = the mix) with LESS_EQUAL and a polygon offset toward the camera, so it covers the visible surface once,
// and the part mask of the look table applies (a hidden part is not tinted). One draw per flashing target. The material is one
// program per object kind: `warmObjects()` gives the engine-load warm-up its stand-ins, so a flash after the loading gate
// creates no program.
import { AddEquation, Bone, Color, CustomBlending, FrontSide, LessEqualDepth, Matrix4, Mesh, MeshBasicNodeMaterial, OneMinusSrcAlphaFactor, Skeleton, SkinnedMesh, SrcAlphaFactor } from 'three/webgpu';
import type { BufferGeometry, Object3D } from 'three/webgpu';
import { positionLocal, uniform } from 'three/tsl';
import type { RowNodeView } from '../bridge/bridge-types.ts';
import { BONE_CLASSES } from '../models/model-template.ts';
import { proxyGeometry } from '../models/shader-variants.ts';
import { LOOK_ROW_KEY, partKeepNode, type LookTable } from '../surface/look-table.ts';
import { highlightColorOf } from './highlight.ts';

export const FLASH_DEFAULTS = Object.freeze({ duration: 0.1, intensity: 0.9, color: '#ffffff' });
/** above the highlight's orders: a flash covers a mark's tint too */
export const FLASH_RENDER_ORDER = 1_000_010;
/** `object.userData` key of an overlay's per-object values */
export const FLASH_KEY = 'ssFlash';

export interface FlashAct {
  target: string;
  /** linear */
  color: Color;
  duration: number;
  intensity: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function flashActOf(payload: unknown): FlashAct | null {
  if (!isObj(payload) || typeof payload['target'] !== 'string' || payload['target'] === '') return null;
  return {
    target: payload['target'],
    color: highlightColorOf(payload['color']) ?? highlightColorOf(FLASH_DEFAULTS.color)!,
    duration: fin(payload['duration']) && payload['duration'] > 0 ? payload['duration'] : FLASH_DEFAULTS.duration,
    intensity: fin(payload['intensity']) ? Math.min(1, Math.max(0, payload['intensity'])) : FLASH_DEFAULTS.intensity,
  };
}

/** the mix toward the flash colour `t` seconds in: `intensity` at the start, 0 from the end on */
export function flashMix(act: FlashAct, t: number): number {
  const u = t / act.duration;
  return u >= 1 ? 0 : act.intensity * (1 - Math.max(0, u));
}

interface OverlayValues {
  color: Color;
  mix: number;
}

const WHITE = new Color(1, 1, 1);
const flashColor = uniform(new Color(1, 1, 1))
  .setName('ssFlashColor')
  .onObjectUpdate(({ object }) => ((object as Object3D | null)?.userData[FLASH_KEY] as OverlayValues | undefined)?.color ?? WHITE);
const flashAlpha = uniform(0)
  .setName('ssFlashMix')
  .onObjectUpdate(({ object }) => ((object as Object3D | null)?.userData[FLASH_KEY] as OverlayValues | undefined)?.mix ?? 0);

export function buildFlashMaterial(look: LookTable): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  m.name = 'ss:flash';
  m.colorNode = flashColor;
  m.opacityNode = flashAlpha;
  m.positionNode = positionLocal.mul(partKeepNode(look));
  m.fog = false;
  m.side = FrontSide;
  m.depthWrite = false;
  m.depthTest = true;
  m.depthFunc = LessEqualDepth;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -4;
  // in the opaque list yet blended (as the highlight's tint): custom blending keeps the alpha an opaque material would force to 1
  m.transparent = false;
  m.blending = CustomBlending;
  m.blendEquation = AddEquation;
  m.blendSrc = SrcAlphaFactor;
  m.blendDst = OneMinusSrcAlphaFactor;
  return m;
}

export interface RowFlasherHost {
  node(rowId: string): RowNodeView | undefined;
  look: LookTable;
}

interface ModelLike {
  readonly root: Object3D;
  readonly opaqueMesh?: Mesh | SkinnedMesh;
  readonly lookRow?: number;
  readonly disposed?: boolean;
}

interface Running {
  act: FlashAct;
  t: number;
  values: OverlayValues;
  overlay: Mesh | null;
  source: Mesh | SkinnedMesh | null;
}

export class RowFlasher {
  readonly #host: RowFlasherHost;
  readonly #running = new Map<string, Running>();
  readonly material: MeshBasicNodeMaterial;
  #warmGeometries: BufferGeometry[] = [];
  #disposed = false;

  constructor(host: RowFlasherHost) {
    this.#host = host;
    this.material = buildFlashMaterial(host.look);
  }

  /** the `flash` act: false when the payload is unusable */
  flash(payload: unknown): boolean {
    if (this.#disposed) return false;
    const act = flashActOf(payload);
    if (act === null) return false;
    const old = this.#running.get(act.target);
    if (old !== undefined) {
      // the same overlay carries on with the new values
      old.act = act;
      old.t = 0;
      old.values.color.copy(act.color);
      old.values.mix = flashMix(act, 0);
      return true;
    }
    this.#running.set(act.target, { act, t: 0, values: { color: act.color.clone(), mix: flashMix(act, 0) }, overlay: null, source: null });
    return true;
  }

  /** advances the flashes by the frame's presentation seconds and places the overlays (once per frame, after the bridge) */
  update(dtS: number): void {
    if (this.#disposed) return;
    for (const [id, r] of this.#running) {
      r.t += Math.max(0, dtS);
      if (r.t >= r.act.duration) {
        this.#detach(r);
        this.#running.delete(id);
        continue;
      }
      r.values.mix = flashMix(r.act, r.t);
      const model = (this.#host.node(id)?.model ?? null) as ModelLike | null;
      const source = model !== null && model.disposed !== true ? (model.opaqueMesh ?? null) : null;
      if (source === null || source.parent === null) {
        // no model yet (it loads) or the row lost it: the flash runs on unseen
        this.#detach(r);
        continue;
      }
      if (r.source !== source) {
        this.#detach(r);
        r.overlay = this.#overlay(source, r.values);
        r.source = source;
      }
      const o = r.overlay!;
      if (o.parent !== source.parent) source.parent!.add(o);
      o.userData[LOOK_ROW_KEY] = model!.lookRow ?? 0;
      o.layers.mask = source.layers.mask;
      o.visible = source.visible;
      o.frustumCulled = source.frustumCulled;
      const sphere = (source as SkinnedMesh).boundingSphere as SkinnedMesh['boundingSphere'] | undefined;
      if (sphere !== undefined && sphere !== null && (o as SkinnedMesh).isSkinnedMesh === true) (o as SkinnedMesh).boundingSphere = sphere;
      o.position.copy(source.position);
      o.quaternion.copy(source.quaternion);
      o.scale.copy(source.scale);
    }
  }

  #overlay(source: Mesh | SkinnedMesh, values: OverlayValues): Mesh {
    let o: Mesh;
    if ((source as SkinnedMesh).isSkinnedMesh === true) {
      const src = source as SkinnedMesh;
      const s = new SkinnedMesh(src.geometry, this.material);
      s.bindMode = src.bindMode;
      s.bind(src.skeleton, src.bindMatrix);
      o = s;
    } else o = new Mesh(source.geometry, this.material);
    o.name = 'ss:flash';
    o.renderOrder = FLASH_RENDER_ORDER;
    o.castShadow = false;
    o.receiveShadow = false;
    o.userData[FLASH_KEY] = values;
    return o;
  }

  #detach(r: Running): void {
    r.overlay?.removeFromParent();
    r.overlay = null;
    r.source = null;
  }

  /** stand-ins for every program a flash can draw with: a plain mesh and a skinned mesh per bone class, each with and without uv */
  warmObjects(): Object3D[] {
    if (this.#disposed) return [];
    const out: Object3D[] = [];
    for (const withUv of [false, true]) {
      const plain = proxyGeometry(false, withUv);
      this.#warmGeometries.push(plain);
      const mesh = new Mesh(plain, this.material);
      mesh.name = `ss:warm-up:ss:flash:mesh${withUv ? ':uv' : ''}`;
      out.push(mesh);
      for (const count of BONE_CLASSES) {
        const g = proxyGeometry(true, withUv);
        this.#warmGeometries.push(g);
        const s = new SkinnedMesh(g, this.material);
        const bone = new Bone();
        s.add(bone);
        s.bind(new Skeleton(Array.from({ length: count }, () => bone), Array.from({ length: count }, () => new Matrix4())), new Matrix4());
        s.boundingSphere = g.boundingSphere!.clone();
        s.name = `ss:warm-up:ss:flash:skinned${count}${withUv ? ':uv' : ''}`;
        out.push(s);
      }
    }
    return out;
  }

  releaseWarmObjects(): void {
    for (const g of this.#warmGeometries.splice(0)) g.dispose();
  }

  get active(): number {
    return this.#running.size;
  }

  /** the overlay of a target, for tests */
  overlayOf(target: string): Mesh | null {
    return this.#running.get(target)?.overlay ?? null;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const r of this.#running.values()) this.#detach(r);
    this.#running.clear();
    this.releaseWarmObjects();
    this.material.dispose();
  }
}
