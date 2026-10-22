// Program retention (docs/design/rendering.md §7.2 the warm-up, §15.2 the runtime tier switch; WP R14b).
//
// three's `Pipelines` counts the users of every programmable stage (one shader) and of every render pipeline (one linked GL
// program, keyed by its two stages) and forgets either the moment its last user goes (`_releaseProgram`,
// `_releasePipeline`). A user goes whenever a render object is disposed: its material or its object is disposed, or its cache
// key changed. three disposes the old render object before it builds the one that replaces it (`RenderObjects.get`), so a
// program whose text the next build writes again is compiled and linked again. That is what a runtime tier switch did
// [M, R14b SwiftShader diagnostic, a scene fixture, medium → low at a safe boundary: 13 programs linked during gameplay]: the post graph
// is built anew (new nodes, new cache keys), so the output quad and the seven bloom quads were released and linked again
// with the same text, and every lit surface left the shadowCaster's shadow state it was drawn in, whose programs went with
// their last drawn user, also when the warm-up had linked them before. On the WebGL2 backend the forgotten program is not
// even deleted (three never calls `deleteProgram` or `deleteShader`): the relink is all cost.
//
// `retainPrograms` turns the forget into a keep. An idle stage stays in `programs[stage]` and an idle pipeline in `caches`,
// so the next user of the same text takes both back: no compile, no link. With stable program text (stable-programs.ts)
// "linked once behind the LOADING hold" then means "linked for the session": the warm-up links both shadow states and every
// post graph a tier switch can reach (render/world/install.ts, post/render-pipeline.ts `warmTiers`), and the switch links
// nothing. A stage or pipeline in use is never touched, and nothing three would not have released is ever released.
//
// Bounded: at most `RETAINED_IDLE_STAGES` idle stages and `RETAINED_IDLE_PIPELINES` idle pipelines are kept. Beyond that
// the one idle the longest is released, as three would have released it at once. The texts the content asks for are far
// fewer: the warm-up's enumeration in two shadow states, the surfaces of the built maps, two post graphs per look.
//
// This relies on three internals (render §20 risk 2): `renderer._pipelines` after `init()`, and its two release methods,
// called with the stage or pipeline whose `usedTimes` reached 0. tests/unit/render/program-retention.three.test.ts runs the
// retention on three's own `Pipelines` and fails if an upgrade changes them.
import type { WebGPURenderer } from 'three/webgpu';

/** idle programmable stages kept at most (a vertex and a fragment stage per program; vertex stages are widely shared) */
export const RETAINED_IDLE_STAGES = 512;
/** idle render pipelines (linked programs) kept at most */
export const RETAINED_IDLE_PIPELINES = 256;

interface Counted {
  usedTimes: number;
}

/** what the retention touches of three's `Pipelines` (r186) */
export interface RetainablePipelines {
  _releaseProgram(program: Counted): void;
  _releasePipeline(pipeline: Counted): void;
}

export interface ProgramRetentionLimits {
  stages: number;
  pipelines: number;
}

export interface ProgramRetention {
  /** stages whose last user went, kept for the next one */
  readonly idleStages: number;
  /** linked programs whose last user went, kept for the next one */
  readonly idlePipelines: number;
  /** released because more than the limit were idle */
  readonly evicted: number;
  /** puts three's own release back; what is idle now stays cached */
  uninstall(): void;
}

/** marks a `Pipelines` already retained (an install twice must not wrap twice) */
const RETAINED = Symbol.for('ss.programRetention');

const isRetainable = (p: unknown): p is RetainablePipelines =>
  typeof p === 'object' && p !== null && typeof (p as RetainablePipelines)._releaseProgram === 'function' && typeof (p as RetainablePipelines)._releasePipeline === 'function';

/** Adds `x` to the idle set of its kind (insertion order is age). Returns how many it released past the limit. */
function keep<T extends Counted>(idle: Set<T>, x: T, limit: number, release: (y: T) => void): number {
  idle.delete(x);
  // three releases at 0 users only; anything else is not idle and not ours to keep
  if (x.usedTimes > 0) return 0;
  idle.add(x);
  if (idle.size <= limit) return 0;
  // taken back since they went idle: in use again, not idle
  for (const y of idle) if (y.usedTimes > 0) idle.delete(y);
  let released = 0;
  while (idle.size > limit) {
    const oldest = idle.values().next().value as T;
    idle.delete(oldest);
    release(oldest);
    released++;
  }
  return released;
}

/** the idle ones of a set; those taken back since leave it */
function idleCount(idle: Set<Counted>): number {
  for (const y of idle) if (y.usedTimes > 0) idle.delete(y);
  return idle.size;
}

/** Keeps the programs of `pipelines` cached past their last user (see the header). A second call returns the first one's. */
export function retainPrograms(pipelines: RetainablePipelines, limits: ProgramRetentionLimits = { stages: RETAINED_IDLE_STAGES, pipelines: RETAINED_IDLE_PIPELINES }): ProgramRetention {
  const marked = pipelines as RetainablePipelines & { [RETAINED]?: ProgramRetention };
  const existing = marked[RETAINED];
  if (existing !== undefined) return existing;
  if (!(limits.stages >= 0) || !(limits.pipelines >= 0)) throw new RangeError(`program retention: the limits must be ≥ 0, got ${JSON.stringify(limits)}`);
  const releaseProgram = pipelines._releaseProgram;
  const releasePipeline = pipelines._releasePipeline;
  const stages = new Set<Counted>();
  const linked = new Set<Counted>();
  let evicted = 0;
  const keepProgram = (program: Counted): void => {
    evicted += keep(stages, program, limits.stages, (y) => releaseProgram.call(pipelines, y));
  };
  const keepPipeline = (pipeline: Counted): void => {
    evicted += keep(linked, pipeline, limits.pipelines, (y) => releasePipeline.call(pipelines, y));
  };
  pipelines._releaseProgram = keepProgram;
  pipelines._releasePipeline = keepPipeline;
  const retention: ProgramRetention = {
    get idleStages(): number {
      return idleCount(stages);
    },
    get idlePipelines(): number {
      return idleCount(linked);
    },
    get evicted(): number {
      return evicted;
    },
    uninstall(): void {
      if (pipelines._releaseProgram === keepProgram) pipelines._releaseProgram = releaseProgram;
      if (pipelines._releasePipeline === keepPipeline) pipelines._releasePipeline = releasePipeline;
      if (marked[RETAINED] === retention) delete marked[RETAINED];
    },
  };
  marked[RETAINED] = retention;
  return retention;
}

/**
 * Installs the retention on a renderer (after `init()`: three makes its `Pipelines` there). Null on a renderer that has none
 * (a stand-in of the unit tests).
 */
export function installProgramRetention(renderer: WebGPURenderer): ProgramRetention | null {
  const pipelines = (renderer as unknown as { _pipelines?: unknown })._pipelines;
  return isRetainable(pipelines) ? retainPrograms(pipelines) : null;
}
