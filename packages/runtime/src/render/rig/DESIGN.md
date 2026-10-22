# Procedural rigid-bone rigs

Scope: `skeleton()` / `ctx.bone()` / `bones.*` and `attachment: { bone }`: rigid parts only. No `{ joints, weights }`, no `jiggle`, no
`reach` / `aim` / `ground`, no IK on these rigs. The bridge reuses the motion package (`compat/motion/**`) as it is: the
`Mixer`, clip cooking and binding, `Pose` FK, the three skin adapter and `BoneAttachmentResolver`. New code is in this folder;
the only edits to snapshotted files are two opt-in `createMixer` options (`anim-channel.ts`, `scheduler-hooks.ts`).

## 1. Data model

- **Rig** = named bones, each with a parent (or none) and a **pivot in the model rest frame**. Rest rotation is the identity
  for every bone. `skeleton.ts` `parseSkeleton()` validates and orders parents-first; `rigFromSkeleton()` builds the motion
  package's `RigDef`:
  - local bind translation `bindT[b] = pivot[b] − pivot[parent]` (pivot for a root), `bindR = identity`, `bindS = 1`;
  - `bindModel[b] = T(pivot[b])` (computed by `buildRigDef`'s FK; `pivotsOf()` reads it back).
- **Pivots are model-frame, not parent-frame.** Parent offsets are derived from the difference between model-frame pivots.
- **Binding** = each triangle belongs wholly to one bone (`bone-recorder.ts`). Per vertex: one joint, weight 1
  (`rigid-skin.ts` `rigidSkinAttributes`). A rest-frame point p of bone b is drawn at `model[b] · bindModel[b]⁻¹ · p`
  = `model[b] · (p − pivot[b])`.

## 2. `skeleton()` and `ctx.bone(name)` in geometry

- The generator module exports `skeleton()` beside `geometry(ctx)`. It is called once per module (it takes no ctx) and its
  rig is shared by every row, LOD and `params` variant of that script (re-skinning swaps `primitive.params`, never the rig, so
  the mixer and its clip phase survive: same `RigDef` object, `setRig` not called again).
- `attachBoneCursor(recording, rig)` installs `ctx.bone` on the recorder's ctx (a plain extensible object) and records the
  triangle count at each call; `triBone()` gives one bone per triangle in emission order. Triangles before the first call
  belong to the first root (counted in `unbound`); an unknown name throws in strict runs, else binds to the first root.
- `RecordedMesh` → packed LOD needs a per-vertex bone attribute and must not weld or smooth across bones (INTEGRATION H1-H2).

## 3. Drawing

`three-rig.ts`: one `SkinnedMesh` per rigged row over the shared geometry of its (script, params, LOD) key; per row only a
`Skeleton` of 7-19 `Bone`s. Bones are posed by the existing `three-skin.ts` `applyPose` on the **direct** path
(`bone.matrixWorld = root.matrixWorld × pose.model[b]`, bones with `matrixAutoUpdate` off). Bind mode `attached`, bind matrix
= the packed LOD's dequantisation matrix (identity for float positions), so the int16 positions are dequantised before the
bone matrices. Rigid rows therefore leave the batcher's merged / instanced paths and take the single-mesh path (H5).

## 4. Animation sources and the mixer

- **Clips** (`anim/<arch>.yml` via `builtin/anim` `clips()` / `play()`, or build-cooked `clips/*.json`): unchanged. They are
  `kind: 'delta'` clips, `local R = bindR · qX(pitch)·qY(yaw)·qZ(roll)`, `T = bindT + (x, y, z)`. With `bindR = identity` and
  `bindT = pivot offset`, a delta clip rotates a bone about its pivot and translates it in the parent frame, which is exactly
  the rigid-part semantics. A `gait` channel write goes through the normal mixer write rules (blendIn, loop, restart).
- **`bones.<b>.{pitch,yaw,roll,y}`** (tweened row prop; `builtin/tween` stores `props.bones = { <b>: { pitch, … } }`):
  `RigMixer` (a `Mixer` subclass, `rig-mixer.ts`) applies them after its clips in every `evaluate()`:
  `T = clipT + (0, y, 0)`, `R = clipR · q(channels)`; bones no clip names start from the bind pose. The layer keeps each
  pose's clip-only locals for the bones it overrides, so evaluating twice never accumulates and a removed channel restores the
  clip (or rest) pose. A bone is marked dirty only when its final local changed: a held tween marks nothing.
- The `bones` field reaches the mixer through a property channel (`bones-channel.ts` `createBonesChannel`, H3) that calls
  `setBoneChannels(row.props.bones)`. Other members of a `bones` entry (`rotate`, `offset`, `reach`, …) are ignored here.
- Because `RigMixer` is a `Mixer`, `AnimChannels` (`createMixer: createRigMixer`), the presenter, the corpse freeze and the
  attachment resolver use it unchanged.

## 5. Rotation convention (exact)

`bones.*` channels: `R = Ry(yaw) · Rx(pitch) · Rz(roll)`, degrees, right-handed; applied to a point it is roll about +Z first,
then pitch about +X, then yaw about +Y; quaternion `qY ⊗ qX ⊗ qZ` (`bone-channels.ts` `qFromBoneChannelsDeg`). Per bone the
sim's FK is `p' = pivot + R·(p − pivot) + (0, y, 0)`, walked from the bone up to the root; the renderer's hierarchy
`model[b] = model[parent] · T(pivot[b] − pivot[parent] + (0, y, 0)) · R` gives the same point: by induction
`model[b]·T(−pivot[b]) = M_root ∘ … ∘ M_b` with `M_b = T(pivot_b + y)·R_b·T(−pivot_b)`, which is the sim's per-bone map.
This is the same YXZ order as a row's own rotation. It is NOT the authored-clip order (X·Y·Z): clips keep theirs. Test
`test/rig/fk.test.ts` compares synthetic shallow and deep articulated frames against an independent Three.js Euler/matrix
oracle. Random poses exercise rotation and translation at off-pivot markers; quantized mesh skinning and moved roots are
checked too. The X·Y·Z clip order is retained as a negative control and must produce a measurable error. These tests establish
the documented transform convention on synthetic inputs, without claiming parity with an original game contact solver.

## 6. Attachment by bone

`attachment: { bone }` rows resolve through the existing `BoneAttachmentResolver`: world = parent sim world ·
`pose.model[bone]` · the row's local transform. The bone frame of a rigid rig has its origin at the pivot and the model
axes (rest rotation is identity), so a child offset is measured from that pivot. The resolver's sim pose is evaluated by the RigMixer, so an attachment follows clips **and** bone
channels. `normalisation` is the identity for these rigs (geometry is emitted in the row's frame).

## 7. Evaluation order per frame

1. Sim tick: game code / tweens write `props.bones`; `mixer.write` for `gait` and other channels. The `bones` channel
   notifies at the store's flush (`setBoneChannels`).
2. Step H: `AnimChannels.advanceTick(dt)` (clip clocks, ramps); `BoneAttachmentResolver.endTick()`.
3. Presentation, per rigged row in view: `mixer.evaluate(pose, alpha)` (clips, then bone channels) → `pose.updateModel()`
   (dirty bones and their subtrees only) → root `updateWorldMatrix` → `applyPose(target, pose, pose.modelDirty)` →
   `pose.clearDirty()`. Bone-attached children read their bone afterwards (resolver: alpha 0 sim pose, once per tick).

## 8. Budget

- CPU: one quaternion product per channelled bone, FK one 4×4 compose + multiply per dirty bone. Idle rigs (no clip change,
  held tweens) write no bones: `applyPose` skips them unless the root moved. Measure the host's actual scene budget.
- GPU: one draw per rig per material group, with shared geometry per (script, params, LOD). Each bone matrix uses 64 bytes.
  Skinned meshes are not instanced; large crowds need separate performance evidence.
- LOD: rigid rigs keep their skeleton at every LOD (same `triBone` semantics per LOD run); far rows may skip presentation
  through the existing mixer LOD (`MIXER_LOD`).

## 9. Risks

- R1: pivot frame (model vs parent). Model frame is used; if a live probe shows parent frame, only `rigFromSkeleton` changes.
- R2: the packed surface material must let three's skinning node run on the dequantised position (H5); not testable without
  the renderer.
- R3: the authored-clip order (X·Y·Z) vs the bone-channel order (Y·X·Z) is taken from the existing cook (measured on live
  probes) and from the sim FK respectively; a game mixing both on one bone composes them as `clipR · channelR`.
