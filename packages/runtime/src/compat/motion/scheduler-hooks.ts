// The motion domain's entry points into the tick and the frame (docs/design/motion-physics-nav.md §2, §3.11;
// docs/architecture.md §4.1 step H, §4.2 step 4, X-11, X-13, X-40; core §9.3 / §9.7; WP MA4). Engine-free: the three adapter
// is handed in (`SkinAdapter`, implemented by `three-skin.ts`), so the same runtime serves the headless kernel.
//
//   tick step D   channel writes arrive synchronously: `anim` / `mixer` (anim-channel.ts), `ik` (ik.ts)
//   tick step H   `port.advanceTick(dt)` (MotionPort): the clocks and ramps of every mixer and IK chain of a simulated place,
//                 then the sim poses behind the bone attachments are carried one tick (one mixer evaluation per rigged row, no
//                 FK: a bone no playing clip names must hold the same value whether or not a probe was read, attach.ts) and
//                 the lazy poses are ended (attach.ts evaluates again on the next read).
//                 Core does not call it while the sim is paused, so a paused sim is a frozen animation.
//   any bone read `attach` (AttachmentResolver): the un-IK'd sim pose of the tick
//   frame step 4  `MotionPresenter.update(frame)` (the `MixerHost` the renderer receives), after the render bridge has
//                 interpolated the roots and called `root.updateWorldMatrix(true, false)` on the ones it moved:
//                 per bound model  mixer.evaluate(pose, alpha) → IK → FK → skin write, before `renderer.render()`
//
// PRESENTATION RULES
//   held          a frame with `paused` or `dt === 0` (hitstop: the PresentationClock stands still, X-11) presents the pose of
//                 the frame before it: nothing is evaluated. The skin write still runs, because a root may have moved.
//   LOD           a row beyond `MIXER_LOD.near` metres of the camera evaluates every 2nd frame, beyond `far` every 4th, an
//                 off-screen one every 4th (one visibility test per row, the caller's); the low tier halves the distances and
//                 the governor may scale them by 0.7 (motion §3.5.7, render §15.2). Rows are staggered so the skipped frames
//                 do not coincide. A skipped row keeps its pose; its bones are written only if its root moved (on the direct
//                 bone path the bones are in world space, so a walking far body must still follow its root: three-skin.ts).
//                 The sim pose behind the bone probes is not subject to any of this.
//   corpses       the corpse baker (render §11.5) keeps a corpse presenting until no bone changed for 10 frames
//                 (`isSettled`), then calls `release(rowId)`: `Mixer.release({ keepFinalPose: true })` with the PRESENTED
//                 pose, which is what the bone attachments of the corpse read from then on (X-40). A released mixer is
//                 never evaluated again; the binding stays harmless until render unbinds it.
//
// WIRING (app compose)
//   const motion = createMotion({ registry, bind: retargetBinder.tryBind, isSimulated });
//   createKernel({ ports: { motion: motion.port, attach: motion.attach, … } });   motion.install(kernel);
//   createRenderer(canvas, { mixer: motion.presenter({ skin: threeSkin, eye, visible }), … });
//   the bridge: presenter.bind(instance, { rowId, body }) when a model appears, presenter.unbind(instance) when it goes.
import type { MotionPort } from '../core/ports.ts';
import type { Kernel, RowRec, Vec3 } from '../core/types.ts';
import { type AnimChannels, type AnimChannelsOptions, createAnimChannels } from './anim-channel.ts';
import { BoneAttachmentResolver, newSimWorld, simWorldOf, type BoneAttachmentOptions, type RowLookup } from './attach.ts';
import { MIXER_LOD } from './constants.ts';
import { IkChannels, type IkFrame } from './ik.ts';
import { type FrozenPose, Pose, type PoseRig } from './pose.ts';

/** the frame a presentation pass runs for (the `FrameInfo` of docs/architecture.md §3.0, as far as motion reads it) */
export interface PresentFrame {
  /** interpolation fraction between the last two ticks */
  readonly alpha: number;
  /** presentation seconds of this frame: 0 during hitstop */
  readonly dt: number;
  readonly frameIndex: number;
  readonly paused: boolean;
}

/** one bound model, as the presentation pass needs it (`three-skin.ts` `ThreeSkinHandle`) */
export interface SkinHandle {
  readonly rig: PoseRig;
  /** rig model space → world of this frame (16, column-major): the root's current world matrix × the model normalisation */
  rigWorld(out: Float64Array): Float64Array;
  /** the row's world transform as drawn this frame (16) */
  bodyWorld(out: Float64Array): Float64Array;
  /** writes the pose onto the skin; returns the number of bones written */
  apply(pose: Pose, dirty: Uint8Array): number;
}

export interface SkinAdapter {
  /** null for a model without bones */
  bind(instance: unknown, opts?: Record<string, unknown>): SkinHandle | null;
}

export interface MotionOptions extends Pick<AnimChannelsOptions, 'registry' | 'bind' | 'isSimulated' | 'createMixer'>, Pick<BoneAttachmentOptions, 'normalisation' | 'rigOf'> {
  /** the rows and the sim clock, when there is no kernel to `install` on (tests) */
  rows?: RowLookup;
  clock?: { readonly tick: number };
}

export interface PresenterOptions {
  skin: SkinAdapter;
  /** the camera position the LOD distances are measured from; absent or null = every row is near */
  eye?: () => Vec3 | null;
  /** whether a bound model is on screen (one bounding-sphere frustum test per row); absent = every row is */
  visible?: (instance: unknown) => boolean;
  /** the row of a model bound without a `rowId`; default: `instance.root.userData.ssRowId` */
  rowOf?: (instance: unknown) => string | null;
  /** the `low` and `minimum` tiers halve the LOD distances */
  lowTier?: boolean;
  /** static-world down-ray for feet IK (physics' StaticRaycaster); absent = feet IK does nothing */
  castDown?: IkFrame['castDown'];
}

export interface BindOptions {
  rowId?: string;
  /** passed on to the skin adapter (`three-skin.ts`: `body`, `mode`, `rig`) */
  [key: string]: unknown;
}

/** what one `update` did (tests, the frame budget) */
export interface PresentStats {
  rows: number;
  /** rows whose mixer was evaluated */
  evaluated: number;
  /** rows that had IK solved */
  ik: number;
  bonesWritten: number;
}

interface Binding {
  readonly rowId: string;
  readonly row: RowRec;
  readonly instance: unknown;
  readonly handle: SkinHandle;
  readonly pose: Pose;
  /** frames in a row in which no bone matrix changed */
  settled: number;
  presented: boolean;
  /** spreads the LOD cadence over the rows */
  readonly phase: number;
}

/** the number of frames without a bone change after which a pose counts as at rest (render §11.5: the corpse bake window) */
export const SETTLED_FRAMES = 10;

export class MotionPresenter {
  readonly #motion: Motion;
  readonly #opts: PresenterOptions;
  readonly #list: Binding[] = [];
  readonly #byRow = new Map<string, Binding>();
  #lodScale: number;
  #governor = false;
  readonly stats: PresentStats = { rows: 0, evaluated: 0, ik: 0, bonesWritten: 0 };
  // scratch of one row
  readonly #rigWorld = new Float64Array(16);
  readonly #bodyWorld = new Float64Array(16);
  readonly #ikFrame: IkFrame;
  readonly #world = newSimWorld();

  constructor(motion: Motion, opts: PresenterOptions) {
    this.#motion = motion;
    this.#opts = opts;
    this.#lodScale = opts.lowTier === true ? MIXER_LOD.lowTierScale : 1;
    this.#ikFrame = {
      modelToWorld: this.#rigWorld,
      bodyWorld: this.#bodyWorld,
      alpha: 0,
      rowFeet: (rowId) => {
        const row = motion.rows.get(rowId);
        if (row === undefined) return null;
        const w = simWorldOf(motion.rows, row, this.#world, motion.attach);
        return { x: w.pos[0]!, y: w.pos[1]!, z: w.pos[2]! };
      },
      castDown: opts.castDown,
    };
  }

  /** bound models */
  get size(): number {
    return this.#list.length;
  }

  /**
   * A model appeared for a row (render's ModelInstance): its rig goes to the row's mixer (made now if the row had none, so a
   * body nothing animates yet still follows its root at the bind pose), and from the next `update` the row is presented. A row
   * that was bound before is rebound (a model swap: the channel clocks are kept, the clips bind to the new rig). False when the
   * model has no bones or its row is unknown.
   */
  bind(instance: unknown, opts: BindOptions = {}): boolean {
    const rowId = opts.rowId ?? this.#opts.rowOf?.(instance) ?? defaultRowOf(instance);
    if (rowId === null || rowId === undefined) return false;
    const row = this.#motion.rows.get(rowId);
    if (row === undefined) return false;
    const handle = this.#opts.skin.bind(instance, opts);
    if (handle === null) return false;
    this.#drop(rowId);
    const mixer = this.#motion.anim.ensure(row);
    if (!mixer.released && mixer.rig !== handle.rig) mixer.setRig(handle.rig);
    const b: Binding = { rowId, row, instance, handle, pose: new Pose(handle.rig), settled: 0, presented: false, phase: row.serial & 3 };
    this.#list.push(b);
    this.#byRow.set(rowId, b);
    return true;
  }

  /** The model of a row is gone (by instance or by row id). The row's mixer keeps its channels and clocks. */
  unbind(instanceOrRowId: unknown): void {
    if (typeof instanceOrRowId === 'string') {
      this.#drop(instanceOrRowId);
      return;
    }
    const b = this.#list.find((x) => x.instance === instanceOrRowId);
    if (b !== undefined) this.#drop(b.rowId);
  }

  /** the governor's CPU lever (render §15.2): LOD distances × 0.7 */
  setGovernorLod(on: boolean): void {
    this.#governor = on;
  }

  setLowTier(low: boolean): void {
    this.#lodScale = low ? MIXER_LOD.lowTierScale : 1;
  }

  /** the pose a row was last presented in (the corpse baker skins from it); null for a row without a bound model */
  pose(rowId: string): Pose | null {
    return this.#byRow.get(rowId)?.pose ?? null;
  }

  /** frames in a row, up to now, in which no bone of the row's presented pose changed */
  settledFrames(rowId: string): number {
    return this.#byRow.get(rowId)?.settled ?? 0;
  }

  /** the corpse bake trigger: no bone changed for `frames` presented frames */
  isSettled(rowId: string, frames: number = SETTLED_FRAMES): boolean {
    return this.settledFrames(rowId) >= frames;
  }

  /**
   * The corpse baker's release (X-40): frees the row's channels and tracks and keeps the PRESENTED pose as its FrozenPose
   * (bone attachments read it from now on). Null when the row has no mixer or no pose.
   */
  release(rowId: string): FrozenPose | null {
    const mixer = this.#motion.anim.get(rowId);
    if (mixer === undefined) return null;
    const pose = this.#byRow.get(rowId)?.pose;
    return mixer.release(pose !== undefined && pose.rig === mixer.rig ? { keepFinalPose: true, pose } : { keepFinalPose: true });
  }

  /** Frame step 4 (the renderer's `MixerHost.update`). Precondition: every moved root's world matrix is current. */
  update(frame: PresentFrame): void {
    const { anim, ik, rows } = this.#motion;
    const stats = this.stats;
    stats.rows = stats.evaluated = stats.ik = stats.bonesWritten = 0;
    const held = frame.paused || frame.dt === 0;
    const eye = this.#opts.eye?.() ?? null;
    const visible = this.#opts.visible;
    const scale = this.#lodScale * (this.#governor ? MIXER_LOD.governorScale : 1);
    const near2 = (MIXER_LOD.near * scale) ** 2;
    const far2 = (MIXER_LOD.far * scale) ** 2;
    const list = this.#list;
    const body = this.#bodyWorld;
    const ikFrame = this.#ikFrame;
    ikFrame.alpha = frame.alpha;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i]!;
      if (rows.get(b.rowId) !== b.row) {
        // the row was destroyed (or its id reused) and render has not unbound the model yet
        this.#drop(b.rowId);
        continue;
      }
      stats.rows++;
      const pose = b.pose;
      const mixer = anim.get(b.rowId);
      if (mixer !== undefined && !mixer.released && mixer.rig === b.handle.rig && (!held || !b.presented)) {
        let every = 1;
        if (b.presented) {
          if (visible !== undefined && !visible(b.instance)) every = MIXER_LOD.offscreenEvery;
          else if (eye !== null) {
            b.handle.bodyWorld(body);
            const dx = body[12]! - eye.x, dy = body[13]! - eye.y, dz = body[14]! - eye.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            every = d2 > far2 ? MIXER_LOD.farEvery : d2 > near2 ? MIXER_LOD.nearEvery : 1;
          }
        }
        if (every === 1 || (frame.frameIndex + b.phase) % every === 0) {
          const hasIk = ik.active(b.rowId);
          if (hasIk) ik.restore(b.rowId, pose);
          mixer.evaluate(pose, frame.alpha);
          if (hasIk) {
            b.handle.rigWorld(this.#rigWorld);
            b.handle.bodyWorld(body);
            if (ik.solve(b.rowId, pose, ikFrame)) stats.ik++;
          }
          pose.updateModel();
          const md = pose.modelDirty;
          let changed = false;
          for (let k = 0; k < md.length; k++) {
            if (md[k] !== 0) {
              changed = true;
              break;
            }
          }
          b.settled = changed ? 0 : b.settled + 1;
          b.presented = true;
          stats.evaluated++;
        }
      }
      stats.bonesWritten += b.handle.apply(pose, pose.modelDirty);
      pose.clearDirty();
    }
  }

  #drop(rowId: string): void {
    const b = this.#byRow.get(rowId);
    if (b === undefined) return;
    this.#byRow.delete(rowId);
    const i = this.#list.indexOf(b);
    if (i >= 0) this.#list.splice(i, 1);
  }
}

function defaultRowOf(instance: unknown): string | null {
  const id = (instance as { root?: { userData?: Record<string, unknown> } } | null)?.root?.userData?.['ssRowId'];
  return typeof id === 'string' ? id : null;
}

/** The motion domain behind the kernel's ports: the channels, the bone attachments, the tick hook and the frame hook. */
export class Motion {
  readonly anim: AnimChannels;
  readonly ik: IkChannels;
  /** the kernel's AttachmentResolver */
  readonly attach: BoneAttachmentResolver;
  /** the kernel's MotionPort (tick step H) */
  readonly port: MotionPort;
  /** the rows of the kernel this runs on (empty until `install`, unless given) */
  readonly rows: RowLookup;
  #store: RowLookup | null;
  #clock: { readonly tick: number } | null;
  #ticks = 0;

  constructor(opts: MotionOptions) {
    this.#store = opts.rows ?? null;
    this.#clock = opts.clock ?? null;
    this.rows = { get: (id) => this.#store?.get(id) };
    const tickOf = (): number => (this.#clock ? this.#clock.tick : this.#ticks);
    const clock = {
      get tick(): number {
        return tickOf();
      },
    };
    this.anim = createAnimChannels({ registry: opts.registry, clock, ...(opts.bind ? { bind: opts.bind } : {}), ...(opts.isSimulated ? { isSimulated: opts.isSimulated } : {}), ...(opts.createMixer ? { createMixer: opts.createMixer } : {}) });
    this.ik = new IkChannels({ rows: this.rows, worldOf: (row, out) => simWorldOf(this.rows, row, out, this.attach), ...(opts.isSimulated ? { isSimulated: opts.isSimulated } : {}) });
    this.attach = new BoneAttachmentResolver({
      rows: this.rows,
      mixers: this.anim,
      clock,
      ...(opts.isSimulated ? { isSimulated: opts.isSimulated } : {}),
      ...(opts.normalisation ? { normalisation: opts.normalisation } : {}),
      ...(opts.rigOf ? { rigOf: opts.rigOf } : {}),
    });
    this.port = { advanceTick: (dtS) => this.advanceTick(dtS) };
  }

  /**
   * The whole wiring on a kernel created with `port` and `attach` as its motion and attachment ports: the `anim`, `mixer` and
   * `ik` channels on its store, its clock, its row notices. Returns an uninstall.
   */
  install(kernel: Pick<Kernel, 'store' | 'clock' | 'on'>): () => void {
    this.#store = kernel.store;
    this.#clock = kernel.clock;
    const offAnim = this.anim.install(kernel);
    const offIk = this.ik.install(kernel);
    const offDestroy = kernel.on('rowDestroyed', (row) => this.attach.forget(row.id));
    return () => {
      offAnim();
      offIk();
      offDestroy();
    };
  }

  /** Tick step H. */
  advanceTick(dtS: number): void {
    this.anim.advanceTick(dtS);
    this.ik.advanceTick(dtS);
    this.attach.endTick();
    this.#ticks++;
  }

  /** The `MixerHost` the renderer receives (`bind(instance)`, `update(frame)`), over a skin adapter. */
  presenter(opts: PresenterOptions): MotionPresenter {
    return new MotionPresenter(this, opts);
  }
}

export function createMotion(opts: MotionOptions): Motion {
  return new Motion(opts);
}
