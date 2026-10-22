// The shockwave act (docs/design/rendering.md §10.7, §14.7; WP R12a): `shockwave {position, speed, thickness, intensity}`
// (one live emit, scripts/enemies/arch/gravemason.js: speed 14, thickness 1.2, intensity 1). An expanding additive ring on
// the ground plane at `position`, its radius growing at `speed` m/s, `thickness` metres wide, fading out over
// `SHOCKWAVE_LOOK.lifetimeS` [I] with `intensity`; on tiers with the distort pass (`high` / `medium`) a matching ring in the
// post pipeline's distort scene writes a radial screen offset (render §10.2).
//
// The ring is a unit disc scaled to the ring's outer radius; its fragment draws the band from the disc's uv, so the band
// keeps its width in metres while the radius grows. A fixed pool of `SHOCKWAVE_POOL` rings (the oldest is taken over when all
// run), each with its own material and uniforms, created at construction: every ring draws with the one program per pass
// linked before the LOADING gate, the scene ring's by compiling `warmObjects()`, the offset ring's by drawing it at zero
// gain in the warm-up's closing render (`armDistortWarm`: its fragment writes the distort pass's RG format, so only that
// pass links its program). Time is presentation time (`update(dtS)` with the frame's `dt`): a paused or hit-stopped frame
// does not advance it.
import { AdditiveBlending, CircleGeometry, DoubleSide, Mesh, MeshBasicNodeMaterial } from 'three/webgpu';
import type { Object3D, UniformNode } from 'three/webgpu';
import { abs, float, length, max, smoothstep, uniform, uv, vec3, vec4 } from 'three/tsl';
import type { Vec3 } from '../../compat/core/types.ts';
import { finishScriptedMaterial } from '../surface/scripted-material.ts';

/** [I] */
export const SHOCKWAVE_LOOK = Object.freeze({
  lifetimeS: 0.6,
  /** linear, before `intensity` and the fade */
  color: [1.4, 1.1, 0.75] as readonly number[],
  /** the distort ring's offset at full strength, in uv units */
  distortStrength: 0.012,
  /** metres above `position` */
  lift: 0.03,
});
/** rings drawn at once */
export const SHOCKWAVE_POOL = 4;

export interface ShockwaveAct {
  position: Vec3;
  speed: number;
  thickness: number;
  intensity: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** the act's payload, validated; null when it has no position */
export function shockwaveActOf(payload: unknown): ShockwaveAct | null {
  if (!isObj(payload)) return null;
  const p = payload['position'];
  if (!isObj(p) || !fin(p['x']) || !fin(p['y']) || !fin(p['z'])) return null;
  const pos = (k: string, d: number): number => (fin(payload[k]) && (payload[k] as number) > 0 ? (payload[k] as number) : d);
  return { position: { x: p['x'], y: p['y'], z: p['z'] }, speed: pos('speed', 10), thickness: pos('thickness', 1), intensity: fin(payload['intensity']) ? Math.max(0, payload['intensity']) : 1 };
}

/** radius, band and gain of a ring `t` seconds old */
export function ringAt(act: ShockwaveAct, t: number, lifetimeS = SHOCKWAVE_LOOK.lifetimeS): { radius: number; outer: number; gain: number } {
  const k = Math.min(1, Math.max(0, t / lifetimeS));
  const radius = act.speed * t;
  return { radius, outer: radius + act.thickness / 2, gain: act.intensity * (1 - k) * (1 - k) };
}

interface RingUniforms {
  radius: UniformNode<'float', number>;
  half: UniformNode<'float', number>;
  outer: UniformNode<'float', number>;
  gain: UniformNode<'float', number>;
}

interface Ring {
  mesh: Mesh;
  distort: Mesh | null;
  u: RingUniforms;
  du: RingUniforms | null;
  act: ShockwaveAct | null;
  age: number;
}

function ringUniforms(): RingUniforms {
  return { radius: uniform(0), half: uniform(0.5), outer: uniform(1), gain: uniform(0) };
}

/** the band: 1 at the ring's radius, 0 at half the thickness from it (metres, from the disc's uv) */
function band(u: RingUniforms) {
  const d = length(uv().sub(0.5)).mul(2).mul(u.outer);
  return float(1).sub(smoothstep(0, max(u.half, 0.001), abs(d.sub(u.radius))));
}

function ringMaterial(u: RingUniforms): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  m.name = 'ss:shockwave';
  m.transparent = true;
  m.depthWrite = false;
  m.blending = AdditiveBlending;
  m.side = DoubleSide;
  const c = SHOCKWAVE_LOOK.color;
  m.colorNode = vec3(c[0]!, c[1]!, c[2]!).mul(band(u).mul(u.gain));
  return finishScriptedMaterial(m) as MeshBasicNodeMaterial;
}

function distortMaterial(u: RingUniforms): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  m.name = 'ss:shockwave:distort';
  m.transparent = true;
  m.depthWrite = false;
  m.blending = AdditiveBlending;
  m.side = DoubleSide;
  m.fog = false;
  const dir = uv().sub(0.5);
  const n = dir.div(max(length(dir), 1e-4));
  const k = band(u).mul(u.gain).mul(SHOCKWAVE_LOOK.distortStrength);
  m.colorNode = vec4(n.x.mul(k), n.y.mul(k), 0, band(u));
  return m;
}

export interface ShockwaveOptions {
  /** where the rings go (`SceneRoot.world`) */
  world: Object3D;
  /** the post pipeline's distort scene; null (none yet, a tier without the pass): no offset ring */
  distortScene?: () => Object3D | null;
  /** the tier draws the distort pass */
  distortEnabled?: () => boolean;
}

export interface ShockwaveStats {
  active: number;
  emitted: number;
  /** rings that took over a running one (the pool was full) */
  replaced: number;
}

/** the renderer behind the `shockwave` act */
export class ShockwaveRenderer {
  readonly #opts: ShockwaveOptions;
  readonly #geometry: CircleGeometry;
  readonly #rings: Ring[] = [];
  #emitted = 0;
  #replaced = 0;
  #disposed = false;

  constructor(opts: ShockwaveOptions) {
    this.#opts = opts;
    this.#geometry = new CircleGeometry(1, 48);
    this.#geometry.rotateX(-Math.PI / 2);
    for (let i = 0; i < SHOCKWAVE_POOL; i++) {
      const u = ringUniforms();
      const mesh = new Mesh(this.#geometry, ringMaterial(u));
      mesh.name = `ss:shockwave:${i}`;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.renderOrder = 50;
      opts.world.add(mesh);
      const du = ringUniforms();
      const distort = new Mesh(this.#geometry, distortMaterial(du));
      distort.name = `ss:shockwave:distort:${i}`;
      distort.visible = false;
      distort.frustumCulled = false;
      distort.renderOrder = 60;
      this.#rings.push({ mesh, distort, u, du, act: null, age: 0 });
    }
  }

  /** the `shockwave` act: false when the payload is unusable */
  emit(payload: unknown): boolean {
    if (this.#disposed) return false;
    const act = shockwaveActOf(payload);
    if (act === null) return false;
    let ring = this.#rings.find((r) => r.act === null);
    if (ring === undefined) {
      ring = this.#rings.reduce((a, b) => (b.age > a.age ? b : a));
      this.#replaced++;
    }
    ring.act = act;
    ring.age = 0;
    this.#emitted++;
    this.#place(ring);
    return true;
  }

  #place(r: Ring): void {
    const act = r.act;
    if (act === null) return;
    const s = ringAt(act, r.age);
    const outer = Math.max(s.outer, 1e-3);
    for (const [mesh, u] of [[r.mesh, r.u], [r.distort, r.du]] as const) {
      if (mesh === null || u === null) continue;
      mesh.position.set(act.position.x, act.position.y + SHOCKWAVE_LOOK.lift, act.position.z);
      mesh.scale.set(outer, 1, outer);
      mesh.updateMatrix();
      u.radius.value = s.radius;
      u.half.value = act.thickness / 2;
      u.outer.value = outer;
      u.gain.value = s.gain;
    }
    r.mesh.visible = s.gain > 0;
    this.#syncDistort(r, s.gain > 0);
  }

  #syncDistort(r: Ring, on: boolean): void {
    if (r.distort === null) return;
    const scene = (this.#opts.distortEnabled?.() ?? false) ? (this.#opts.distortScene?.() ?? null) : null;
    if (on && scene !== null) {
      if (r.distort.parent !== scene) scene.add(r.distort);
      r.distort.visible = true;
    } else {
      r.distort.visible = false;
      if (r.distort.parent !== null && !on) r.distort.removeFromParent();
    }
  }

  /** advances every ring by the frame's presentation seconds */
  update(dtS: number): void {
    if (this.#disposed) return;
    for (const r of this.#rings) {
      if (r.act === null) continue;
      r.age += Math.max(0, dtS);
      if (r.age >= SHOCKWAVE_LOOK.lifetimeS) {
        r.act = null;
        r.mesh.visible = false;
        this.#syncDistort(r, false);
        continue;
      }
      this.#place(r);
    }
  }

  /** the ring pool's scene meshes (they are the draws: compiling them links the one program) */
  warmObjects(): Object3D[] {
    return this.#disposed ? [] : this.#rings.slice(0, 1).map((r) => r.mesh);
  }

  /**
   * The offset ring's program is the distort pass's own: its fragment output is the pass's RG format, so a compile against
   * any other target links a different program. The warm-up therefore draws it: this puts a pooled offset ring, at zero
   * gain (it writes no offset), in the distort scene for the warm-up's closing render of the pipeline, and the returned
   * function takes it out again. Nothing happens (and the return is a no-op) while the tier has no distort pass, a ring is
   * running, or the renderer is disposed. True in `armed` when it armed.
   */
  armDistortWarm(): { armed: boolean; done(): void } {
    const none = { armed: false, done: () => undefined };
    if (this.#disposed || !(this.#opts.distortEnabled?.() ?? false)) return none;
    const scene = this.#opts.distortScene?.() ?? null;
    const r = this.#rings.find((x) => x.act === null && x.distort !== null && x.distort.parent === null);
    if (scene === null || r === undefined || r.distort === null || r.du === null) return none;
    const { distort, du } = r;
    du.gain.value = 0;
    distort.position.set(0, 0, 0);
    distort.scale.set(1, 1, 1);
    distort.visible = true;
    scene.add(distort);
    return {
      armed: true,
      done: () => {
        if (r.act !== null) return;
        distort.visible = false;
        distort.removeFromParent();
      },
    };
  }

  stats(): ShockwaveStats {
    return { active: this.#rings.filter((r) => r.act !== null).length, emitted: this.#emitted, replaced: this.#replaced };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const r of this.#rings) {
      r.mesh.removeFromParent();
      (r.mesh.material as MeshBasicNodeMaterial).dispose();
      r.distort?.removeFromParent();
      (r.distort?.material as MeshBasicNodeMaterial | undefined)?.dispose();
    }
    this.#geometry.dispose();
  }
}
