// Synthetic articulated fixtures, clips, and an independent Three.js matrix FK oracle.
import { Euler, Matrix4, Vector3 } from 'three/webgpu';
import type { AuthoredClipObject } from '../../src/compat/motion/clip.ts';

export type Vec3 = [number, number, number];
export type SkeletonObject = Record<string, { parent?: string; pivot: Vec3 }>;

/** A 7-bone toy body: depth 3, no geometry on root, pivots in the model rest frame. */
export const TOY7: SkeletonObject = {
  root: { pivot: [0, 0, 0] },
  body: { parent: 'root', pivot: [0, 0.12, 0] },
  eyes: { parent: 'body', pivot: [0, 0.7, -0.42] },
  legL: { parent: 'root', pivot: [-0.17, 0.2, 0] },
  legR: { parent: 'root', pivot: [0.17, 0.2, 0] },
  armL: { parent: 'body', pivot: [-0.4, 0.52, 0] },
  armR: { parent: 'body', pivot: [0.4, 0.52, 0] },
};

/** A run cycle on the toy body, in the authored `anim/*.yml` form (pitch/yaw/roll degrees, x/y metres). */
export const RUN: AuthoredClipObject = {
  name: 'run',
  duration: 0.34,
  tracks: {
    legL: { pitch: [-45, 45, -45] },
    legR: { pitch: [45, -45, 45] },
    body: { pitch: [-10, -14, -10, -14, -10], y: [0, 0.07, 0, 0.07, 0], roll: [-5, 5, -5] },
    armL: { pitch: [50, -50, 50], roll: [30, 30, 30] },
    armR: { pitch: [-50, 50, -50], roll: [-30, -30, -30] },
  },
};

/** Two synthetic articulated frames: one shallow, one with a deeper attachment chain. */
export const PIECES: Record<'P' | 'N', SkeletonObject> = {
  P: {
    root: { pivot: [0, 0, 0] },
    body: { parent: 'root', pivot: [0, 1, 0] },
    armR: { parent: 'body', pivot: [1, 2, 0] },
    weapon: { parent: 'armR', pivot: [2, 2, 0] },
    armL: { parent: 'body', pivot: [-1, 2, 0] },
  },
  N: {
    root: { pivot: [0, 0, 0] },
    base: { parent: 'root', pivot: [0, 0.5, 0] },
    column: { parent: 'base', pivot: [0, 1.5, 0.5] },
    body: { parent: 'column', pivot: [0.5, 2.5, 0.5] },
    armR: { parent: 'body', pivot: [1.5, 3, 0.5] },
    weapon: { parent: 'armR', pivot: [2.5, 3, 1] },
    armL: { parent: 'column', pivot: [-1, 2, -0.5] },
    brace: { parent: 'base', pivot: [0.5, 0.5, -1] },
  },
};

/** Off-pivot markers exercise both rotation and inherited translation. */
export const MARKERS: Record<'P' | 'N', Record<string, [string, Vec3]>> = {
  P: { tip: ['weapon', [3, 2.5, 0.5]], chest: ['body', [0.5, 1, 0.5]], palm: ['armL', [-2, 2.5, -0.5]] },
  N: { tip: ['weapon', [3.5, 3.5, 1]], chest: ['body', [0.5, 3, 1]], palm: ['armL', [-1.5, 2.5, 0]], support: ['brace', [1, 0.5, -1.5]] },
};

/** Build each pivot transform analytically using Three.js Euler matrices, independent of runtime quaternion/FK code. */
export function referenceFk(S: SkeletonObject, pose: Record<string, number>, bone: string, p: Vec3): Vec3 {
  const point = new Vector3(...p);
  for (let current: string | undefined = bone; current && S[current]; current = S[current]!.parent) {
    const pivot = new Vector3(...S[current]!.pivot);
    const radians = (axis: string) => (pose[current + '.' + axis] ?? 0) * Math.PI / 180;
    const rotation = new Matrix4().makeRotationFromEuler(new Euler(radians('pitch'), radians('yaw'), radians('roll'), 'YXZ'));
    point.sub(pivot).applyMatrix4(rotation).add(pivot);
    point.y += pose[current + '.y'] ?? 0;
  }
  return point.toArray() as Vec3;
}

/** The flat pose as the `bones` row prop `builtin/tween` stores: `{ <bone>: { pitch, yaw, roll, y } }`. */
export function bonesProp(pose: Record<string, number>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [k, v] of Object.entries(pose)) {
    const [bone, ch] = k.split('.') as [string, string];
    (out[bone] ??= {})[ch] = v;
  }
  return out;
}

/** mulberry32 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random pose: every non-root bone gets pitch / yaw / roll in ±range degrees and y in ±0.1 m. */
export function randomPose(S: SkeletonObject, r: () => number, range = 80): Record<string, number> {
  const pose: Record<string, number> = {};
  for (const b of Object.keys(S)) {
    if (S[b]!.parent === undefined) continue;
    pose[`${b}.pitch`] = (r() * 2 - 1) * range;
    pose[`${b}.yaw`] = (r() * 2 - 1) * range;
    pose[`${b}.roll`] = (r() * 2 - 1) * range;
    pose[`${b}.y`] = (r() * 2 - 1) * 0.1;
  }
  return pose;
}

export const dist = (a: ArrayLike<number>, b: ArrayLike<number>): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
