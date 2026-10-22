// The byte oracle of the fx Worker (DR-53/DR-54 S0; .cache/claude-fxworker/DESIGN.md §12, §14): drives fx runtimes with the
// same scenario (scenario.ts) and compares, frame by frame, every bucket's live prefix byte for byte (sprites: positions,
// scales, rotations, rgba, cells; stretched quads: matrices, rgba, cells; mesh sinks: matrices, albedo, emissive, extra), the
// buckets' counts and visibility, the effect and particle counts, and the whole light-table call log (records with their
// flash keys and mobility, values, handle numbers, order).
//
// Runtime B may run one frame behind A (`offset: 1`: the fx Worker draws frame N's result at frame N + 1): A's frame N is then
// compared with what B presents at its update N + 1, and A's light calls of frame N (those of the frame's events, such as an
// act's end, and those of its update) with the calls B makes while it presents that result.
//
// Browser-safe (three and types only): the fx-worker harness page (tests/e2e/pages/fx-worker/) drives the same lock step in
// Chromium with a real Web Worker.
import { DataTexture, Object3D, RGBAFormat, Scene, UnsignedByteType, type InstancedMesh, type Texture } from 'three/webgpu';
import type { BridgeLights } from '../../../../src/render/bridge/bridge-types.ts';
import type { LightHandle } from '../../../../src/render/lighting/light-table.ts';
import { tierConfig, type RenderBudget, type TierId } from '../../../../src/render/perf/budget.ts';
import type { Frame, Scenario } from './scenario.ts';

export interface OracleBinding {
  restart(spec: unknown): void;
  end(): void;
}

/** what the oracle drives: the legacy runtime, the refactored in-process runtime and the worker facade all fit */
export interface OracleRuntime {
  emit(spec: unknown, origin?: readonly [number, number, number]): number | null;
  end(id: number): void;
  has(id: number): boolean;
  bind(rowId: string, spec: unknown, node: Object3D): OracleBinding | null;
  update(frame: { dt: number; now: number }): void;
  dispose(): void;
  readonly effectCount: number;
  readonly particleCount: number;
}

/** the options every runtime is built with (FxSystemOptions' shape) */
export interface OracleEnv {
  readonly world: Scene;
  readonly camera: Object3D;
  readonly distortScene?: () => Object3D | null;
  readonly atlas: Texture;
  readonly budget: RenderBudget;
  readonly lights: BridgeLights;
  readonly staticOwner: (node: Object3D) => boolean;
  readonly log: (message: string) => void;
  readonly mobile?: boolean;
  readonly maxEffects?: number;
}

export const ATLAS = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType);

/** a 64-bit fingerprint of float arrays, bit for bit (two independent multiply-xor lanes over the 32-bit words, and the length) */
const sha = (parts: ArrayLike<number>[]): string => {
  let h1 = 0x811c9dc5 | 0, h2 = 0x9747b28c | 0, n = 0;
  for (const p of parts) {
    const a = p as unknown as Float32Array;
    const w = new Uint32Array(a.buffer, a.byteOffset, a.length);
    for (let i = 0; i < w.length; i++) {
      const k = w[i]!;
      h1 = Math.imul(h1 ^ k, 0x01000193);
      h2 = Math.imul(h2 ^ k, 0x5bd1e995);
      h2 ^= h2 >>> 15;
    }
    n += w.length;
    h1 = Math.imul(h1 ^ n, 0x01000193);
    h2 = Math.imul(h2 ^ (n * 0x9e3779b1), 0x5bd1e995);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}/${n}`;
};

/** the light table as a call log */
export function recordingLights(log: string[]): BridgeLights {
  let next = 1;
  return {
    add(record) {
      log.push(`add|${JSON.stringify(record)}`);
      return next++ as LightHandle;
    },
    remove(h) {
      log.push(`rm|${String(h)}`);
    },
    setColor(h, c) {
      log.push(`col|${String(h)}|${(c as readonly number[]).join(',')}`);
    },
    setIntensity(h, i) {
      log.push(`int|${String(h)}|${i}`);
    },
    setPose(h, p) {
      log.push(`pose|${String(h)}|${p.x},${p.y},${p.z}`);
    },
  } as BridgeLights;
}

type Attr = { itemSize: number; id: number; array: Float32Array };

/** the instanced buffer attributes a node material reads (three r186 TSL buffer nodes), by attribute id */
function attrsOf(root: unknown): Attr[] {
  const seen = new Set<unknown>();
  const out = new Map<number, Attr>();
  const visit = (n: unknown, depth: number): void => {
    if (n === null || typeof n !== 'object' || seen.has(n) || depth > 60) return;
    seen.add(n);
    const o = n as Record<string, unknown>;
    if (o['isBufferNode'] === true) {
      const a = o['value'] as Attr | undefined;
      if (a && typeof a.itemSize === 'number') out.set(a.id, a);
    }
    if (o['isNode'] !== true) return;
    for (const k of Object.keys(o)) {
      if (k === 'parents' || k === '_cacheKey' || k === 'stackTrace') continue;
      const v = o[k];
      if (Array.isArray(v)) for (const x of v) visit(x, depth + 1);
      else visit(v, depth + 1);
    }
  };
  visit(root, 0);
  return [...out.values()].sort((a, b) => a.id - b.id);
}

/** every fx bucket under `roots`: `<tag>/<name>` → `count:visible:sha of the live prefixes` */
export function snapshot(roots: ReadonlyArray<readonly [Object3D, string]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [parent, tag] of roots) {
    for (const child of parent.children) {
      const name = child.name;
      const key = `${tag}/${name}`;
      if (name.startsWith('ss:fx:stretched:')) {
        const mesh = child as unknown as InstancedMesh;
        const n = mesh.count;
        const [rgba, cells] = attrsOf((mesh.material as unknown as { colorNode: unknown }).colorNode).sort((a, b) => b.itemSize - a.itemSize);
        out.set(key, `${n}:${mesh.visible ? 1 : 0}:${sha([(mesh.instanceMatrix.array as Float32Array).subarray(0, n * 16), rgba!.array.subarray(0, n * 4), cells!.array.subarray(0, n)])}`);
      } else if (name.startsWith('ss:fx:')) {
        const sprite = child as unknown as { count: number; visible: boolean; material: Record<string, unknown> };
        const n = sprite.count;
        const p = attrsOf(sprite.material['positionNode'])[0]!, s = attrsOf(sprite.material['scaleNode'])[0]!, r = attrsOf(sprite.material['rotationNode'])[0]!;
        const color = attrsOf(sprite.material['colorNode']);
        const rgba = color.find((a) => a.itemSize === 4)!, cells = color.find((a) => a.itemSize === 1)!;
        out.set(key, `${n}:${sprite.visible ? 1 : 0}:${sha([p.array.subarray(0, n * 3), s.array.subarray(0, n * 2), r.array.subarray(0, n), rgba.array.subarray(0, n * 4), cells.array.subarray(0, n)])}`);
      } else if (name.startsWith('ss:primitives:')) {
        const mesh = child as unknown as InstancedMesh;
        const n = mesh.count;
        const g = mesh.geometry;
        const parts = [(mesh.instanceMatrix.array as Float32Array).subarray(0, n * 16), ...['ssAlbedo', 'ssEmissive', 'ssExtra'].map((a) => (g.getAttribute(a).array as Float32Array).subarray(0, n * 4))];
        out.set(key, `${n}:${mesh.visible ? 1 : 0}:${mesh.frustumCulled ? 1 : 0}:${sha(parts)}`);
      }
    }
  }
  return out;
}

/** a sprite bucket's instanced positions (the attribute its material's `positionNode` reads) */
export function spritePositions(sprite: Object3D): Float32Array {
  return attrsOf((sprite as unknown as { material: Record<string, unknown> }).material['positionNode'])[0]!.array;
}

/** every instanced array the fx buckets under `roots` draw from (three's own: never transferred) */
export function bucketArrays(roots: ReadonlyArray<readonly [Object3D, string]>): Float32Array[] {
  const out: Float32Array[] = [];
  for (const [parent] of roots) {
    for (const child of parent.children) {
      const name = child.name;
      if (name.startsWith('ss:fx:stretched:')) {
        const mesh = child as unknown as InstancedMesh;
        out.push(mesh.instanceMatrix.array as Float32Array, ...attrsOf((mesh.material as unknown as { colorNode: unknown }).colorNode).map((a) => a.array));
      } else if (name.startsWith('ss:fx:')) {
        const m = (child as unknown as { material: Record<string, unknown> }).material;
        for (const k of ['positionNode', 'scaleNode', 'rotationNode', 'colorNode']) out.push(...attrsOf(m[k]).map((a) => a.array));
      } else if (name.startsWith('ss:primitives:')) {
        const mesh = child as unknown as InstancedMesh;
        out.push(mesh.instanceMatrix.array as Float32Array, ...['ssAlbedo', 'ssEmissive', 'ssExtra'].map((a) => mesh.geometry.getAttribute(a).array as Float32Array));
      }
    }
  }
  return out;
}

/** the instances of the mesh buckets under `roots` that no fill wrote (a written fx mesh instance has albedo.a = 1): F1 */
export function unpaintedMeshInstances(roots: ReadonlyArray<readonly [Object3D, string]>): number {
  let lost = 0;
  for (const [parent] of roots) {
    for (const child of parent.children) {
      if (!child.name.startsWith('ss:primitives:')) continue;
      const mesh = child as unknown as InstancedMesh;
      const albedo = mesh.geometry.getAttribute('ssAlbedo').array as Float32Array;
      for (let i = 0; i < mesh.count; i++) if (albedo[i * 4 + 3] !== 1) lost++;
    }
  }
  return lost;
}

/** One runtime under test with its own scene, camera, nodes, light log and budget, driven frame by frame. */
export class Driver {
  readonly scene = new Scene();
  readonly camera = new Object3D();
  readonly distort: Scene | null;
  readonly nodes: Object3D[];
  readonly log: string[] = [];
  readonly warnings: string[] = [];
  readonly runtime: OracleRuntime;
  tier: TierId = 'high';
  readonly #binds = new Map<number, OracleBinding | null>();
  readonly #acts = new Map<number, number>();

  constructor(s: Scenario, make: (env: OracleEnv) => OracleRuntime) {
    this.scene.add(this.camera);
    this.distort = s.options.distort === true ? new Scene() : null;
    this.nodes = Array.from({ length: s.rows }, (_, i) => {
      const o = new Object3D();
      o.name = `row-${i}`;
      this.scene.add(o);
      return o;
    });
    const statics = new Set((s.options.staticRows ?? []).map((i) => this.nodes[i]!));
    // the live tier of the driver, read at every use (as fx-setup.ts's budget reads the host's)
    const tierNow = (): TierId => this.tier;
    const budget: RenderBudget = {
      get tier() {
        return tierNow();
      },
      cap: (kind, fallback) => {
        const v = (tierConfig(tierNow()) as unknown as Record<string, unknown>)[kind];
        return typeof v === 'number' && Number.isFinite(v) ? Math.min(fallback, v) : fallback;
      },
    };
    const distort = this.distort;
    this.runtime = make({
      world: this.scene,
      camera: this.camera,
      ...(distort === null ? {} : { distortScene: () => distort }),
      atlas: ATLAS,
      budget,
      lights: recordingLights(this.log),
      staticOwner: (node) => statics.has(node),
      log: (m) => this.warnings.push(m),
      ...(s.options.mobile === undefined ? {} : { mobile: s.options.mobile }),
      ...(s.options.maxEffects === undefined ? {} : { maxEffects: s.options.maxEffects }),
    });
  }

  /** the camera and the nodes of `f`, and its tier */
  place(f: Frame): void {
    this.tier = f.tier;
    this.camera.position.set(f.cam.x, f.cam.y, f.cam.z);
    this.camera.rotation.set(f.cam.pitch, f.cam.yaw, 0, 'YXZ');
    f.nodes.forEach((p, i) => this.nodes[i]!.position.set(p[0], p[1], p[2]));
  }

  /** the frame's events, as the app drives them (fx-acts.ts for acts; the bridge's `readFx` for rows) */
  events(f: Frame): void {
    const rt = this.runtime;
    for (const ev of f.events) {
      if (ev.k === 'emit') {
        const id = rt.emit(ev.spec, ev.origin);
        if (id !== null) this.#acts.set(ev.act, id);
      } else if (ev.k === 'end') {
        const id = this.#acts.get(ev.act);
        this.#acts.delete(ev.act);
        if (id !== undefined && rt.has(id)) rt.end(id);
      } else if (ev.k === 'bind') {
        this.#binds.set(ev.row, rt.bind(`row-${ev.row}`, ev.spec, this.nodes[ev.row]!));
      } else if (ev.k === 'restart') {
        const b = this.#binds.get(ev.row);
        if (b) b.restart(ev.spec);
        else this.#binds.set(ev.row, rt.bind(`row-${ev.row}`, ev.spec, this.nodes[ev.row]!));
      } else {
        this.#binds.get(ev.row)?.end();
        this.#binds.delete(ev.row);
      }
    }
  }

  update(f: Pick<Frame, 'dt' | 'nowMs'>): void {
    this.runtime.update({ dt: f.dt, now: f.nowMs });
  }

  roots(): Array<[Object3D, string]> {
    const r: Array<[Object3D, string]> = [[this.scene, 'world'], [this.camera, 'camera']];
    if (this.distort !== null) r.push([this.distort, 'distort']);
    return r;
  }

  snapshot(): Map<string, string> {
    return snapshot(this.roots());
  }
}

export interface FrameRecord {
  readonly buckets: Map<string, string>;
  readonly lights: string;
  readonly effects: number;
  readonly particles: number;
}

export interface LockstepResult {
  readonly frames: number;
  readonly mismatches: string[];
  readonly lightCalls: number;
  readonly maxParticles: number;
  readonly maxMeshInstances: number;
  /** frames on which A's mesh buckets held an instance no fill wrote (F1) */
  readonly unpaintedFrames: number;
}

const meshInstances = (m: Map<string, string>): number => {
  let n = 0;
  for (const [k, v] of m) if (k.includes('ss:primitives:')) n += Number(v.split(':')[0]);
  return n;
};

/** counts of what the runtime reports after a frame; the worker facade reports what it presented */
export type CountsOf = (rt: OracleRuntime) => { effects: number; particles: number };
const directCounts: CountsOf = (rt) => ({ effects: rt.effectCount, particles: rt.particleCount });

/**
 * Drives A and B with `s` and compares them frame by frame. With `offset: 1`, B runs one frame behind (it presents frame N's
 * result at its update N + 1); `settle(b)` then waits for B's step in flight before the next frame, and B gets one more
 * update (dt 0) at the end to present the last frame.
 */
export async function lockstep(
  s: Scenario,
  makeA: (env: OracleEnv) => OracleRuntime,
  makeB: (env: OracleEnv) => OracleRuntime,
  o: { offset?: 0 | 1; settle?: (rt: OracleRuntime) => Promise<void>; countsB?: CountsOf; limit?: number } = {},
): Promise<LockstepResult> {
  const offset = o.offset ?? 0;
  const a = new Driver(s, makeA);
  const b = new Driver(s, makeB);
  const countsB = o.countsB ?? directCounts;
  const recA: FrameRecord[] = [];
  const recB: FrameRecord[] = [];
  let unpaintedFrames = 0;
  try {
    for (const f of s.frames) {
      a.place(f);
      a.log.length = 0;
      a.events(f);
      a.update(f);
      recA.push({ buckets: a.snapshot(), lights: a.log.join('\n'), effects: a.runtime.effectCount, particles: a.runtime.particleCount });
      if (unpaintedMeshInstances(a.roots()) > 0) unpaintedFrames++;
      // a synchronous B removes an ended effect's lights at the end itself, as A; the worker facade does it when it presents
      b.place(f);
      b.log.length = 0;
      b.events(f);
      b.update(f);
      const c = countsB(b.runtime);
      if (offset === 0 || recA.length > 1) recB.push({ buckets: b.snapshot(), lights: b.log.join('\n'), effects: c.effects, particles: c.particles });
      await o.settle?.(b.runtime);
    }
    if (offset === 1) {
      const last = s.frames[s.frames.length - 1]!;
      b.log.length = 0;
      b.update({ dt: 0, nowMs: last.nowMs });
      const c = countsB(b.runtime);
      recB.push({ buckets: b.snapshot(), lights: b.log.join('\n'), effects: c.effects, particles: c.particles });
      await o.settle?.(b.runtime);
    }
  } finally {
    a.runtime.dispose();
    b.runtime.dispose();
  }
  const mismatches: string[] = [];
  const limit = o.limit ?? 12;
  const note = (m: string): void => {
    if (mismatches.length < limit) mismatches.push(m);
    else if (mismatches.length === limit) mismatches.push('…');
  };
  let lightCalls = 0, maxParticles = 0, maxMeshInstances = 0;
  for (let i = 0; i < recA.length; i++) {
    const x = recA[i]!, y = recB[i];
    if (y === undefined) {
      note(`frame ${i}: B has no record`);
      continue;
    }
    lightCalls += x.lights === '' ? 0 : x.lights.split('\n').length;
    maxParticles = Math.max(maxParticles, x.particles);
    maxMeshInstances = Math.max(maxMeshInstances, meshInstances(x.buckets));
    for (const k of new Set([...x.buckets.keys(), ...y.buckets.keys()])) {
      if (x.buckets.get(k) !== y.buckets.get(k)) note(`frame ${i} ${k}: A ${x.buckets.get(k) ?? 'absent'} vs B ${y.buckets.get(k) ?? 'absent'}`);
    }
    if (x.effects !== y.effects || x.particles !== y.particles) note(`frame ${i}: counts A ${x.effects}/${x.particles} vs B ${y.effects}/${y.particles}`);
    if (x.lights !== y.lights) {
      const la = x.lights.split('\n'), lb = y.lights.split('\n');
      let at = 0;
      while (at < la.length && la[at] === lb[at]) at++;
      note(`frame ${i}: light calls differ at call ${at}: A ${la[at] ?? 'end'} | B ${lb[at] ?? 'end'} (A ${la.length}, B ${lb.length} calls)`);
    }
  }
  if (recB.length !== recA.length) note(`A recorded ${recA.length} frames, B ${recB.length}`);
  return { frames: recA.length, mismatches, lightCalls, maxParticles, maxMeshInstances, unpaintedFrames };
}
