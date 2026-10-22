// The `squash` act (K8; engine api-reference.md:676): `squash { target, axis = "y", intensity = 0.3, duration = 0.15 }`.
// A presentation-only squash of the target row's drawn object through the bridge's `setRowScale`: the scale along `axis` is cut
// by `intensity` at the deepest point of the squash (a quarter of the way in), then springs back to 1 over the rest of
// `duration`; the other two axes bulge so the volume stays [I] (the docs only say the axis "shortens by intensity and recovers").
// The row's simulated scale is untouched. A second squash of the same target replaces the first. Draws nothing: no program.
import type { Vec3 } from '../../compat/core/types.ts';

export const SQUASH_DEFAULTS = Object.freeze({ axis: 'y' as SquashAxis, intensity: 0.3, duration: 0.15 });
/** the fraction of the duration at which the squash is deepest [I] */
export const SQUASH_PEAK = 0.25;
/** the axis never goes below this, so a huge intensity cannot invert or zero the row */
const MIN_AXIS = 0.05;

export type SquashAxis = 'x' | 'y' | 'z';

export interface SquashAct {
  target: string;
  axis: SquashAxis;
  intensity: number;
  duration: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function squashActOf(payload: unknown): SquashAct | null {
  if (!isObj(payload) || typeof payload['target'] !== 'string' || payload['target'] === '') return null;
  const axis = payload['axis'];
  return {
    target: payload['target'],
    axis: axis === 'x' || axis === 'y' || axis === 'z' ? axis : SQUASH_DEFAULTS.axis,
    intensity: fin(payload['intensity']) ? Math.max(0, payload['intensity']) : SQUASH_DEFAULTS.intensity,
    duration: fin(payload['duration']) && payload['duration'] > 0 ? payload['duration'] : SQUASH_DEFAULTS.duration,
  };
}

/** how deep the squash is `t` seconds in: 0 at the start and from the end on, 1 at the deepest point */
export function squashDepth(act: SquashAct, t: number): number {
  const u = t / act.duration;
  if (!(u > 0) || u >= 1) return 0;
  if (u < SQUASH_PEAK) return u / SQUASH_PEAK;
  const k = (u - SQUASH_PEAK) / (1 - SQUASH_PEAK);
  return 1 - k * k * (3 - 2 * k);
}

/** the per-axis factor on the row's scale `t` seconds in */
export function squashFactor(act: SquashAct, t: number, out: Vec3 = { x: 1, y: 1, z: 1 }): Vec3 {
  const axisScale = Math.max(MIN_AXIS, 1 - act.intensity * squashDepth(act, t));
  const side = 1 / Math.sqrt(axisScale);
  out.x = act.axis === 'x' ? axisScale : side;
  out.y = act.axis === 'y' ? axisScale : side;
  out.z = act.axis === 'z' ? axisScale : side;
  return out;
}

export interface RowSquasherOptions {
  /** `RenderBridge.setRowScale` */
  setRowScale(rowId: string, factor: Readonly<Vec3> | null): void;
}

interface Running {
  act: SquashAct;
  t: number;
}

export class RowSquasher {
  readonly #opts: RowSquasherOptions;
  readonly #running = new Map<string, Running>();
  readonly #factor: Vec3 = { x: 1, y: 1, z: 1 };

  constructor(opts: RowSquasherOptions) {
    this.#opts = opts;
  }

  /** the `squash` act: false when the payload is unusable */
  squash(payload: unknown): boolean {
    const act = squashActOf(payload);
    if (act === null) return false;
    this.#running.set(act.target, { act, t: 0 });
    this.#opts.setRowScale(act.target, squashFactor(act, 0, this.#factor));
    return true;
  }

  /** advances every squash by the frame's presentation seconds */
  update(dtS: number): void {
    for (const [id, r] of this.#running) {
      r.t += Math.max(0, dtS);
      if (r.t >= r.act.duration) {
        this.#running.delete(id);
        this.#opts.setRowScale(id, null);
        continue;
      }
      this.#opts.setRowScale(id, squashFactor(r.act, r.t, this.#factor));
    }
  }

  get active(): number {
    return this.#running.size;
  }

  dispose(): void {
    for (const id of this.#running.keys()) this.#opts.setRowScale(id, null);
    this.#running.clear();
  }
}
