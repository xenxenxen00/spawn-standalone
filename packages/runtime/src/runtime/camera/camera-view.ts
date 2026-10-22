// The views the camera publishes each frame (io §5.6, §5.1 step 7; core §15.7; WP CA1).
//
//   consumer                         value                                       before the first camera frame
//   UI / any ctx `ctx.view.camera`   { eye, aim: forward, fov: vfovDeg }         null (scripts/ui/view.js:32 falls back)
//   rig `ctx.self.view`              { yaw, pitch }, the presented look          undefined (contract §11.2)
//   rig, viewmodel `ctx.world.camera` { aspect, fov }                            {} (the rig falls back to 16:9)
//   body input axes                  aimYawSin / aimYawCos / aimPitchN of the look, for the next body delivery (player.js:32-34)
//   audio listener                   { eye, forward, up }                        the engine's own origin (io §2.3)
// The first three are the kernel's `CameraPort` (ports.ts), answered from a `ViewState` the rig host owns; the aim axes go to
// the input log and the listener to the audio engine. `eye`, `aim` and `fov` are the frame's final camera (juice offsets
// included); `look` is the ownership result without them, so shake never feeds back into the rig, the body or the gun.
// `aspect` is render's camera aspect (canvas width / height); the key is left out while no engine exists. The HUD anchors
// are not published here: they read this frame's three camera through render's `project()` (render §4.2).
import type { CameraPort } from '../../compat/core/ports.ts';
import type { Vec3 } from '../../compat/core/types.ts';
import type { ListenerPose } from '../audio/types.ts';
import type { LookView } from '../input/look.ts';
import type { Presented } from './camera-presenter.ts';

/** what the camera port answers from; one per rig host */
export interface ViewState {
  camera: { eye: Vec3; aim: Vec3; fov: number } | null;
  look: LookView | undefined;
  aspect: number | undefined;
  fov: number | undefined;
}

/** one frame's values */
export interface FrameView {
  /** the frame's final camera (CameraPresenter.presented) */
  presented: Presented;
  /** the presented look without juice */
  look: LookView;
  /** render's camera aspect; undefined while no engine exists */
  aspect: number | undefined;
}

export interface ViewSinks {
  state: ViewState;
  /** InputLog: the aim axes of the next body delivery */
  input?: { setAimView(view: LookView | undefined): void } | null | undefined;
  /** AudioEngine */
  audio?: { setListener(pose: ListenerPose): void } | null | undefined;
}

const copy3 = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

export function createViewState(): ViewState {
  return { camera: null, look: undefined, aspect: undefined, fov: undefined };
}

/** io §5.1 step 7 */
export function publishView(sinks: ViewSinks, v: FrameView): void {
  const { state } = sinks;
  const { presented } = v;
  state.camera = { eye: copy3(presented.eye), aim: copy3(presented.forward), fov: presented.vfovDeg };
  state.look = { yaw: v.look.yaw, pitch: v.look.pitch };
  state.aspect = typeof v.aspect === 'number' && Number.isFinite(v.aspect) && v.aspect > 0 ? v.aspect : undefined;
  state.fov = presented.vfovDeg;
  sinks.input?.setAimView(state.look);
  sinks.audio?.setListener({ eye: copy3(presented.eye), forward: copy3(presented.forward), up: copy3(presented.up) });
}

/** the kernel's camera port over a view state; every answer is a fresh object */
export function cameraPortOf(state: ViewState): CameraPort {
  return {
    presentedCamera() {
      const c = state.camera;
      return c === null ? null : { eye: copy3(c.eye), aim: copy3(c.aim), fov: c.fov };
    },
    view() {
      const l = state.look;
      return l === undefined ? undefined : { yaw: l.yaw, pitch: l.pitch };
    },
    worldCamera() {
      const out: { aspect?: number; fov?: number } = {};
      if (state.aspect !== undefined) out.aspect = state.aspect;
      if (state.fov !== undefined) out.fov = state.fov;
      return out;
    },
  };
}
