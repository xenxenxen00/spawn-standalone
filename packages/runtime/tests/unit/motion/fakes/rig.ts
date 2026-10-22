// Test rigs for the mixer tests (WP MA3): plain `PoseRig` data built without `motion/rig.ts` (MA2), so the mixer tests do not
// depend on it. `bindModel` is computed here with the quat helpers alone, independently of `pose.ts`, so a test that compares
// the two is a real cross-check.
import { type CompiledClip, type Track, type TrackInterp, type TrackProp, makeTrack } from '../../../../src/compat/motion/clip.ts';
import type { PoseRig } from '../../../../src/compat/motion/pose.ts';
import { m4ComposeTRS, m4Mul, qFromEulerXYZDeg } from '../../../../src/compat/motion/quat.ts';

export interface BoneDef {
  name: string;
  /** parent bone name; null = root */
  parent: string | null;
  t?: readonly [number, number, number];
  /** bind rotation as [pitch, yaw, roll] degrees (X·Y·Z) */
  rDeg?: readonly [number, number, number];
  s?: readonly [number, number, number];
}

/** A rig from bone definitions; `above` puts a matrix (16, column-major) over one root bone, as `rig.ts` does for armature nodes. */
export function makeRig(id: string, defs: readonly BoneDef[], opts: { above?: Record<string, readonly number[]> } = {}): PoseRig {
  const n = defs.length;
  const bones = defs.map((d) => d.name);
  const lookup = new Map(bones.map((b, i) => [b, i] as const));
  const parent = new Int16Array(n);
  const bindT = new Float32Array(n * 3);
  const bindR = new Float32Array(n * 4);
  const bindS = new Float32Array(n * 3);
  defs.forEach((d, i) => {
    parent[i] = d.parent === null ? -1 : (lookup.get(d.parent) ?? -1);
    bindT.set(d.t ?? [0, 0, 0], i * 3);
    bindS.set(d.s ?? [1, 1, 1], i * 3);
    const e = d.rDeg ?? [0, 0, 0];
    qFromEulerXYZDeg(bindR, i * 4, e[0], e[1], e[2]);
  });
  const model = new Float64Array(n * 16);
  const done = new Uint8Array(n);
  const local = new Float64Array(16);
  const resolve = (i: number): void => {
    if (done[i]) return;
    const p = parent[i]!;
    if (p >= 0) resolve(p);
    // from the Float32 bind arrays, as a rig built from a glTF file has them
    m4ComposeTRS(local, 0, bindT, i * 3, bindR, i * 4, bindS, i * 3);
    const above = opts.above?.[bones[i]!];
    if (p >= 0) m4Mul(model, i * 16, model, p * 16, local, 0);
    else if (above) m4Mul(model, i * 16, [...above], 0, local, 0);
    else model.set(local, i * 16);
    done[i] = 1;
  };
  for (let i = 0; i < n; i++) resolve(i);
  const hips = lookup.get('Hips') ?? -1;
  return {
    id,
    bones,
    parent,
    bindT,
    bindR,
    bindS,
    bindModel: Float32Array.from(model),
    hipsRestHeight: hips >= 0 ? model[hips * 16 + 13]! : 0,
    index: (name) => lookup.get(name) ?? -1,
  };
}

/** Hips → Spine → Head, plus two legs: small enough to hand-check. Hips rests 1 m up; nothing is rotated at bind. */
export function smallRig(id = 'test.small'): PoseRig {
  return makeRig(id, [
    { name: 'Hips', parent: null, t: [0, 1, 0] },
    { name: 'Spine', parent: 'Hips', t: [0, 0.3, 0] },
    { name: 'Head', parent: 'Spine', t: [0, 0.4, 0] },
    { name: 'LeftLeg', parent: 'Hips', t: [0.1, -0.5, 0] },
    { name: 'RightLeg', parent: 'Hips', t: [-0.1, -0.5, 0] },
  ]);
}

/** The same bones with rotated, scaled bind transforms: bind is not the identity anywhere, so delta composition is visible. */
export function tiltedRig(id = 'test.tilted'): PoseRig {
  return makeRig(id, [
    { name: 'Hips', parent: null, t: [0, 0.8, 0], rDeg: [0, 0, 90] },
    { name: 'Spine', parent: 'Hips', t: [0, 0.5, 0], rDeg: [20, 0, 0], s: [1, 2, 1] },
    { name: 'Head', parent: 'Spine', t: [0.2, 0, 0], rDeg: [0, 90, 0] },
    { name: 'LeftLeg', parent: 'Hips', t: [0.1, -0.5, 0], rDeg: [10, 20, 30] },
    { name: 'RightLeg', parent: 'Hips', t: [-0.1, -0.5, 0] },
  ]);
}

/** the 24 bones of the live enemy rigs (tests/spawn-suite/oracle/enemy-motion.test.mjs BONES), in a plausible hierarchy */
export const HUMANOID_BONES: ReadonlyArray<readonly [string, string | null]> = [
  ['Hips', null],
  ['LeftUpLeg', 'Hips'],
  ['LeftLeg', 'LeftUpLeg'],
  ['LeftFoot', 'LeftLeg'],
  ['LeftToeBase', 'LeftFoot'],
  ['RightUpLeg', 'Hips'],
  ['RightLeg', 'RightUpLeg'],
  ['RightFoot', 'RightLeg'],
  ['RightToeBase', 'RightFoot'],
  ['Spine02', 'Hips'],
  ['Spine01', 'Spine02'],
  ['Spine', 'Spine01'],
  ['LeftShoulder', 'Spine'],
  ['LeftArm', 'LeftShoulder'],
  ['LeftForeArm', 'LeftArm'],
  ['LeftHand', 'LeftForeArm'],
  ['neck', 'Spine'],
  ['Head', 'neck'],
  ['head_end', 'Head'],
  ['headfront', 'Head'],
  ['RightShoulder', 'Spine'],
  ['RightArm', 'RightShoulder'],
  ['RightForeArm', 'RightArm'],
  ['RightHand', 'RightForeArm'],
];

export function humanoidRig(id = 'test.humanoid'): PoseRig {
  return makeRig(
    id,
    HUMANOID_BONES.map(([name, parent], i) => ({
      name,
      parent,
      t: parent === null ? [0, 0.97, 0] : [((i % 3) - 1) * 0.08, i % 2 === 0 ? 0.12 : -0.2, 0.01 * i],
      rDeg: [i * 3, -i * 2, i],
    })),
  );
}

export interface TrackDef {
  bone: string;
  prop: TrackProp;
  times: readonly number[];
  values: readonly number[];
  interp?: TrackInterp;
}

export const track = (d: TrackDef): Track => makeTrack(d.bone, d.prop, d.interp ?? 'linear', d.times, d.values);

/** a CompiledClip from track definitions */
export function clipOf(id: string, kind: 'absolute' | 'delta', duration: number, tracks: readonly TrackDef[], extra: Partial<CompiledClip> = {}): CompiledClip {
  return { id, kind, duration, tracks: tracks.map(track), ...extra };
}

/** [x, y, z, w] of `qX(pitch)·qY(yaw)·qZ(roll)` degrees */
export const quat = (pitch: number, yaw: number, roll: number): number[] => qFromEulerXYZDeg([0, 0, 0, 0], 0, pitch, yaw, roll);
