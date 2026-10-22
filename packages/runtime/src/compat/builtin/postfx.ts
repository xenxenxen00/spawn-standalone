// builtin/postfx: the look vocabulary (engine/api-reference.md:1669-1679) as TSL functions (docs/design/rendering.md §2.3,
// §10.4; engine-threejs.md §7.3; WP R5b). The live look scripts run unchanged: `grade`, `vignette`, `grain` and `tint` take a
// colour node and options (numbers, arrays, colour strings or `ctx.param` uniforms) and return a node; `bloom(c)` returns `c`
// (the engine's bloom runs before the look); the seven effects with no live use throw, naming the effect.
// Engine chunk (docs/architecture.md §3.4, X-26): only the look scripts import it, through the module registry's lazy import of
// `atmosphere.look.script`, and they load with the renderer. It reaches three.js through src/render/post/postfx-tsl.ts.
export { grade, vignette, grain, tint, bloom, film, scanlines, dotScreen, chromaticAberration, dof, pixelate, blur } from '../../render/post/postfx-tsl.ts';
