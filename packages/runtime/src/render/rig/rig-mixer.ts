// The mixer of a procedural rig (plan item K3; DESIGN.md §4): the existing `Mixer` (clips on named channels: `gait`, …),
// plus the `bones.<b>.{pitch, yaw, roll, y}` layer applied after the clips in every evaluation. Because it IS a Mixer, every
// consumer of mixers takes it unchanged: `AnimChannels` (through its `createMixer` option), the presentation pass, the
// three skin adapter and `BoneAttachmentResolver` (whose sim pose then includes the bone channels, so a bone-attached row
// follows a tweened bone too).
//
// The mixer leaves a bone no clip names at whatever local it holds. The layer therefore keeps, per pose, the clip-only locals
// of the bones it changed and puts them back (raw, unmarked) before the clips are evaluated, then composes again. A bone is
// marked dirty (`pose.touch`) only when its final local differs from the one it had after the previous evaluation, so a held
// pose marks nothing, as with plain clips.
import { Mixer, type MixerOptions } from '../../compat/motion/mixer.ts';
import type { Pose, PoseRig } from '../../compat/motion/pose.ts';
import { qMul } from '../../compat/motion/quat.ts';
import { BONE_CHANNEL_ROTATION, type BoneChannelValue, type BoneRotationConvention, readBoneChannels } from './bone-channels.ts';

export interface RigMixerOptions extends MixerOptions {
  /** default BONE_CHANNEL_ROTATION (YXZ, the sims' FK); tests pass a wrong one as a negative control */
  rotation?: BoneRotationConvention;
}

interface LayerState {
  /** clip-only locals of the bones the layer changed: t 3, r 4, s 3 per bone */
  readonly baseT: Float32Array;
  readonly baseR: Float32Array;
  /** the final locals written last time (Float32, as the pose stores them) */
  readonly lastT: Float32Array;
  readonly lastR: Float32Array;
  /** 1 = the layer wrote this bone in the previous evaluation */
  readonly owned: Uint8Array;
}

/** the channels resolved against a rig: per rig bone, its value or undefined */
interface Resolved {
  readonly rig: PoseRig;
  readonly valueOf: readonly (BoneChannelValue | undefined)[];
}

export class RigMixer extends Mixer {
  readonly #rotation: BoneRotationConvention;
  #channels = new Map<string, BoneChannelValue>();
  #resolved: Resolved | null = null;
  readonly #states = new WeakMap<Pose, LayerState>();
  readonly #q = new Float64Array(4);
  readonly #r = new Float64Array(4);

  constructor(rowId: string, rig: PoseRig | null, opts: RigMixerOptions = {}) {
    super(rowId, rig, opts);
    this.#rotation = opts.rotation ?? BONE_CHANNEL_ROTATION;
  }

  /** The row's `bones` prop changed (the `bones` property channel, `bones-channel.ts`): the whole prop, as the row stores it. */
  setBoneChannels(prop: unknown): void {
    this.#channels = readBoneChannels(prop);
    this.#resolved = null;
  }

  /** the bone channels in effect (debug, tests) */
  boneChannels(): ReadonlyMap<string, BoneChannelValue> {
    return this.#channels;
  }

  override evaluate(pose: Pose, alpha: number): void {
    const rig = this.rig;
    if (this.released || rig === null || pose.rig !== rig) return;
    const st = this.#state(pose);
    const n = pose.count;
    const owned = st.owned;
    // 1. the clip-only locals back under the bones the layer changed (raw: the FK and the dirty flags never see this)
    for (let b = 0; b < n; b++) {
      if (owned[b] === 0) continue;
      for (let k = 0; k < 3; k++) pose.t[b * 3 + k] = st.baseT[b * 3 + k]!;
      for (let k = 0; k < 4; k++) pose.r[b * 4 + k] = st.baseR[b * 4 + k]!;
    }
    // 2. the clips
    super.evaluate(pose, alpha);
    // 3. the bone channels over them; bones that lost their channels go back to the clip-only local
    const res = this.#resolve(rig);
    const valueOf = res.valueOf;
    const q = this.#q;
    const r = this.#r;
    for (let b = 0; b < n; b++) {
      if (valueOf[b] === undefined && owned[b] === 0) continue;
      const t3 = b * 3;
      const r4 = b * 4;
      for (let k = 0; k < 3; k++) st.baseT[t3 + k] = pose.t[t3 + k]!;
      for (let k = 0; k < 4; k++) st.baseR[r4 + k] = pose.r[r4 + k]!;
      const v = valueOf[b];
      if (v !== undefined) {
        this.#rotation(q, v.pitch, v.yaw, v.roll);
        qMul(r, 0, pose.r, r4, q, 0);
        pose.r[r4] = r[0]!;
        pose.r[r4 + 1] = r[1]!;
        pose.r[r4 + 2] = r[2]!;
        pose.r[r4 + 3] = r[3]!;
        pose.t[t3 + 1] = pose.t[t3 + 1]! + v.y;
      }
      let changed = owned[b] === 0;
      for (let k = 0; k < 3 && !changed; k++) changed = pose.t[t3 + k] !== st.lastT[t3 + k];
      for (let k = 0; k < 4 && !changed; k++) changed = pose.r[r4 + k] !== st.lastR[r4 + k];
      if (changed) pose.touch(b);
      for (let k = 0; k < 3; k++) st.lastT[t3 + k] = pose.t[t3 + k]!;
      for (let k = 0; k < 4; k++) st.lastR[r4 + k] = pose.r[r4 + k]!;
      owned[b] = v !== undefined ? 1 : 0;
    }
  }

  #state(pose: Pose): LayerState {
    let st = this.#states.get(pose);
    if (st === undefined) {
      const n = pose.count;
      st = {
        baseT: new Float32Array(n * 3),
        baseR: new Float32Array(n * 4),
        lastT: new Float32Array(n * 3),
        lastR: new Float32Array(n * 4),
        owned: new Uint8Array(n),
      };
      this.#states.set(pose, st);
    }
    return st;
  }

  #resolve(rig: PoseRig): Resolved {
    if (this.#resolved !== null && this.#resolved.rig === rig) return this.#resolved;
    const valueOf = new Array<BoneChannelValue | undefined>(rig.bones.length).fill(undefined);
    for (const [name, v] of this.#channels) {
      const b = rig.index(name);
      if (b >= 0) valueOf[b] = v; // a bone this rig lacks is ignored, as a clip track of an unknown bone is
    }
    this.#resolved = { rig, valueOf };
    return this.#resolved;
  }
}

/** The mixer factory for `AnimChannels` (`createMixer` option): a RigMixer for every row. */
export const createRigMixer = (rowId: string, opts: MixerOptions): Mixer => new RigMixer(rowId, null, opts);
