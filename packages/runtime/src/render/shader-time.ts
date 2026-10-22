// Spawn shader time, the `time` node of `builtin/tsl` (engine/api-reference.md:1612: "Shader time is seconds:
// (ctx.now() / 1000) % 3600"; engine-threejs.md §4; X-11). three's own `time` is `uniform(0).onRenderUpdate(frame => frame.time)`,
// accumulated from performance.now() since the renderer started, so it would keep running while the game is paused. Ours is a
// plain uniform with no update hook: the frame driver writes it once per rendered frame from the PresentationClock
// (presentation time without pauses, frozen by hitstop), so every TSL graph that reads `time` (live: scripts/trail/mat.js)
// pauses with the game. Until the render lane calls `setShaderTime`, it reads 0.
import { uniform } from 'three/tsl';

/** shader time wraps every hour, as on Spawn (keeps float32 precision in the shader) */
export const SHADER_TIME_WRAP_S = 3600;

/** the node `builtin/tsl` exports as `time` (one instance per page: every material shares it) */
export const shaderTime = uniform(0).setName('ssTime');

/** `(presentationNowMs / 1000) % 3600`, in seconds */
export function shaderTimeSeconds(presentationNowMs: number): number {
  if (!Number.isFinite(presentationNowMs) || presentationNowMs < 0) {
    throw new RangeError(`shader time: presentation time must be a finite, non-negative ms value, got ${presentationNowMs}`);
  }
  return (presentationNowMs / 1000) % SHADER_TIME_WRAP_S;
}

/** The render lane's per-frame hook: `presentationNowMs` is `PresentationClock.now()` (X-11). */
export function setShaderTime(presentationNowMs: number): void {
  shaderTime.value = shaderTimeSeconds(presentationNowMs);
}
