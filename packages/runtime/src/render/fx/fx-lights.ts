// The fx light sinks on the grid's light table (render §13.4): the table calls of `FxRuntime#updateLights` and `#remove`, in
// their order, for the in-process runtime (fx-system.ts) and the worker facade (fx-worker-runtime.ts), which replays a frame's
// selected lights when it presents the frame (DESIGN §6 item 4). A handle lives while its particle is selected.
import type { Object3D } from 'three/webgpu';
import type { BridgeLights } from '../bridge/bridge-types.ts';
import type { Linear3 } from '../color/color.ts';
import type { LightHandle } from '../lighting/light-table.ts';

/** what one effect holds on the light table */
export interface FxLightOwner {
  /** the bound row's node (a held light of a static owner enters the static grid); null for an act-emitted effect */
  readonly node: Object3D | null;
  /** by `<population index>:<particle index>` */
  readonly handles: Map<string, LightHandle>;
  /** the keys selected this frame */
  readonly lit: Set<string>;
}

/** a selected light-sink particle: its handle is added (with the flash key) or its colour, intensity and pose are set */
export function fxLight(
  lights: BridgeLights,
  owner: FxLightOwner,
  key: string,
  held: boolean,
  flashKey: () => string,
  color: Linear3,
  intensity: number,
  radius: number,
  position: { x: number; y: number; z: number },
  staticOwner: ((node: Object3D) => boolean) | undefined,
): void {
  let handle = owner.handles.get(key);
  if (handle === undefined) {
    const staticLight = owner.node !== null && held && staticOwner?.(owner.node) === true;
    handle = lights.add({
      kind: 'point', color, intensity, distance: radius, decay: 2, position,
      mobility: staticLight ? 'static' : 'transient', shadow: false, source: 'fx',
      flashKey: flashKey(),
    });
    owner.handles.set(key, handle);
  } else {
    lights.setColor(handle, color);
    lights.setIntensity(handle, intensity);
    lights.setPose(handle, position);
  }
  owner.lit.add(key);
}

/** the handles of particles not selected this frame go (the selected keys are keys of live particles) */
export function fxLightsDropUnlit(lights: BridgeLights, owner: FxLightOwner): void {
  if (owner.handles.size === 0) return;
  for (const [key, handle] of owner.handles) {
    if (!owner.lit.has(key)) {
      lights.remove(handle);
      owner.handles.delete(key);
    }
  }
}

/** every handle of an effect that leaves */
export function fxLightsRemoveAll(lights: BridgeLights | null | undefined, owner: FxLightOwner): void {
  for (const handle of owner.handles.values()) lights?.remove(handle);
  owner.handles.clear();
}
