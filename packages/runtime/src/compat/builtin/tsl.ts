// builtin/tsl: three.js Shading Language nodes (engine/api-reference.md:1610-1621; engine-threejs.md §4). A pure re-export of
// `three/tsl` r186, with one exception: `time` is Spawn's pausable shader time, `(presentationNow / 1000) % 3600` seconds, a
// uniform the render lane writes once per frame from the PresentationClock (src/render/shader-time.ts, X-11). three's own
// `time` follows performance.now() and would keep running while the game is paused.
//
// The live users (live-vs-leftover.md §7) run as written: scripts/lighting.js (the surface BRDF, engine-threejs.md §5) and
// authored module (the navigation preview); scripts/looks/surge.js is dormant (DR-17). Spawn-only `sceneDepth` / `depthFade` are
// not in r186 and stay undefined, so an import of either fails the build. Imports in Node without a DOM (headless tools can
// build TSL graphs; compiling them needs a renderer).
export * from 'three/tsl';
// a local export shadows the star export of the same name (ES module rule)
export { shaderTime as time } from '../../render/shader-time.ts';
