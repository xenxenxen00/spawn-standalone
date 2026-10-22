// A scripted camera world with synthetic input, state and camera ports.
import { CAMERA_RIG_ID, HUMAN_BODY_ID } from '../../../src/compat/core/ids.ts';
import { createNullPorts } from '../../../src/compat/core/null-ports.ts';
import type { RowRec, Vec3 } from '../../../src/compat/core/types.ts';
import type { ListenerPose } from '../../../src/runtime/audio/types.ts';
import { createCameraPresenter, type CameraPose, type CameraPresenterControl, type JuiceOffsets, type PoseTarget } from '../../../src/runtime/camera/camera-presenter.ts';
import { createRigHost, type RigHost } from '../../../src/runtime/camera/rig-host.ts';
import { InputLog } from '../../../src/runtime/input/input-log.ts';
import { Look } from '../../../src/runtime/input/look.ts';
import { ctxWorld, PLAYER_MODULES, type CtxWorld, type Module } from '../core/fakes/ctx-world.ts';

export const RIG = 'scripts/camera.js';
/** the carried rig behavior and its template, as the registry would load them */
export const cameraTemplate = { behavior: [RIG], state: { yaw: 0, pitch: 0 } as Record<string, unknown> };

/** render's `CameraPresenter` as the camera domain sees it, recording every push */
export interface RecordingTarget extends PoseTarget {
  aspect: number;
  readonly poses: CameraPose[];
  readonly hidden: Array<string | null>;
  /** `apply` and `setHiddenBody` calls in order */
  readonly calls: string[];
}

export function recordingTarget(aspect: number = 16 / 9): RecordingTarget {
  const t: RecordingTarget = {
    aspect,
    poses: [],
    hidden: [],
    calls: [],
    apply(pose) {
      t.calls.push('apply');
      t.poses.push({ ...pose, eye: { ...pose.eye } });
    },
    setHiddenBody(id) {
      t.calls.push('setHiddenBody');
      t.hidden.push(id);
    },
  };
  return t;
}

/** Synthetic body state for scripted camera tests. */
export interface Bag {
  mv: Record<string, unknown>;
  wp: Record<string, unknown>;
  cam: Record<string, any>;
  look?: { x: number; y: number; z: number; at: number; eye: Vec3 | null };
}

export interface RigWorldOptions {
  /** Scripted rig behavior supplied by the test. */
  module?: Module;
  /** the rig row's initial state; default the camera template's */
  state?: Record<string, unknown>;
  /** the push target's aspect; `null` = no engine yet (no push target) */
  aspect?: number | null;
  /** the body's durable state (`prefs`, `live`); `null` spawns no body */
  body?: Record<string, unknown> | null;
  /** where the body stands */
  at?: Vec3;
  /** spawn the rig row (default true) */
  rig?: boolean;
  downedOrbit?: 'orbit' | 'fixed';
  orientationFromRow?: boolean;
  juice?: { offsets(dtS: number): JuiceOffsets };
}

export interface RigWorld {
  readonly w: CtxWorld;
  readonly host: RigHost;
  readonly look: Look;
  readonly input: InputLog;
  readonly presenter: CameraPresenterControl;
  /** null when the world was built without an engine */
  readonly target: RecordingTarget | null;
  readonly listener: ListenerPose[];
  readonly bag: Bag;
  body(): RowRec;
  rigRow(): RowRec;
  /** a locked mouse move in px */
  mouse(dx: number, dy: number): void;
  /** one rendered frame */
  frame(dtS?: number): void;
  frames(n: number, dtS?: number): void;
  /** the last pose pushed to the render target */
  pose(): CameraPose;
}

export async function rigWorld(o: RigWorldOptions = {}): Promise<RigWorld> {
  const look = new Look();
  const input = new InputLog({ map: { actions: { ss_req: {} } }, look });
  const target = o.aspect === null ? null : recordingTarget(o.aspect ?? 16 / 9);
  const presenter = createCameraPresenter({ target });
  const listener: ListenerPose[] = [];
  const host = createRigHost({
    look,
    input,
    presenter,
    audio: { setListener: (pose) => void listener.push({ eye: { ...pose.eye }, forward: { ...pose.forward }, up: { ...pose.up } }) },
    ...(o.orientationFromRow ? { orientationFromRow: true } : {}),
    ...(o.downedOrbit ? { downedOrbit: () => o.downedOrbit! } : {}),
    ...(o.juice ? { juice: o.juice } : {}),
  });
  const w = await ctxWorld({
    modules: { ...PLAYER_MODULES, [RIG]: o.module ?? {}, 'templates/camera.js': { camera: cameraTemplate } },
    ports: { ...createNullPorts(), camera: host },
  });
  host.attach(w.k);
  const bag: Bag = { mv: {}, wp: {}, cam: {} };
  if (o.body !== null) {
    w.human('p1', o.body ?? { prefs: { fov: 90, bob: 1 }, live: { alive: true, slot: 0 } });
    if (o.at) w.row(HUMAN_BODY_ID).tf.pos = { ...o.at };
    w.k.vms.client.session['ss'] = { [HUMAN_BODY_ID]: bag };
  }
  if (o.rig !== false) w.rig(RIG, o.state ?? { ...cameraTemplate.state });
  w.ticks(1); // the rig's onSpawn
  const world: RigWorld = {
    w,
    host,
    look,
    input,
    presenter,
    target,
    listener,
    bag,
    body: () => w.row(HUMAN_BODY_ID),
    rigRow: () => w.row(CAMERA_RIG_ID),
    mouse: (dx, dy) => input.push({ type: 'look', dx, dy }),
    frame: (dtS = 1 / 60) => host.frame(dtS),
    frames(n, dtS = 1 / 60) {
      for (let i = 0; i < n; i++) host.frame(dtS);
    },
    pose() {
      const p = target?.poses.at(-1);
      if (!p) throw new Error('no pose was pushed');
      return p;
    },
  };
  return world;
}

export const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** Independent direction formula used as the camera oracle. */
export const liveLookDir = (yaw: number, pitch: number): Vec3 => ({ x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) });
