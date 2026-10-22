// `ctx.bone(name)` in a scripted-geometry run (plan item K3; INTEGRATION.md hook H1): every triangle emitted after a call
// belongs wholly to that bone until the next call (rigid binding, engine skills/geometry.md:17). The recorder of
// `render/geometry/recorder.ts` makes its ctx a plain extensible object, so the cursor installs `ctx.bone` on it and records
// the triangle count at each call; the recorder itself is unchanged. `triBone()` turns the runs into one bone index per
// triangle, in emission order (the order of `RecordedMesh.positions`).
//
// Triangles emitted before the first call belong to the first root bone (no live generator does that: the cursor counts
// them in `unbound`). An unknown bone name throws in strict runs and binds to the first root otherwise (counted in `unknown`).
import type { PoseRig } from '../../compat/motion/pose.ts';

/** what the cursor needs of a recording (`render/geometry/recorder.ts` `Recording` satisfies it) */
export interface TriangleCounter {
  readonly ctx: object;
  readonly tris: () => number;
}

export interface BoneCursor {
  /** one bone index per triangle (rig order), for the `count` triangles recorded so far */
  triBone(count?: number): Uint16Array;
  /** triangles emitted before the first `ctx.bone` */
  readonly unbound: number;
  /** `ctx.bone` calls with a name the rig lacks */
  readonly unknown: number;
  /** names of the bones used, in order of first use */
  readonly used: readonly string[];
}

export class UnknownBoneError extends Error {
  override readonly name = 'UnknownBoneError';
}

/** Installs `ctx.bone` on a recording's ctx. */
export function attachBoneCursor(rec: TriangleCounter, rig: PoseRig, opts: { strict?: boolean; script?: string } = {}): BoneCursor {
  let fallback = 0;
  for (let b = 0; b < rig.bones.length; b++) {
    if (rig.parent[b]! < 0) {
      fallback = b;
      break;
    }
  }
  /** run starts: [triangle index, bone] */
  const runs: number[] = [];
  const used: string[] = [];
  let unknown = 0;
  let calls = 0;
  let firstAt = 0;
  (rec.ctx as Record<string, unknown>)['bone'] = (name: unknown): void => {
    let b = typeof name === 'string' ? rig.index(name) : -1;
    if (b < 0) {
      if (opts.strict) throw new UnknownBoneError(`${opts.script ?? 'geometry'}: ctx.bone(${JSON.stringify(name)}) names no bone of the skeleton`);
      unknown++;
      b = fallback;
    } else if (!used.includes(rig.bones[b]!)) used.push(rig.bones[b]!);
    const at = rec.tris();
    if (calls === 0) firstAt = at;
    calls++;
    runs.push(at, b);
  };
  return {
    triBone(count = rec.tris()) {
      const out = new Uint16Array(count).fill(fallback);
      for (let i = 0; i < runs.length; i += 2) {
        const start = runs[i]!;
        const end = i + 2 < runs.length ? runs[i + 2]! : count;
        if (start < count) out.fill(runs[i + 1]!, start, Math.min(end, count));
      }
      return out;
    },
    get unbound() {
      return calls === 0 ? rec.tris() : firstAt;
    },
    get unknown() {
      return unknown;
    },
    used,
  };
}
