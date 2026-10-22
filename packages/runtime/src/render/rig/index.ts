// Procedural rigid-bone rigs (plan item K3): see DESIGN.md and INTEGRATION.md in this folder. The three adapter
// (`three-rig.ts`) is not re-exported here so engine-free callers do not load three.
export { moduleRig, parseSkeleton, pivotsOf, rigFromSkeleton, SkeletonError, type SkeletonBone, type SkeletonSpec } from './skeleton.ts';
export {
  BONE_CHANNEL_ROTATION,
  type BoneChannelValue,
  type BoneRotationConvention,
  qFromBoneChannelsDeg,
  readBoneChannels,
} from './bone-channels.ts';
export { createRigMixer, RigMixer, type RigMixerOptions } from './rig-mixer.ts';
export { adoptBoneChannels, type BonesChannelHost, createBonesChannel, installBoneChannels } from './bones-channel.ts';
export { attachBoneCursor, type BoneCursor, type TriangleCounter, UnknownBoneError } from './bone-recorder.ts';
export { bonesUsed, packedSkinAttributes, rigidSkinAttributes, type RigidSkinAttributes, skinMatrix, skinPoint } from './rigid-skin.ts';
export { adoptRowRig, type RigHost, type RiggedKeyLike, ScriptRigs } from './script-rigs.ts';
