// builtin/three: the three.js classes and constants the engine re-exports (engine/api-reference.md:1623-1638,
// spawn-engine-contract.md builtin table; engine-threejs.md §4). A pure re-export of `three/webgpu` r186: the core classes, the
// node materials and the constants, the same `three.core.js` instances the addons see. The live user is authored module
// (`MeshBasicNodeMaterial`, `AdditiveBlending`, `DoubleSide`; live-vs-leftover.md §7). Imports in Node without a DOM.
export * from 'three/webgpu';
