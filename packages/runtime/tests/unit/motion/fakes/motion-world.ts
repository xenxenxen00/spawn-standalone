// A motion runtime over the real row store, for the MA4 tests: `createMotion` with its `anim` / `mixer` / `ik` channels
// registered on the store and its resolver as the store's attachment port, a tick stepper in the kernel's order (step H, then
// the next tick), row builders, a skin adapter that needs no three, and an FK that shares no code with `pose.ts`.
import { eulerYXZToQuat } from '../../../../src/compat/core/store/transform.ts';
import type { RowRec } from '../../../../src/compat/core/types.ts';
import { ClipRegistry } from '../../../../src/compat/motion/clip-registry.ts';
import type { Pose, PoseRig } from '../../../../src/compat/motion/pose.ts';
import { m4ComposeTRS } from '../../../../src/compat/motion/quat.ts';
import { createMotion, type Motion, type MotionOptions, type SkinAdapter, type SkinHandle } from '../../../../src/compat/motion/scheduler-hooks.ts';
import { storeFixture, type StoreFixture } from '../../core/store-fixture.ts';

export const DT = 1 / 30;

export interface Placed {
  at?: { x: number; y: number; z: number };
  yaw?: number;
  scale?: number;
}

export interface MotionWorld {
  f: StoreFixture;
  clock: { tick: number };
  registry: ClipRegistry;
  motion: Motion;
  /** step H of the running tick, then the clock moves to the next tick */
  tick(n?: number): void;
  spawn(id: string, placed?: Placed, extra?: Record<string, unknown>): { row: RowRec; h: Record<string, any> };
  /** a child that rides a bone of its parent (a probe when `local` is omitted) */
  attached(parent: string, name: string, bone: string, local?: { x: number; y: number; z: number }, props?: Record<string, unknown>): { row: RowRec; h: Record<string, any> };
  handle(id: string): Record<string, any>;
}

export function motionWorld(opts: Partial<MotionOptions> = {}): MotionWorld {
  const f = storeFixture();
  const clock = { tick: 0 };
  const registry = opts.registry ?? new ClipRegistry();
  const motion = createMotion({ ...opts, registry, rows: f.store, clock });
  motion.anim.register(f.store.channels);
  motion.ik.register(f.store.channels);
  f.ports.attach = motion.attach;
  const handle = (id: string): Record<string, any> => f.store.handle(f.store.get(id)!, 'platform') as Record<string, any>;
  return {
    f,
    clock,
    registry,
    motion,
    tick(n = 1) {
      for (let i = 0; i < n; i++) {
        motion.port.advanceTick(DT);
        clock.tick++;
      }
    },
    spawn(id, placed = {}, extra = {}) {
      const s = placed.scale ?? 1;
      const row = f.add({ id, transform: { pos: placed.at ?? { x: 0, y: 0, z: 0 }, rot: eulerYXZToQuat(placed.yaw ?? 0, 0, 0), scale: { x: s, y: s, z: s } }, ...extra });
      motion.anim.rowSpawned(row);
      return { row, h: handle(id) };
    },
    attached(parent, name, bone, local, props = {}) {
      const id = `${parent}/${name}`;
      const row = f.add({ id, parentId: parent, tags: ['probe'], props: { attachment: { bone }, visible: false, ...props }, transform: { pos: local ?? { x: 0, y: 0, z: 0 } } });
      return { row, h: handle(id) };
    },
    handle,
  };
}

/** the world matrix (16, column-major) of a body at `at` facing `yaw` degrees at uniform `scale` */
export function placedMatrix(p: Placed): Float64Array {
  const q = eulerYXZToQuat(p.yaw ?? 0, 0, 0);
  const at = p.at ?? { x: 0, y: 0, z: 0 };
  const s = p.scale ?? 1;
  return m4ComposeTRS(new Float64Array(16), 0, [at.x, at.y, at.z], 0, [q.x, q.y, q.z, q.w], 0, [s, s, s], 0);
}

export const transformPoint = (m: ArrayLike<number>, p: readonly number[]): [number, number, number] => [
  m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!,
  m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!,
  m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!,
];

// ── an FK that shares nothing with pose.ts (the form of origin's .spawn/tools/rig-inspect.mjs `pose`) ───────────────────────

type Q = [number, number, number, number];
type V = [number, number, number];
export const qmul = (a: readonly number[], b: readonly number[]): Q => [
  a[3]! * b[0]! + a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]!,
  a[3]! * b[1]! - a[0]! * b[2]! + a[1]! * b[3]! + a[2]! * b[0]!,
  a[3]! * b[2]! + a[0]! * b[1]! - a[1]! * b[0]! + a[2]! * b[3]!,
  a[3]! * b[3]! - a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]!,
];
export const qrot = (q: readonly number[], v: readonly number[]): V => {
  const [x, y, z, w] = q as Q;
  const t = [2 * (y * v[2]! - z * v[1]!), 2 * (z * v[0]! - x * v[2]!), 2 * (x * v[1]! - y * v[0]!)];
  return [v[0]! + w * t[0]! + (y * t[2]! - z * t[1]!), v[1]! + w * t[1]! + (z * t[0]! - x * t[2]!), v[2]! + w * t[2]! + (x * t[1]! - y * t[0]!)];
};

export interface Joint {
  p: V;
  q: Q;
  s: V;
}

/**
 * Model-space joints of a rig whose root bones sit under the identity: per bone a position, a rotation and a scale, from the
 * local rotations `localR(bone)` (default: bind) and translations `localT(bone)` (default: bind).
 */
export function fkJoints(rig: PoseRig, localR?: (bone: number) => readonly number[] | undefined, localT?: (bone: number) => readonly number[] | undefined): Joint[] {
  const out: Joint[] = new Array<Joint>(rig.bones.length);
  const done = new Uint8Array(rig.bones.length);
  const at = (i: number): Joint => {
    if (done[i]) return out[i]!;
    const lq = localR?.(i) ?? Array.from(rig.bindR.subarray(i * 4, i * 4 + 4));
    const lt = localT?.(i) ?? Array.from(rig.bindT.subarray(i * 3, i * 3 + 3));
    const ls = Array.from(rig.bindS.subarray(i * 3, i * 3 + 3));
    const p = rig.parent[i]!;
    let j: Joint;
    if (p < 0) j = { q: [lq[0]!, lq[1]!, lq[2]!, lq[3]!], p: [lt[0]!, lt[1]!, lt[2]!], s: [ls[0]!, ls[1]!, ls[2]!] };
    else {
      const P = at(p);
      const d = qrot(P.q, [lt[0]! * P.s[0], lt[1]! * P.s[1], lt[2]! * P.s[2]]);
      j = { q: qmul(P.q, lq), p: [P.p[0] + d[0], P.p[1] + d[1], P.p[2] + d[2]], s: [P.s[0] * ls[0]!, P.s[1] * ls[1]!, P.s[2] * ls[2]!] };
    }
    out[i] = j;
    done[i] = 1;
    return j;
  };
  for (let i = 0; i < rig.bones.length; i++) at(i);
  return out;
}

// ── a skin adapter without three ───────────────────────────────────────────────────────────────────────────────────────────

/** a "drawn model" of the tests: a rig, the row it belongs to, and the transform it is drawn at this frame */
export interface FakeInstance {
  rowId: string;
  rig: PoseRig;
  /** the row's world transform as drawn (the bridge writes it each frame) */
  body: Float64Array;
  /** rig model space → the row's local frame; default identity */
  normalisation?: Float64Array;
  /** per `apply`: the bones written */
  writes: number[];
  /** the model matrices as last applied (a copy) */
  applied: Float32Array | null;
  /** the root the last apply saw */
  appliedRoot: Float64Array | null;
}

export const fakeInstance = (rowId: string, rig: PoseRig, placed: Placed = {}): FakeInstance => ({ rowId, rig, body: placedMatrix(placed), writes: [], applied: null, appliedRoot: null });

const mul = (out: Float64Array, a: ArrayLike<number>, b: ArrayLike<number>): Float64Array => {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) r[c * 4 + row] = a[row]! * b[c * 4]! + a[4 + row]! * b[c * 4 + 1]! + a[8 + row]! * b[c * 4 + 2]! + a[12 + row]! * b[c * 4 + 3]!;
  out.set(r);
  return out;
};

/** Writes like the direct path of three-skin.ts: dirty bones, every bone when the root moved. */
export const fakeSkin: SkinAdapter = {
  bind(instance: unknown): SkinHandle | null {
    const i = instance as FakeInstance;
    if (i === null || typeof i !== 'object' || i.rig === undefined) return null;
    const rigWorld = (out: Float64Array): Float64Array => (i.normalisation ? mul(out, i.body, i.normalisation) : (out.set(i.body), out));
    return {
      rig: i.rig,
      rigWorld,
      bodyWorld: (out) => {
        out.set(i.body);
        return out;
      },
      apply(pose: Pose, dirty: Uint8Array): number {
        pose.updateModel();
        const root = rigWorld(new Float64Array(16));
        const all = i.appliedRoot === null || i.appliedRoot.some((v, k) => v !== root[k]);
        let n = 0;
        for (let b = 0; b < pose.count; b++) if (all || dirty[b] !== 0) n++;
        if (n > 0) i.applied = Float32Array.from(pose.model);
        i.appliedRoot = root;
        i.writes.push(n);
        return n;
      },
    };
  },
};
