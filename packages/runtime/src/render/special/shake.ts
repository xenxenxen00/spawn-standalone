// The `shake` act (docs/design/rendering.md §10.7; WP R12a, the old R16): `shake {target, intensity, duration}` (3 live emits:
// scripts/director/spawner.js:223, scripts/enemies/react.js:69, scripts/map/door.js:190). A presentation-only positional
// jitter of the target row's object in the render bridge (`RenderBridge.setRowOffset`): decaying noise of amplitude
// `SHAKE_AMPLITUDE_M × intensity` [I] over `duration` seconds of presentation time, then the offset is taken off. The row's
// simulated transform is untouched. A second shake of the same target replaces the first. Draws nothing: no program.
import type { Vec3 } from '../../compat/core/types.ts';

/** metres at intensity 1 [I] */
export const SHAKE_AMPLITUDE_M = 0.04;
/** the shake's duration when the act gives none [I] */
export const SHAKE_DEFAULT_S = 0.3;
/** the noise frequencies per axis, rad/s [I]: incommensurate, so the path never repeats within a shake */
const FREQ = [47.3, 53.9, 61.1] as const;

export interface ShakeAct {
  target: string;
  intensity: number;
  duration: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function shakeActOf(payload: unknown): ShakeAct | null {
  if (!isObj(payload) || typeof payload['target'] !== 'string' || payload['target'] === '') return null;
  const intensity = fin(payload['intensity']) ? Math.max(0, payload['intensity']) : 1;
  const duration = fin(payload['duration']) && payload['duration'] > 0 ? payload['duration'] : SHAKE_DEFAULT_S;
  return { target: payload['target'], intensity, duration };
}

/** the offset of a shake `t` seconds in (zero at and after its end) */
export function shakeOffset(act: ShakeAct, t: number, phase: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const k = t >= act.duration ? 0 : 1 - t / act.duration;
  const a = SHAKE_AMPLITUDE_M * act.intensity * k * k;
  if (a === 0) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }
  out.x = a * Math.sin(FREQ[0] * t + phase);
  out.y = a * 0.5 * Math.sin(FREQ[1] * t + phase * 1.7);
  out.z = a * Math.sin(FREQ[2] * t + phase * 2.3);
  return out;
}

export interface RowShakerOptions {
  /** `RenderBridge.setRowOffset` */
  setRowOffset(rowId: string, offset: Readonly<Vec3> | null): void;
}

interface Running {
  act: ShakeAct;
  t: number;
  phase: number;
}

export class RowShaker {
  readonly #opts: RowShakerOptions;
  readonly #running = new Map<string, Running>();
  readonly #offset: Vec3 = { x: 0, y: 0, z: 0 };
  #count = 0;

  constructor(opts: RowShakerOptions) {
    this.#opts = opts;
  }

  /** the `shake` act: false when the payload is unusable */
  shake(payload: unknown): boolean {
    const act = shakeActOf(payload);
    if (act === null) return false;
    this.#running.set(act.target, { act, t: 0, phase: (this.#count++ * 2.399963) % (2 * Math.PI) });
    this.#opts.setRowOffset(act.target, shakeOffset(act, 0, this.#running.get(act.target)!.phase, this.#offset));
    return true;
  }

  /** advances every shake by the frame's presentation seconds */
  update(dtS: number): void {
    for (const [id, r] of this.#running) {
      r.t += Math.max(0, dtS);
      if (r.t >= r.act.duration) {
        this.#running.delete(id);
        this.#opts.setRowOffset(id, null);
        continue;
      }
      this.#opts.setRowOffset(id, shakeOffset(r.act, r.t, r.phase, this.#offset));
    }
  }

  get active(): number {
    return this.#running.size;
  }

  dispose(): void {
    for (const id of this.#running.keys()) this.#opts.setRowOffset(id, null);
    this.#running.clear();
  }
}
