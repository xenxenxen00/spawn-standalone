# R10 integration note

DR-53 (2026-10-21): the game install builds the fx Worker's facade, `createFxWorkerSystem()` from `fx-worker-runtime.ts`, by
default; `createFxSystem()` (the in-process runtime) on `?fx=inline` or a page without workers, and the facade falls back to an
in-process world when the worker cannot start or fails. Both take the same `FxSystemOptions` and satisfy `FxRuntimeApi`; what
follows holds for either. The module map: `world/` (three-free: the world, the fills, three's maths on numbers), `fx-worker.ts`
(the worker entry), `fx-protocol.ts` (messages and layouts), `fx-presenter.ts` (the three buckets), `fx-lights.ts` (the
light-table calls); rendering §13.4 describes the split.

The package exposes `createFxSystem()` from `fx-system.ts`. R13/render startup should construct it after the world scene,
camera, post pipeline, shared light-table bridge, lighting script, asset atlas and `RenderBudget` exist. Pass the returned
`FxRuntime` as the render bridge's `fx` dependency (or call `setFxSystem()` when wiring happens later), then register
`runtime.update(frame)` in the render loop's `fx` stage. That stage belongs after `corpses` and before `decals`/`lights`.

Route game `fx` acts to `runtime.emit(spec, worldOrigin)` and their destroy acts to `runtime.end(id)`. Row `fx` values already
flow through `FxSystem.bind()` and are restarted/ended by the render bridge. The atlas tool writes `public/fx-atlas.png` by
default; the asset index or loader should expose that texture to `createFxSystem({ atlas })`.

Weapon muzzle flashes attached to camera rows are a separate space from DSL `follow=camera` (weather follows the viewer in
world projection). The bridge currently declines FX on camera-attached rows; when that shared route is enabled, bind those effects
as viewmodel content and draw their buckets through the shared VIEWMODEL projection (row FOV, near/far 0.1/10, depth remapped
into [0, 0.25]), as described in rendering §4.3/§13.5. They should not be treated as ordinary camera-follow weather.
