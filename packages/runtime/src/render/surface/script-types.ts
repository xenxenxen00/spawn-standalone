// Typed boundary of the three carried JavaScript modules that run inside the renderer (docs/design/rendering.md §2.2; WP R1a):
//
//   scripts/lighting.js   `lighting(surface, lights)`: the BRDF of every lit surface (§7.1)
//   scripts/looks/*.js    `look(ctx)`: the post look (§10.4; the runner is R5b's, the type is declared here)
//   scripts/trail/mat.js  `material(ctx)`: a row's own node material (§14.1)
//
// A module's export shape is checked when it loads: a dev build throws `ScriptShapeError`; a production build logs once per
// script and falls back (an unlit material here; the default look in R5b). `src/render/geometry/generator-types.ts` holds the
// same boundary for the generator modules.
import type { Node, NodeMaterial } from 'three/webgpu';

/** What `lighting()` reads of the shaded point. Every vector is in view space; the script only takes dot products. */
export interface ScriptSurface {
  /** linear albedo, vec3 */
  albedo: Node;
  /** unit normal, vec3 */
  normal: Node;
  /** unit vector towards the camera, vec3 */
  view: Node;
  /** float; after three's `getRoughness` unless [CAL `roughnessAA`] is 'raw' */
  roughness: Node;
  /** float */
  metalness: Node;
  /** float; 1 on every live material (no AO map) */
  occlusion: Node;
}

/** One light as the `lights.each` callback sees it. */
export interface ScriptLight {
  /** unit vector towards the light, vec3 */
  direction: Node;
  /** colour × intensity after falloff, cone and shadow, vec3 */
  radiance: Node;
}

export type ScriptPerLight = (light: ScriptLight) => Node;

export interface ScriptLights {
  /** runs `cb` for every light that reaches the point and returns the sum of what it returns (vec3) */
  each(cb: ScriptPerLight): Node;
  /** ambient + hemisphere irradiance in three's convention (the script divides by π), vec3 */
  ambient: Node;
  /** the environment reflection the engine folded for this surface, vec3 ([CAL `envScale`]) */
  environment: Node;
}

export interface LightingScript {
  lighting(surface: ScriptSurface, lights: ScriptLights): Node;
}

/** What a look script reads (render §10.4): the scene colour and the place's `atmosphere.look.params` as uniforms. */
export interface LookCtx {
  readonly scene: Node;
  param(name: string, def: number | readonly number[]): Node;
}

export interface LookModule {
  look(ctx: LookCtx): Node;
}

/**
 * What `material(ctx)` receives. The live module (authored content) reads nothing of it; `params` is the row's
 * `material.params` (`ScriptedMaterialSpec`). Nothing else is specified by the engine reference.
 */
export interface MaterialCtx {
  readonly params: Readonly<Record<string, number | boolean | string>>;
  /** K10c: `ctx.param(name, default)`, a shader-node uniform for a declared parameter; live updates change its value, never the program */
  param(name: string, def?: number | boolean | readonly number[]): Node;
}

export interface ScriptedMaterialModule {
  material(ctx: MaterialCtx): NodeMaterial;
}

/** A carried module does not export what its role needs. */
export class ScriptShapeError extends Error {
  /** tree path of the module, e.g. `scripts/lighting.js` */
  readonly script: string;
  constructor(script: string, message: string, options?: { cause?: unknown }) {
    super(`${script}: ${message}`, options);
    this.name = 'ScriptShapeError';
    this.script = script;
  }
}

const exportsOf = (mod: unknown): string => (mod !== null && typeof mod === 'object' ? Object.keys(mod).join(', ') || 'nothing' : typeof mod);

/** Throws `ScriptShapeError` unless `mod` exports a `lighting` function. */
export function assertLightingScript(mod: unknown, script: string): asserts mod is LightingScript {
  if (mod === null || typeof mod !== 'object' || typeof (mod as { lighting?: unknown }).lighting !== 'function') {
    throw new ScriptShapeError(script, `a lighting script exports \`lighting(surface, lights)\`; this module exports ${exportsOf(mod)}`);
  }
}

/** Throws `ScriptShapeError` unless `mod` exports a `material` function. */
export function assertScriptedMaterialModule(mod: unknown, script: string): asserts mod is ScriptedMaterialModule {
  if (mod === null || typeof mod !== 'object' || typeof (mod as { material?: unknown }).material !== 'function') {
    throw new ScriptShapeError(script, `a scripted material exports \`material(ctx)\`; this module exports ${exportsOf(mod)}`);
  }
}

/** `import.meta.env.DEV` under Vite and vitest; true under plain Node (tools), where no production build exists */
export const DEV_BUILD: boolean = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV ?? true;

const logged = new Set<string>();

/** Production fallback policy: one console line per script, however often it fails. Returns whether this call logged. */
export function logScriptFailureOnce(script: string, error: unknown, log: (message: string) => void = (m) => console.error(m)): boolean {
  if (logged.has(script)) return false;
  logged.add(script);
  log(`[render] ${error instanceof Error ? error.message : `${script}: ${String(error)}`}; falling back`);
  return true;
}

/** tests: forget which scripts were logged */
export function resetScriptFailureLog(): void {
  logged.clear();
}
