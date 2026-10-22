# K3 integration hooks (for the orchestrator)

The bridge in this folder is complete and tested through these interfaces with the real recorder, mixer, attachment
resolver and three objects. What remains is wiring in files other agents own. Line numbers are against `feat/bone-rigs`'s
base (`3419ef4`); re-locate by the quoted code if the files moved. Every hook is opt-in: a module without `skeleton()` takes
exactly today's path.

Already applied here (opt-in, PP default unchanged): `compat/motion/anim-channel.ts` `AnimChannelsOptions.createMixer` and
`compat/motion/scheduler-hooks.ts` `MotionOptions.createMixer` (passed through to `createAnimChannels`).

## H1. Geometry recorder: `ctx.bone` and `skeleton()` (render/geometry)

1. `render/geometry/generator-types.ts:72-75` `GeneratorModule`: add `skeleton?(): unknown;`.
   `:77-81` `isGeneratorModule`: also require `r['skeleton'] === undefined || typeof r['skeleton'] === 'function'`.
   `:38` `GeometryContext`: add `bone?: (name: string) => void;` (installed per run, see 2).
2. `render/geometry/recorder.ts:64-82` `RecordedMesh`: add `readonly triBone: Uint16Array | null;` (rig bone per triangle).
   `recorder.ts:416-420` `runGeometry`: take an optional rig and bind the cursor before the generator runs:
   ```ts
   export function runGeometry(mod, spec, lod, opts = {}, rig?: PoseRig | null): RecordedMesh {
     const rec = createRecording(spec, lod, opts);
     const cursor = rig ? attachBoneCursor(rec, rig, { strict: opts.strict, script: spec.script }) : null;
     const ret = mod.geometry(rec.ctx);
     const mesh = rec.take(readGeometryReturn(ret, rec.emitted(), spec, opts));
     return { ...mesh, triBone: cursor ? cursor.triBone(mesh.tris) : null };
   }
   ```
   (`take` at `:356-369` returns `triBone: null`.) `attachBoneCursor` is `render/rig/bone-recorder.ts`.
3. `recorder.ts:425-430` `runCollider`: pass the same rig to both its `runGeometry` call and its own `createRecording`
   (`attachBoneCursor(rec, rig)`, result unused): a generator calls `ctx.bone` unconditionally, so a collider run without it
   throws `ctx.bone is not a function`.
4. Keep rejecting `{ joints, weights }` in `readGeometryReturn` (`:396`): soft skinning is out of scope.

## H2. Packing: a bone per vertex, no welding or smoothing across bones (render/geometry/pack.ts)

1. `pack.ts:42-65` `PackedLod`: add `skinIndex?: Uint8Array` (1 per vertex, rig bone; rigs have < 256 bones).
2. `pack.ts:446` vertex key: `const words = 2 + (triRun ? 1 : 0) + (uvsIn ? 2 : 0) + (rec.triBone ? 1 : 0);` and at
   `:482-486` after the uv words: `if (rec.triBone) k[w++] = rec.triBone[t]!;`. When a new vertex is emitted, write
   `skinIndex[vertex] = rec.triBone[t]`.
3. `pack.ts:374, 402-404` smoothing groups: key `(run, bone, position)`: `groupTable.reset(n * 3, rec.triBone ? 4 : 3)` and
   `gk[3] = rec.triBone[t]` when present, so a normal is never averaged over two parts that move apart.
4. `geometry-worker.ts:101`: `packMesh(runGeometry(mod, spec, lod, recOpts, rigOf(script)), opts)`; add `skinIndex.buffer`
   to the transfer list next to `vtx`.

## H3. Kernel / boot: mixers, the `bones` channel, rigs on rows

At the boot site that creates motion (the wiring shown in `compat/motion/scheduler-hooks.ts:30-34`; no caller in `src/` yet):
```ts
const motion = createMotion({ registry, bind, isSimulated, createMixer: createRigMixer });   // render/rig
motion.install(kernel);
const offBones = kernel.store.channels.register(createBonesChannel(motion.anim));           // field 'bones'
kernel.on('rowSpawned', (row) => adoptBoneChannels(motion.anim, row));
```
`RigMixer` behaves exactly as `Mixer` for rows without `bones` channels, so `createRigMixer` may be used for every row. If
another owner later registers a `bones` channel for model rigs (`rotate` / `offset` / `reach`), merge both into one channel:
the registry allows one channel per field.

## H4. Rig per script (render/geometry/geometry-worker.ts and the main-thread key cache)

`geometry-worker.ts:76` after `isGeneratorModule(mod)`: when `mod.skeleton` is a function, call it once per module,
`parseSkeleton()` it (a `SkeletonError` becomes a `GeneratorError`), and cache `rigFromSkeleton(script, spec)` per script
(this is `rigOf(script)` in H2.4). Add `skeleton?: SkeletonSpec` to `PackedKey` (`pack.ts:70-81`) so the main thread builds
the same `RigDef` once per script (cache by script; never per params variant, so a re-skin keeps the mixer bound). When the
row's mesh appears: `motion.anim.setRig(row, rig)` and `presenter.bind(...)` (`scheduler-hooks.ts:164`) with the target of H5.

## H5. Drawing rigged rows (render/geometry/map-batcher.ts, map-plan.ts)

1. `map-plan.ts:292-302` `classifyRows`: a row whose key has `skeleton` is never merged or instanced: route it to
   `standalone` (or `dynamic`), so each row gets its own mesh.
2. At the single-mesh build (`map-batcher.ts:571` `new Mesh(geometry, material)`), for a skinned key build the mesh with
   `createRigidRigInstance(rig, geometry, material, level.dequant)` (`render/rig/three-rig.ts`) after adding
   `geometry.setAttribute('skinIndex', …)` (expand the Uint8 bone to 4 × Uint16 with weights `1,0,0,0`, or add a
   `skinIndex`/`skinWeight` pair directly) and do not multiply `dequant` into the mesh matrix: it is the bind matrix.
3. Hand `instance.target` (a `SkinTarget`, direct path) to the presenter; `applyPose` needs the root's world matrix current
   before it runs (`three-skin.ts` header).
4. Verify in the browser e2e that the packed surface node material keeps three's skinning node on `positionLocal`
   (DESIGN.md risk R2).

## Tests that cover the bridge side

`packages/runtime/test/rig/fk.test.ts` (sim-FK golden < 2 cm on 2 rigs, negative control, three SkinnedMesh incl. a
dequantising bind matrix, one-arm tween, `weapon.y = -4`), `packages/runtime/test/rig/toy-rig.test.ts` (`skeleton()`
parsing, `ctx.bone` on the real recorder, a clip on `gait` through `AnimChannels` + `createMixer`, clip + channel
composition, hat on the `body` bone through `BoneAttachmentResolver`).
