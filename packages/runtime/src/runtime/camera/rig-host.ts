// The rig host (io §5.1-5.2; docs/architecture.md §4.2 step 2, X-07, X-09, X-10, X-15; core §7.4, §15.7; WP CA1).
//
// The live camera is a behavior on the rig row `camera/local` (templates/camera.js#camera → scripts/camera.js, carried
// JavaScript), which the engine ran at 120 Hz. The port runs it once per rendered frame: `frame(dt)` is frame step 2 of
// src/app/frame.ts, after the sim ticks of the frame and before `renderer.update`, so the pushed pose, the audio listener and
// the HUD anchors all use one eye. The host is also the kernel's `CameraPort`, so it exists before the kernel does and is
// attached to it afterwards.
//
//   frame(dt), while the clock runs and the rig follows a body:
//   1. Look.integrate(owned)      the engine look takes the frame's mouse deltas, except on an axis the rig owned on the
//                                 previous frame (that delta is the rig's to apply, contract §11.3)
//   2. rig `ctx.self.view`        = that engine look (undefined on frame 1, contract §11.2)
//   3. kernel.stepRig(dt, rig delivery)   the rig's onInput then update through the guarded invoker; the kernel returns the
//                                 top-level `state` keys the rig assigned / deleted (X-09: no Proxy of this domain's own)
//   4. ownership                  an axis in `wrote` is the rig's: presented exactly as written (the host never clamps it;
//                                 the overhead view's pitch runs to −1.45) and adopted as the engine value. An axis the rig
//                                 deleted or did not write is the mouse's: the engine value. "Written this frame" is the
//                                 whole rule; `state` is never read for an unwritten axis and `view` is never written back.
//   5. pose                       first person at the rig's `feetPosition`, or the orbit while the rig holds the arm
//                                 (camera-presenter.ts); + juice offsets → render's camera, then the hidden body
//   6. views                      `ctx.view.camera`, `ctx.world.camera`, the aim axes, the audio listener (camera-view.ts)
//
// Order rationale (io §5.1): the gun fires along `bag.look`, which the rig writes in step 3 from the look of this frame
// (camera.js:510); the body's next tick reads it, so shots leave the screen centre as live.
//
//   dt             clamped to [0, ENGINE.RIG_DT_MAX_S]; every smoothing term of the rig is dt-based, so one step per frame
//                  gives the live curves (X-09). The caller passes min(realDt, 0.1) as well.
//   paused         the rig does not step while the sim clock is paused (X-07): nothing is integrated, pushed or published,
//                  the last pose stays. The mouse deltas of the pause are dropped on the first frame after it.
//   spectating     the body's devices are blocked, the rig's never are (X-15): the rig always gets look input.
//   hideLocalPlayer  per step (contract §11.2): cleared before each step, so a rig that stops asking shows the body again.
//   orbit arm      held from the frame the rig writes `state.desiredDist` until it deletes it. The carried rig rewrites the
//                  arm only when it changes by more than 5 cm (camera.js:282-283), so "written this frame" alone would
//                  drop the orbit after one frame.
//   no rig, no body  (boot, LOBBY without a scene) the last pose is kept, or the origin looking −Z; no camera frame is
//                  published (`ctx.view.camera` stays null, the rig's `view` undefined) and the mouse is not integrated.
//   no engine      the presenter has no push target yet: everything else still happens (menus, HUD and audio read the views).
import type { CameraPort } from '../../compat/core/ports.ts';
import { ENGINE } from '../../compat/core/rules.ts';
import type { Kernel, RowRec, RowStore, SimClock, Vec3 } from '../../compat/core/types.ts';
import type { ListenerPose } from '../audio/types.ts';
import type { InputLog } from '../input/input-log.ts';
import type { Look, LookView } from '../input/look.ts';
import { ZERO_JUICE, resolvePose, type CameraPresenterControl, type JuiceOffsets, type OrbitArm, type PresentedPose } from './camera-presenter.ts';
import { rowLook } from './row-orientation.ts';
import { cameraPortOf, createViewState, publishView, type ViewState } from './camera-view.ts';

/** what the host needs of the kernel (the public `Kernel` satisfies it) */
export type RigKernel = Pick<Kernel, 'stepRig' | 'ids'> & { readonly clock: Pick<SimClock, 'running'>; readonly store: Pick<RowStore, 'get'> };

export type DownedOrbit = 'orbit' | 'fixed';

export interface RigHostDeps {
  /** the engine look integration (IN1); the input log feeds it the same look events */
  look: Pick<Look, 'integrate' | 'adopt' | 'view' | 'discardPending'>;
  /** the rig's delivery and the aim axes of the next body delivery */
  input: Pick<InputLog, 'deliver' | 'setAimView'>;
  presenter: CameraPresenterControl;
  /** the audio engine's listener; none in a headless run */
  audio?: { setListener(pose: ListenerPose): void } | null;
  /** CA2's `Juice` (io §5.5); zero offsets without it */
  juice?: { offsets(dtS: number): JuiceOffsets } | null;
  /** `port.downedOrbit` (io §5.3); default: the flag of builtin/port, read each frame (`'fixed'` unless it says `'orbit'`, DR-34) */
  downedOrbit?: () => DownedOrbit;
  /**
   * Opt-in (R-1): the rig orients the camera through its row's `rotation` (`{ lookAt, include }`, engine api:482) instead of
   * `state.yaw / state.pitch`. The host then presents the row's yaw and pitch and adopts them as the engine look. Default false:
   * the state axes and the mouse own the orientation, as in PP.
   */
  orientationFromRow?: boolean;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export class RigHost implements CameraPort {
  readonly #deps: RigHostDeps;
  readonly #downedOrbit: () => DownedOrbit;
  readonly #views: ViewState = createViewState();
  readonly #port: CameraPort = cameraPortOf(this.#views);
  #kernel: RigKernel | null = null;
  /** the rig row the latches below belong to */
  #row: RowRec | undefined;
  #ownedYaw = false;
  #ownedPitch = false;
  #arm = false;
  /** the clock was paused since the last stepped frame */
  #stale = false;
  #pose: PresentedPose | null = null;

  constructor(deps: RigHostDeps) {
    this.#deps = deps;
    this.#downedOrbit = deps.downedOrbit ?? (() => 'fixed');
  }

  /** the kernel exists (it was created with this host as its camera port); null detaches */
  attach(kernel: RigKernel | null): void {
    this.#kernel = kernel;
  }

  // ── CameraPort (core §15.7) ────────────────────────────────────────────────────────────────────────────────────────
  /** `ctx.view.camera`; null before the first camera frame */
  presentedCamera(): { eye: Vec3; aim: Vec3; fov: number } | null {
    return this.#port.presentedCamera();
  }
  /** rig `ctx.self.view`; undefined before frame 1 */
  view(): LookView | undefined {
    return this.#port.view();
  }
  /** `ctx.world.camera` */
  worldCamera(): { aspect?: number; fov?: number } {
    return this.#port.worldCamera();
  }

  /** the axes the rig wrote on the last stepped frame */
  get owned(): { yaw: boolean; pitch: boolean } {
    return { yaw: this.#ownedYaw, pitch: this.#ownedPitch };
  }

  /** the pose of the last camera frame (the look without juice); null before the first */
  get pose(): PresentedPose | null {
    return this.#pose === null ? null : { ...this.#pose, eye: { ...this.#pose.eye } };
  }

  /** frame step 2 (docs/architecture.md §4.2); `dtS` = min(realDt, 0.1) */
  frame(dtS: number): void {
    const k = this.#kernel;
    if (k === null) return;
    if (!k.clock.running) {
      this.#stale = true;
      return;
    }
    const { look, input, presenter } = this.#deps;
    const dt = Number.isFinite(dtS) ? Math.min(Math.max(dtS, 0), ENGINE.RIG_DT_MAX_S) : 0;
    const juice = this.#deps.juice?.offsets(dt) ?? ZERO_JUICE;
    const delivery = input.deliver('rig');
    if (this.#stale) {
      // the first frame after a pause: what the mouse did meanwhile is not a look (X-07)
      this.#stale = false;
      look.discardPending();
      delivery.axes['lookX'] = 0;
      delivery.axes['lookY'] = 0;
    }

    let row = k.store.get(k.ids.cameraRig);
    if (row !== this.#row) {
      // another rig row (or none): its ownership and arm are its own
      this.#row = row;
      this.#ownedYaw = this.#ownedPitch = this.#arm = false;
    }
    const ready = row !== undefined && row.rig !== null && row.phase === 'alive' && !row.pendingSpawnHooks;
    const framing = ready && this.#target(k, row!) !== undefined;

    if (framing) {
      const engine = look.integrate({ yaw: this.#ownedYaw, pitch: this.#ownedPitch });
      // the rig's `view`: undefined on frame 1, then the look it is about to be stepped with
      if (this.#views.look !== undefined) this.#views.look = engine;
    } else {
      look.discardPending();
    }
    if (ready) row!.rig!.layer.delete(['hideLocalPlayer']);

    const { wrote, deleted } = k.stepRig(dt, delivery);

    row = k.store.get(k.ids.cameraRig);
    if (row !== undefined && row === this.#row) {
      if (deleted.has('desiredDist')) this.#arm = false;
      else if (wrote.has('desiredDist')) this.#arm = true;
    }
    const target = row !== undefined && row === this.#row && row.rig !== null ? this.#target(k, row) : undefined;
    if (!framing || row === undefined || row.rig === null || target === undefined) {
      this.#ownedYaw = this.#ownedPitch = false;
      presenter.hold(juice);
      return;
    }

    const state = row.state;
    const engine = look.view();
    let yaw: number;
    let pitch: number;
    if (this.#deps.orientationFromRow === true) {
      // the row's rotation is the rig's whole orientation: both axes are owned, whatever the state holds
      ({ yaw, pitch } = rowLook(row));
      this.#ownedYaw = this.#ownedPitch = true;
      this.#deps.look.adopt('yaw', yaw);
      this.#deps.look.adopt('pitch', pitch);
    } else {
      yaw = this.#own('yaw', wrote, state, engine.yaw);
      pitch = this.#own('pitch', wrote, state, engine.pitch);
    }
    const layer = row.rig.layer.read();
    const pose = resolvePose(
      {
        feet: row.tf.pos,
        yaw,
        pitch,
        vfovDeg: finite(layer['fov']) ? layer['fov'] : undefined,
        hideLocalPlayer: layer['hideLocalPlayer'] === true,
        targetId: target.id,
        targetFeet: target.tf.pos,
        arm: this.#armOf(state),
        projection: layer['projection'],
        orthoSize: state['orthoSize'],
      },
      this.#downedOrbit(),
      presenter.presented.vfovDeg,
    );
    presenter.apply(pose, juice);
    this.#pose = presenter.last;
    publishView(
      { state: this.#views, input, audio: this.#deps.audio },
      { presented: presenter.presented, look: { yaw, pitch }, aspect: presenter.target?.aspect },
    );
  }

  /** the body the rig follows; undefined when it follows nothing or the body is gone */
  #target(k: RigKernel, row: RowRec): RowRec | undefined {
    const id = row.rig?.targetId ?? null;
    return id === null ? undefined : k.store.get(id);
  }

  /** io §5.1 step 5 for one axis: the presented value */
  #own(axis: 'yaw' | 'pitch', wrote: ReadonlySet<string>, state: Record<string, unknown>, engine: number): number {
    const v = state[axis];
    const owned = wrote.has(axis) && finite(v);
    if (axis === 'yaw') this.#ownedYaw = owned;
    else this.#ownedPitch = owned;
    if (!owned) return engine;
    this.#deps.look.adopt(axis, v as number);
    return v as number;
  }

  /** the engine's orbit arm while the rig holds it (contract §11.2 state inputs) */
  #armOf(state: Record<string, unknown>): OrbitArm | null {
    const desiredDist = state['desiredDist'];
    if (!this.#arm || !finite(desiredDist)) return null;
    const collisionDist = state['collisionDist'];
    const heightOffset = state['heightOffset'];
    return { desiredDist, collisionDist: finite(collisionDist) ? collisionDist : undefined, heightOffset: finite(heightOffset) ? heightOffset : undefined };
  }
}

export function createRigHost(deps: RigHostDeps): RigHost {
  return new RigHost(deps);
}
