// The `slash` act (K8; engine api-reference.md:665): a one-shot sword-cut ribbon at `position`. Payload (all optional but
// `position`): `size`, `shape` (tightUniform | broadUniform | tightWidening | broadWidening | crescent | longCrescent | circle),
// `noise` (none | forward | backward | stableDissolve), `glow` (none | light | medium | intense | max), `timing` (quick |
// standard | slow | verySlow), `body` / `edge` / `fade`, `edgeColor` / `edgeAlpha`, `bodyColor1..3` / `bodyColor1..3Alpha`,
// `outwardGlow*`, `rotation {yaw, pitch, roll}`, `velocity`, `scaleVelocity`, `rotationVelocity`.
//
// The docs name the knobs and not their numbers, so every number here is [I] (tuned by eye, listed in SLASH_LOOK):
//   - shape: an arc strip in the local XY plane (normal +Z), outer radius 1 (times `size`), centred on +X; the table gives its
//     sweep, its widest width as a fraction of the radius and its width profile (uniform | widening | crescent = tips meet)
//   - timing: seconds of presentation time (quick 0.18, standard 0.3, slow 0.5, verySlow 0.9)
//   - the cut sweeps along the arc over the first 60 % of the life, its tail follows, and the whole fades over the last `fade`
//     (default 0.5) fraction; `edge` is the width fraction of the bright outer edge (default 0.15); `body` the strip's opacity
//     (default 1); `glow` multiplies the colour above 1, which the bloom picks up (none 1 ... max 5)
//   - noise: a hash dissolve over the ribbon; `forward` / `backward` scroll it along / against the cut, `stableDissolve` holds it
//   - rotation is degrees (yaw about +Y, pitch about +X, roll about +Z); `size` is metres of outer radius (default 1.5)
//   - NOT drawn: `outwardGlow`, `outwardGlowWidth`, `outwardGlowSpeed` (read and kept in the act, no halo)
//
// A pool of `SLASH_POOL` ribbons, each with its own material instance and uniforms (the oldest is taken over when all run);
// every ribbon draws with the one program linked by `warmObjects()` before the LOADING gate, so a slash creates none.
import { AdditiveBlending, BufferGeometry, DoubleSide, Euler, Float32BufferAttribute, Mesh, MeshBasicNodeMaterial, Quaternion } from 'three/webgpu';
import type { Color, Object3D, UniformNode } from 'three/webgpu';
import { dot, float, fract, mix, sin, smoothstep, uniform, uv, vec2, vec3 } from 'three/tsl';
import type { Vec3 } from '../../compat/core/types.ts';
import { finishScriptedMaterial } from '../surface/scripted-material.ts';
import { highlightColorOf } from './highlight.ts';

export type SlashShape = 'tightUniform' | 'broadUniform' | 'tightWidening' | 'broadWidening' | 'crescent' | 'longCrescent' | 'circle';
export type SlashNoise = 'none' | 'forward' | 'backward' | 'stableDissolve';
export type SlashGlow = 'none' | 'light' | 'medium' | 'intense' | 'max';
export type SlashTiming = 'quick' | 'standard' | 'slow' | 'verySlow';

export const SLASH_SHAPES: Readonly<Record<SlashShape, { sweepDeg: number; width: number; profile: 'uniform' | 'widening' | 'crescent' }>> = Object.freeze({
  tightUniform: { sweepDeg: 140, width: 0.14, profile: 'uniform' },
  broadUniform: { sweepDeg: 140, width: 0.35, profile: 'uniform' },
  tightWidening: { sweepDeg: 140, width: 0.18, profile: 'widening' },
  broadWidening: { sweepDeg: 140, width: 0.4, profile: 'widening' },
  crescent: { sweepDeg: 180, width: 0.5, profile: 'crescent' },
  longCrescent: { sweepDeg: 270, width: 0.5, profile: 'crescent' },
  circle: { sweepDeg: 360, width: 0.12, profile: 'uniform' },
});
export const SLASH_TIMING_S: Readonly<Record<SlashTiming, number>> = Object.freeze({ quick: 0.18, standard: 0.3, slow: 0.5, verySlow: 0.9 });
export const SLASH_GLOW_GAIN: Readonly<Record<SlashGlow, number>> = Object.freeze({ none: 1, light: 1.5, medium: 2.2, intense: 3.5, max: 5 });
const NOISE_MODE: Readonly<Record<SlashNoise, number>> = Object.freeze({ none: 0, forward: 1, backward: 2, stableDissolve: 3 });

export const SLASH_LOOK = Object.freeze({
  size: 1.5,
  shape: 'crescent' as SlashShape,
  noise: 'none' as SlashNoise,
  glow: 'medium' as SlashGlow,
  timing: 'standard' as SlashTiming,
  body: 1,
  edge: 0.15,
  fade: 0.5,
  edgeColor: '#ffffff',
  edgeAlpha: 1,
  bodyColor1: '#ffffff',
  bodyColor2: '#ffffff',
  bodyColor3: '#ffffff',
  bodyAlpha: 0.9,
  /** the fraction of the life the cut takes to run along the arc */
  sweepFraction: 0.6,
  segments: 40,
});
/** ribbons drawn at once */
export const SLASH_POOL = 6;

export interface SlashAct {
  position: Vec3;
  size: number;
  shape: SlashShape;
  noise: SlashNoise;
  glow: SlashGlow;
  timing: SlashTiming;
  duration: number;
  body: number;
  edge: number;
  fade: number;
  /** linear */
  edgeColor: Color;
  edgeAlpha: number;
  bodyColors: [Color, Color, Color];
  bodyAlphas: [number, number, number];
  outwardGlow: number;
  rotation: { yaw: number; pitch: number; roll: number };
  velocity: Vec3;
  scaleVelocity: number;
  rotationVelocity: { yaw: number; pitch: number; roll: number };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pick = <T extends string>(v: unknown, table: Readonly<Record<T, unknown>>, d: T): T => (typeof v === 'string' && Object.hasOwn(table, v) ? (v as T) : d);
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const num = (v: unknown, d: number): number => (fin(v) ? v : d);

function ypr(v: unknown): { yaw: number; pitch: number; roll: number } {
  const o = isObj(v) ? v : {};
  return { yaw: num(o['yaw'], 0), pitch: num(o['pitch'], 0), roll: num(o['roll'], 0) };
}

/** the payload with the docs' optional fields defaulted ([I] numbers); null without a usable `position` */
export function slashActOf(payload: unknown): SlashAct | null {
  if (!isObj(payload)) return null;
  const p = payload['position'];
  if (!isObj(p) || !fin(p['x']) || !fin(p['y']) || !fin(p['z'])) return null;
  const color = (k: string, d: string): Color => highlightColorOf(payload[k]) ?? highlightColorOf(d)!;
  const alpha = (k: string, d: number): number => (fin(payload[k]) ? clamp01(payload[k] as number) : d);
  const timing = pick(payload['timing'], SLASH_TIMING_S, SLASH_LOOK.timing);
  const vel = isObj(payload['velocity']) ? payload['velocity'] : {};
  return {
    position: { x: p['x'], y: p['y'], z: p['z'] },
    size: fin(payload['size']) && payload['size'] > 0 ? payload['size'] : SLASH_LOOK.size,
    shape: pick(payload['shape'], SLASH_SHAPES, SLASH_LOOK.shape),
    noise: pick(payload['noise'], NOISE_MODE, SLASH_LOOK.noise),
    glow: pick(payload['glow'], SLASH_GLOW_GAIN, SLASH_LOOK.glow),
    timing,
    duration: SLASH_TIMING_S[timing],
    body: alpha('body', SLASH_LOOK.body),
    edge: alpha('edge', SLASH_LOOK.edge),
    fade: alpha('fade', SLASH_LOOK.fade),
    edgeColor: color('edgeColor', SLASH_LOOK.edgeColor),
    edgeAlpha: alpha('edgeAlpha', SLASH_LOOK.edgeAlpha),
    bodyColors: [color('bodyColor1', SLASH_LOOK.bodyColor1), color('bodyColor2', SLASH_LOOK.bodyColor2), color('bodyColor3', SLASH_LOOK.bodyColor3)],
    bodyAlphas: [alpha('bodyColor1Alpha', SLASH_LOOK.bodyAlpha), alpha('bodyColor2Alpha', SLASH_LOOK.bodyAlpha), alpha('bodyColor3Alpha', SLASH_LOOK.bodyAlpha)],
    outwardGlow: num(payload['outwardGlow'], 0),
    rotation: ypr(payload['rotation']),
    velocity: { x: num(vel['x'], 0), y: num(vel['y'], 0), z: num(vel['z'], 0) },
    scaleVelocity: num(payload['scaleVelocity'], 0),
    rotationVelocity: ypr(payload['rotationVelocity']),
  };
}

/** the ribbon of a shape: an arc strip, `uv.x` along the arc (0 = where the cut starts), `uv.y` across (0 inner edge, 1 outer edge) */
export function slashGeometry(shape: SlashShape): BufferGeometry {
  const s = SLASH_SHAPES[shape];
  const n = SLASH_LOOK.segments;
  const pos: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const sweep = (s.sweepDeg * Math.PI) / 180;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const a = (u - 0.5) * sweep;
    const w = s.width * (s.profile === 'uniform' ? 1 : s.profile === 'widening' ? u : Math.sin(Math.PI * u));
    const c = Math.cos(a);
    const sn = Math.sin(a);
    pos.push(c, sn, 0, c * (1 - w), sn * (1 - w), 0);
    uvs.push(u, 1, u, 0);
    if (i < n) {
      const k = i * 2;
      index.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

/** how much of the ribbon the cut has revealed `age` seconds in (0..1 along the arc) */
export function slashHead(age: number, duration: number): number {
  return clamp01(age / (duration * SLASH_LOOK.sweepFraction));
}

interface SlashUniforms {
  progress: UniformNode<'float', number>;
  gain: UniformNode<'float', number>;
  body: UniformNode<'float', number>;
  edge: UniformNode<'float', number>;
  fade: UniformNode<'float', number>;
  noise: UniformNode<'float', number>;
  edgeColor: UniformNode<'color', Color>;
  edgeAlpha: UniformNode<'float', number>;
  c1: UniformNode<'color', Color>;
  c2: UniformNode<'color', Color>;
  c3: UniformNode<'color', Color>;
  a1: UniformNode<'float', number>;
  a2: UniformNode<'float', number>;
  a3: UniformNode<'float', number>;
}

function slashUniforms(): SlashUniforms {
  const white = (): Color => highlightColorOf('#ffffff')!;
  return {
    progress: uniform(0), gain: uniform(1), body: uniform(1), edge: uniform(0.15), fade: uniform(0.5), noise: uniform(0),
    edgeColor: uniform(white()), edgeAlpha: uniform(1), c1: uniform(white()), c2: uniform(white()), c3: uniform(white()),
    a1: uniform(1), a2: uniform(1), a3: uniform(1),
  };
}

function slashMaterial(u: SlashUniforms): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  m.name = 'ss:slash';
  m.transparent = true;
  m.depthWrite = false;
  m.blending = AdditiveBlending;
  m.side = DoubleSide;
  const st = uv();
  const along = st.x;
  const across = st.y;
  // the cut runs along the arc, its tail follows
  const head = u.progress.div(SLASH_LOOK.sweepFraction).min(1);
  const tail = u.progress.pow(1.5);
  const visible = smoothstep(head, head.sub(0.08), along).mul(smoothstep(tail, tail.add(0.12), along));
  // fades over the last `fade` fraction of the life
  const life = float(1).sub(smoothstep(float(1).sub(u.fade), 1, u.progress));
  // body colour across the width, the bright edge on the outer rim
  const bodyCol = mix(mix(u.c1, u.c2, smoothstep(0, 0.5, across)), u.c3, smoothstep(0.5, 1, across));
  const bodyA = mix(mix(u.a1, u.a2, smoothstep(0, 0.5, across)), u.a3, smoothstep(0.5, 1, across));
  const rim = smoothstep(float(1).sub(u.edge.max(0.001)), 1, across);
  const col = mix(bodyCol, u.edgeColor, rim);
  const alpha = mix(bodyA.mul(u.body), u.edgeAlpha, rim);
  // the dissolve: 0 none, 1 forward, 2 backward, 3 held
  const scroll = u.noise.equal(1).select(u.progress, u.noise.equal(2).select(u.progress.negate(), float(0))).mul(6);
  const hash = fract(sin(dot(vec2(along.mul(30).add(scroll), across.mul(8)), vec2(12.9898, 78.233))).mul(43758.5453));
  const dissolve = u.noise.greaterThan(0).select(smoothstep(u.progress.mul(0.9).sub(0.15), u.progress.mul(0.9), hash), float(1));
  m.colorNode = vec3(col).mul(u.gain);
  m.opacityNode = alpha.mul(visible).mul(life).mul(dissolve);
  return finishScriptedMaterial(m) as MeshBasicNodeMaterial;
}

interface Ribbon {
  mesh: Mesh;
  u: SlashUniforms;
  act: SlashAct | null;
  age: number;
}

export interface SlashOptions {
  /** where the ribbons go (`SceneRoot.world`) */
  world: Object3D;
}

export interface SlashStats {
  active: number;
  emitted: number;
  replaced: number;
}

const euler = new Euler(0, 0, 0, 'YXZ');
const DEG = Math.PI / 180;

/** the renderer behind the `slash` act */
export class SlashRenderer {
  readonly #ribbons: Ribbon[] = [];
  readonly #geometries = new Map<SlashShape, BufferGeometry>();
  readonly #q = new Quaternion();
  #emitted = 0;
  #replaced = 0;
  #disposed = false;

  constructor(opts: SlashOptions) {
    for (let i = 0; i < SLASH_POOL; i++) {
      const u = slashUniforms();
      const mesh = new Mesh(this.#geometry(SLASH_LOOK.shape), slashMaterial(u));
      mesh.name = `ss:slash:${i}`;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.renderOrder = 55;
      opts.world.add(mesh);
      this.#ribbons.push({ mesh, u, act: null, age: 0 });
    }
  }

  #geometry(shape: SlashShape): BufferGeometry {
    let g = this.#geometries.get(shape);
    if (g === undefined) {
      g = slashGeometry(shape);
      this.#geometries.set(shape, g);
    }
    return g;
  }

  /** the `slash` act: false when the payload is unusable */
  emit(payload: unknown): boolean {
    if (this.#disposed) return false;
    const act = slashActOf(payload);
    if (act === null) return false;
    let r = this.#ribbons.find((x) => x.act === null);
    if (r === undefined) {
      r = this.#ribbons.reduce((a, b) => (b.age > a.age ? b : a));
      this.#replaced++;
    }
    r.act = act;
    r.age = 0;
    r.mesh.geometry = this.#geometry(act.shape);
    const u = r.u;
    u.gain.value = SLASH_GLOW_GAIN[act.glow];
    u.body.value = act.body;
    u.edge.value = act.edge;
    u.fade.value = act.fade;
    u.noise.value = NOISE_MODE[act.noise];
    u.edgeColor.value.copy(act.edgeColor);
    u.edgeAlpha.value = act.edgeAlpha;
    u.c1.value.copy(act.bodyColors[0]);
    u.c2.value.copy(act.bodyColors[1]);
    u.c3.value.copy(act.bodyColors[2]);
    u.a1.value = act.bodyAlphas[0];
    u.a2.value = act.bodyAlphas[1];
    u.a3.value = act.bodyAlphas[2];
    this.#emitted++;
    this.#place(r);
    return true;
  }

  #place(r: Ribbon): void {
    const act = r.act;
    if (act === null) return;
    const t = r.age;
    const m = r.mesh;
    m.position.set(act.position.x + act.velocity.x * t, act.position.y + act.velocity.y * t, act.position.z + act.velocity.z * t);
    euler.set((act.rotation.pitch + act.rotationVelocity.pitch * t) * DEG, (act.rotation.yaw + act.rotationVelocity.yaw * t) * DEG, (act.rotation.roll + act.rotationVelocity.roll * t) * DEG, 'YXZ');
    m.quaternion.copy(this.#q.setFromEuler(euler));
    const s = Math.max(1e-3, act.size + act.scaleVelocity * t);
    m.scale.set(s, s, s);
    m.updateMatrix();
    r.u.progress.value = Math.min(1, t / act.duration);
    m.visible = true;
  }

  /** advances every ribbon by the frame's presentation seconds */
  update(dtS: number): void {
    if (this.#disposed) return;
    for (const r of this.#ribbons) {
      if (r.act === null) continue;
      r.age += Math.max(0, dtS);
      if (r.age >= r.act.duration) {
        r.act = null;
        r.mesh.visible = false;
        continue;
      }
      this.#place(r);
    }
  }

  /** the pool's first ribbon (every ribbon is the same program) for the engine-load warm-up */
  warmObjects(): Object3D[] {
    return this.#disposed ? [] : [this.#ribbons[0]!.mesh];
  }

  stats(): SlashStats {
    return { active: this.#ribbons.filter((r) => r.act !== null).length, emitted: this.#emitted, replaced: this.#replaced };
  }

  /** the ribbon meshes, for tests */
  get meshes(): readonly Mesh[] {
    return this.#ribbons.map((r) => r.mesh);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const r of this.#ribbons) {
      r.mesh.removeFromParent();
      (r.mesh.material as MeshBasicNodeMaterial).dispose();
    }
    for (const g of this.#geometries.values()) g.dispose();
    this.#geometries.clear();
  }
}
