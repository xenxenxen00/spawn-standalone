/** Optional corpse/debris batching. Importing the render facade does not activate this plugin. */
import { createGoreRenderers, validateGoreData, type GoreRenderData, type GoreRenderers, type GoreRenderersOptions } from '../world/gore-renderers.ts';
export type { GoreRenderData, GoreRenderStats } from '../world/gore-renderers.ts';
export function createGorePlugin(data: GoreRenderData): (options: Omit<GoreRenderersOptions, 'data'>) => GoreRenderers {
  validateGoreData(data);
  return (options) => createGoreRenderers({ ...options, data: () => data });
}
