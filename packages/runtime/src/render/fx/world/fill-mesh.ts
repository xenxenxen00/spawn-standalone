// The mesh-sink fill (render §13.4; DR-53): every `r=mesh(…)` particle as one box instance of its space's bucket (world, or the
// camera's for a `follow=camera` effect): matrix, albedo, emissive (+ roughness) and extra. Three-free, run on the primitive
// bucket's own arrays in-process (render/mesh-buckets.ts) and on the transfer buffer in the fx Worker: `FxRuntime#updateMeshes`
// as it stood before the move (tests/unit/render/fx/legacy/fx-system.legacy.ts), operation for operation, with F1 fixed the same
// way there and here (DR-54 1): each space's total is known before anything is written, so its bucket grows once, first.
import type { FxSimulation } from '../sim/simulator.ts';
import type { FxSpace } from '../fx-protocol.ts';
import { applyPointInto, composeInto, point, rotationFromY, rotationIdentity } from './fx-math.ts';

export interface MeshArrays {
  readonly matrices: Float32Array;
  readonly albedo: Float32Array;
  readonly emissive: Float32Array;
  readonly extra: Float32Array;
}

/** where a space's instances go this frame */
export interface MeshTargets {
  /**
   * An effect of this frame lives in `space`: called once per frame and space, in the order the spaces are first seen among the
   * effects (the in-process bucket is made on its first such frame and emptied here).
   */
  use(space: FxSpace): void;
  /**
   * The arrays of a used `space` for its `count` instances, called after every `use`, world before camera, before anything is
   * written (the in-process bucket grows here, once; the worker takes a buffer). Null: nothing is drawn in that space.
   */
  arrays(space: FxSpace, count: number): MeshArrays | null;
}

/** what a fill wrote: the instances per space, and which spaces an effect lived in */
export interface MeshFill {
  world: number;
  camera: number;
  usedWorld: boolean;
  usedCamera: boolean;
}

/** Fills the mesh sinks of `sims` (the live effects, in their order). `inverse`: the camera's inverse world matrix, or null. */
export function fillMeshes(sims: readonly FxSimulation[], hasCamera: boolean, inverse: Float64Array | null, roughness: number, targets: MeshTargets, out: MeshFill): void {
  let usedWorld = false, usedCamera = false, totalWorld = 0, totalCamera = 0;
  for (const sim of sims) {
    const cameraSpace = sim.program.header.follow === 'camera' && hasCamera;
    if (cameraSpace) {
      if (!usedCamera) targets.use('camera');
      usedCamera = true;
    } else {
      if (!usedWorld) targets.use('world');
      usedWorld = true;
    }
    for (const pop of sim.populations) {
      if (pop.program.sink?.kind !== 'mesh') continue;
      if (cameraSpace) totalCamera += pop.count;
      else totalWorld += pop.count;
    }
  }
  const world = usedWorld ? targets.arrays('world', totalWorld) : null;
  const camera = usedCamera ? targets.arrays('camera', totalCamera) : null;
  let atWorld = 0, atCamera = 0;
  for (const sim of sims) {
    const cameraSpace = sim.program.header.follow === 'camera' && hasCamera;
    const t = cameraSpace ? camera : world;
    if (t === null) continue;
    const matrices = t.matrices, albedo = t.albedo, emissive = t.emissive, extra = t.extra;
    const positions = sim.positions, velocities = sim.velocities, sizes = sim.sizes, color = sim.rgba;
    for (const pop of sim.populations) {
      const sink = pop.program.sink;
      if (sink?.kind !== 'mesh') continue;
      const aligned = sink.align === 'velocity';
      const sx = sink.sx, sy = sink.sy, sz = sink.sz;
      const indices = pop.indices, count = pop.count;
      for (let slot = 0; slot < count; slot++) {
        const i = indices[slot]!;
        const at = cameraSpace ? atCamera++ : atWorld++;
        const m = at * 16, c = i * 4, p = i * 3;
        let px = positions[p]!, py = positions[p + 1]!, pz = positions[p + 2]!;
        if (cameraSpace && inverse !== null) {
          // Object3D.worldToLocal of the camera
          applyPointInto(inverse, px, py, pz);
          px = point[0]!; py = point[1]!; pz = point[2]!;
        }
        const vx = velocities[p]!, vy = velocities[p + 1]!, vz = velocities[p + 2]!;
        if (aligned && vx * vx + vy * vy + vz * vz > 1e-8) {
          // Vector3.normalize: divideScalar(length() || 1), i.e. each component times 1 / length
          const k = 1 / (Math.sqrt(vx * vx + vy * vy + vz * vz) || 1);
          rotationFromY(vx * k, vy * k, vz * k);
        } else rotationIdentity();
        const size = sizes[i]!;
        composeInto(matrices, m, px, py, pz, sx * size, sy * size, sz * size);
        const paint = at * 4;
        const r = color[c]!, g = color[c + 1]!, b = color[c + 2]!;
        albedo[paint] = Math.min(r, 1);
        emissive[paint] = Math.max(r - 1, 0);
        albedo[paint + 1] = Math.min(g, 1);
        emissive[paint + 1] = Math.max(g - 1, 0);
        albedo[paint + 2] = Math.min(b, 1);
        emissive[paint + 2] = Math.max(b - 1, 0);
        albedo[paint + 3] = 1;
        emissive[paint + 3] = roughness;
        extra[paint] = 0;
        extra[paint + 1] = 1;
        extra[paint + 2] = 1;
        extra[paint + 3] = 0;
      }
    }
  }
  out.world = atWorld;
  out.camera = atCamera;
  out.usedWorld = usedWorld;
  out.usedCamera = usedCamera;
}

/** the four arrays of a mesh transfer buffer of `count` instances: [matrices 16n | albedo 4n | emissive 4n | extra 4n] */
export function meshViews(buf: Float32Array, count: number): MeshArrays {
  return {
    matrices: buf.subarray(0, count * 16),
    albedo: buf.subarray(count * 16, count * 20),
    emissive: buf.subarray(count * 20, count * 24),
    extra: buf.subarray(count * 24, count * 28),
  };
}
