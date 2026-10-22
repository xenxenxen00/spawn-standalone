// The camera domain's presenter (io §5.3; docs/architecture.md X-10, X-36; WP CA1).
//
// Once per frame the rig host hands it what the carried rig produced (the eye the rig wrote into its `feetPosition`, the
// presented yaw / pitch of the ownership step, the rig's vertical fov, `hideLocalPlayer`, the orbit arm). This module resolves
// the presented pose (first person, or the downed orbit), folds the juice offsets in, keeps `presented` (eye, forward, up,
// fov) for the published views and pushes `CameraPose` to render's `CameraPresenter` (render §4.2), which owns the three
// `PerspectiveCamera`, its clip planes and the viewmodel projection. No three.js here (rule three-confined: the camera host
// is in the boot chunk, X-26) and no camera controls: input reaches the rig only through this domain.
//
//   convention   three.js is right-handed with +Y up and cameras looking down −Z, Spawn's own convention, so the live axes map
//                1:1: forward = lookDir(yaw, pitch) = (−sin yaw · cos pitch, sin pitch, −cos yaw · cos pitch) (aim.js:8-11); yaw
//                0 faces −Z, +yaw turns left, +pitch looks up. Render sets `rotation.set(pitch, yaw, roll, 'YXZ')`, which
//                gives exactly this forward; `cameraBasis` is that rotation's right / up / forward.
//   fov          the rig's `ctx.self.fov`, vertical degrees, forwarded unchanged (three's `PerspectiveCamera.fov`).
//   clip planes  never passed: render owns near / far 0.1 / 2000 (X-10; the game never writes `clip`).
//   first person eye = the rig's `feetPosition` (camera.js:337).
//   orbit        while the rig holds the engine's orbit arm (`state.desiredDist`): pivot = the target's feet + heightOffset
//                1.8 (contract §11.2; the rig measures its arm from `tf.y + 1.8`, camera.js:281), eye = pivot − forward ×
//                min(desiredDist, collisionDist ?? desiredDist). The live rig takes the arm only for the downed overhead view
//                (DR-16 (a)); `port.downedOrbit = 'fixed'`, the default (DR-34), presents the rig's `feetPosition` (the
//                spot) with a free turn instead: the Director parks the downed ghost 60 m up, and the arm measured from the
//                ghost would stand the orbit eye 87 m from the spot.
//   hidden body  `hideLocalPlayer` hides the target body for the world camera in first person; the downed view draws it
//                (render §4.4), so the arm clears it whichever way the downed eye is placed.
//   juice        Spawn ignores rotation offsets written to the rig row under `orientation: "look"` (contract §11.3), so shake,
//                punch and roll arrive as `JuiceOffsets` (CA2) and are folded into the pushed pose here; the look the rig, the
//                engine integration and the body's aim axes see never carries them.
//   no engine    `target` is null until the engine chunk exists: `presented` is still computed (menus, HUD and audio read it)
//                and nothing is pushed. No pose yet: the origin looking −Z.
// The pose pushed in `RigHost.frame` is the frame's final camera pose before `renderer.update`, so the camera-space viewmodel
// offset render interpolates (X-36) is never one frame behind.
import type { Vec3 } from '../../compat/core/types.ts';
import type { CameraPose } from '../../render/index.ts';

export type { CameraPose } from '../../render/index.ts';

/** render's `CameraPresenter` as this domain uses it (render §4.2); `aspect` is what the rig reads as `ctx.world.camera.aspect` */
export interface PoseTarget {
  apply(pose: CameraPose): void;
  setHiddenBody(bodyId: string | null): void;
  readonly aspect?: number;
}

/**
 * Presentation-only offsets of one frame (CA2's `Juice.offsets(dt)`; zero until then). Rotations are radians added to the
 * look (`roll` about the view axis); `pos` is metres in the camera frame of the look itself (x right, y up, −z forward: the
 * `cameraPunch` direction frame), so a shake does not steer its own push.
 */
export interface JuiceOffsets {
  pos: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
}

export const ZERO_JUICE: Readonly<JuiceOffsets> = Object.freeze({ pos: Object.freeze({ x: 0, y: 0, z: 0 }), yaw: 0, pitch: 0, roll: 0 });

/** io §5.3 */
export interface PresentedPose {
  mode: 'first' | 'orbit';
  /** first: the rig's feetPosition; orbit: computed */
  eye: Vec3;
  /** radians, live convention */
  yaw: number;
  pitch: number;
  /** the rig's `ctx.self.fov` (vertical degrees) */
  vfovDeg: number;
  /** `hideLocalPlayer` target */
  hideBodyId: string | null;
  /** K16: `orthographic` with a finite `orthoSize` > 0 (half-height, m); absent = perspective (PP) */
  projection?: 'orthographic';
  orthoSize?: number;
}

/** the frame's final camera: what the views publish (io §5.6) */
export interface Presented {
  eye: Vec3;
  forward: Vec3;
  up: Vec3;
  vfovDeg: number;
}

/** io §5.3 */
export interface CameraPresenter {
  /** render's CameraPresenter (render §4.2, X-10); null until the engine exists */
  readonly target: PoseTarget | null;
  apply(p: PresentedPose, juice: JuiceOffsets): void;
  readonly presented: Presented;
}

export interface CameraPresenterControl extends CameraPresenter {
  /** the engine attached (or went away: a device-loss rebuild hands a new presenter in) */
  setTarget(target: PoseTarget | null): void;
  /** the last pose applied (the look without juice); null before the first */
  readonly last: PresentedPose | null;
  /** no rig, no body: keep the last pose; with no last pose, the origin looking −Z */
  hold(juice: JuiceOffsets): void;
}

/** the engine's orbit arm as the rig's `state` holds it (contract §11.2) */
export interface OrbitArm {
  desiredDist: number;
  /** the arm stop; the live rig writes the exact pivot-to-spot length (camera.js:279-283) */
  collisionDist?: number | undefined;
  /** default 1.8 */
  heightOffset?: number | undefined;
}

/** what the rig produced this frame, read by the rig host after `kernel.stepRig` */
export interface RigFrame {
  /** the rig row's feetPosition: the eye the rig wrote */
  feet: Vec3;
  /** the presented look (the ownership result), radians */
  yaw: number;
  pitch: number;
  /** the rig layer's fov; undefined while the rig has not written one */
  vfovDeg: number | undefined;
  hideLocalPlayer: boolean;
  targetId: string | null;
  /** the target body's feet; null without a body */
  targetFeet: Vec3 | null;
  /** null in first person */
  arm: OrbitArm | null;
  /** K16: the rig layer's `projection` and the rig state's `orthoSize`; only a usable pair makes the pose orthographic */
  projection?: unknown;
  orthoSize?: unknown;
}

/** the rig's vertical fov at 16:9 for the default hfov 90° (camera.js:356-367); used until the rig writes one */
export const DEFAULT_VFOV_DEG = 58.72;
/** the engine orbit's `heightOffset` (contract §11.2) */
export const ORBIT_HEIGHT_OFFSET = 1.8;

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const finite3 = (v: Vec3): boolean => finite(v.x) && finite(v.y) && finite(v.z);
const copy3 = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
const validFov = (n: unknown): n is number => finite(n) && n > 0 && n < 180;

/** The live `lookDir` (scripts/player/aim.js:8-11): the forward of a yaw / pitch pair. `+ 0` keeps −0 out of published values. */
export function lookDir(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp + 0, y: Math.sin(pitch) + 0, z: -Math.cos(yaw) * cp + 0 };
}

/** The camera's world axes under `rotation.set(pitch, yaw, roll, 'YXZ')` (R = Ry(yaw) · Rx(pitch) · Rz(roll)); forward = R · (0, 0, −1). */
export function cameraBasis(yaw: number, pitch: number, roll: number): { right: Vec3; up: Vec3; forward: Vec3 } {
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const sr = Math.sin(roll);
  const cr = Math.cos(roll);
  return {
    right: { x: cr * cy + sr * sp * sy + 0, y: sr * cp + 0, z: -cr * sy + sr * sp * cy + 0 },
    up: { x: -sr * cy + cr * sp * sy + 0, y: cr * cp + 0, z: sr * sy + cr * sp * cy + 0 },
    forward: { x: -sy * cp + 0, y: sp + 0, z: -cy * cp + 0 },
  };
}

/** the orbit eye: `dist` back from `pivot` along the look, so the view looks through the pivot */
export function orbitEye(pivot: Vec3, yaw: number, pitch: number, dist: number): Vec3 {
  const f = lookDir(yaw, pitch);
  return { x: pivot.x - f.x * dist, y: pivot.y - f.y * dist, z: pivot.z - f.z * dist };
}

/**
 * The presented pose of one frame (io §5.3): first person at the rig's eye, or the orbit around the target while the rig
 * holds the arm. `lastFov` stands in while the rig has written no usable fov.
 */
export function resolvePose(rig: RigFrame, downedOrbit: 'orbit' | 'fixed', lastFov: number): PresentedPose {
  const pose = resolveBasePose(rig, downedOrbit, lastFov);
  if (rig.projection === 'orthographic' && finite(rig.orthoSize) && rig.orthoSize > 0) {
    pose.projection = 'orthographic';
    pose.orthoSize = rig.orthoSize;
  }
  return pose;
}

function resolveBasePose(rig: RigFrame, downedOrbit: 'orbit' | 'fixed', lastFov: number): PresentedPose {
  const vfovDeg = validFov(rig.vfovDeg) ? rig.vfovDeg : lastFov;
  const arm = rig.arm !== null && finite(rig.arm.desiredDist) && rig.arm.desiredDist >= 0 ? rig.arm : null;
  // the arm is the downed view: the fallen body is drawn (render §4.4)
  const hideBodyId = arm === null && rig.hideLocalPlayer && rig.targetId !== null ? rig.targetId : null;
  if (arm !== null && downedOrbit === 'orbit' && rig.targetFeet !== null && finite3(rig.targetFeet)) {
    const stop = finite(arm.collisionDist) && arm.collisionDist >= 0 ? arm.collisionDist : arm.desiredDist;
    const height = finite(arm.heightOffset) ? arm.heightOffset : ORBIT_HEIGHT_OFFSET;
    const pivot = { x: rig.targetFeet.x, y: rig.targetFeet.y + height, z: rig.targetFeet.z };
    return { mode: 'orbit', eye: orbitEye(pivot, rig.yaw, rig.pitch, Math.min(arm.desiredDist, stop)), yaw: rig.yaw, pitch: rig.pitch, vfovDeg, hideBodyId };
  }
  return { mode: 'first', eye: copy3(rig.feet), yaw: rig.yaw, pitch: rig.pitch, vfovDeg, hideBodyId };
}

export interface CameraPresenterOptions {
  /** render's presenter when the engine already exists */
  target?: PoseTarget | null;
}

const ORIGIN_POSE: Readonly<PresentedPose> = Object.freeze({ mode: 'first', eye: Object.freeze({ x: 0, y: 0, z: 0 }), yaw: 0, pitch: 0, vfovDeg: DEFAULT_VFOV_DEG, hideBodyId: null });

export function createCameraPresenter(opts: CameraPresenterOptions = {}): CameraPresenterControl {
  let target: PoseTarget | null = opts.target ?? null;
  let last: PresentedPose | null = null;
  let presented: Presented = { eye: { x: 0, y: 0, z: 0 }, forward: lookDir(0, 0), up: { x: 0, y: 1, z: 0 }, vfovDeg: DEFAULT_VFOV_DEG };

  /** folds the offsets in, records `presented` and pushes; every value is finite by now */
  const present = (p: PresentedPose, juice: JuiceOffsets): void => {
    const jp = finite3(juice.pos) ? juice.pos : ZERO_JUICE.pos;
    const yaw = p.yaw + (finite(juice.yaw) ? juice.yaw : 0);
    const pitch = p.pitch + (finite(juice.pitch) ? juice.pitch : 0);
    const roll = finite(juice.roll) ? juice.roll : 0;
    let eye = copy3(p.eye);
    if (jp.x !== 0 || jp.y !== 0 || jp.z !== 0) {
      const b = cameraBasis(p.yaw, p.pitch, 0);
      eye = {
        x: eye.x + b.right.x * jp.x + b.up.x * jp.y - b.forward.x * jp.z,
        y: eye.y + b.right.y * jp.x + b.up.y * jp.y - b.forward.y * jp.z,
        z: eye.z + b.right.z * jp.x + b.up.z * jp.y - b.forward.z * jp.z,
      };
    }
    const shown = cameraBasis(yaw, pitch, roll);
    presented = { eye, forward: shown.forward, up: shown.up, vfovDeg: p.vfovDeg };
    if (target === null) return;
    target.apply({
      eye: copy3(eye),
      yaw,
      pitch,
      roll,
      vfovDeg: p.vfovDeg,
      ...(p.projection === 'orthographic' && p.orthoSize !== undefined ? { projection: p.projection, orthoSize: p.orthoSize } : {}),
    });
    target.setHiddenBody(p.hideBodyId);
  };

  return {
    get target(): PoseTarget | null {
      return target;
    },
    setTarget(t: PoseTarget | null): void {
      target = t;
    },
    get presented(): Presented {
      return { eye: copy3(presented.eye), forward: copy3(presented.forward), up: copy3(presented.up), vfovDeg: presented.vfovDeg };
    },
    get last(): PresentedPose | null {
      return last === null ? null : { ...last, eye: copy3(last.eye) };
    },
    apply(p: PresentedPose, juice: JuiceOffsets): void {
      // a part the rig got wrong keeps its last good value: render refuses a non-finite pose (render §4.2)
      const prev = last ?? ORIGIN_POSE;
      last = {
        mode: p.mode,
        eye: finite3(p.eye) ? copy3(p.eye) : copy3(prev.eye),
        yaw: finite(p.yaw) ? p.yaw : prev.yaw,
        pitch: finite(p.pitch) ? p.pitch : prev.pitch,
        vfovDeg: validFov(p.vfovDeg) ? p.vfovDeg : prev.vfovDeg,
        hideBodyId: p.hideBodyId,
        ...(p.projection === 'orthographic' && finite(p.orthoSize) && p.orthoSize > 0 ? { projection: 'orthographic' as const, orthoSize: p.orthoSize } : {}),
      };
      present(last, juice);
    },
    hold(juice: JuiceOffsets): void {
      present(last ?? ORIGIN_POSE, juice);
    },
  };
}
