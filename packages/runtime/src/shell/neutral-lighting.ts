// The neutral lighting module of the default renderer: a plain Lambert BRDF (albedo × (Σ radiance·max(n·l, 0) + ambient / π)),
// used when the game names no lighting module (world.config.yaml `lighting:`) and carries no scripts/lighting.js. Engine
// chunk only: it imports three's TSL and is loaded by default-renderer.ts through `import()`.
import { dot, float, max } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { LightingScript, ScriptLights, ScriptSurface } from '../render/surface/script-types.ts';

/** the node arithmetic used here (TSL's typed nodes, structurally) */
interface V {
  mul(x: unknown): V;
  add(x: unknown): V;
  div(x: unknown): V;
}
const v = (n: unknown): V => n as V;

export const NEUTRAL_LIGHTING: LightingScript = Object.freeze({
  lighting(surface: ScriptSurface, lights: ScriptLights): Node {
    const direct = lights.each((light) => v(light.radiance).mul(max(dot(surface.normal as never, light.direction as never), float(0))) as unknown as Node);
    return v(surface.albedo).mul(v(direct).add(v(lights.ambient).div(float(Math.PI)))) as unknown as Node;
  },
});
