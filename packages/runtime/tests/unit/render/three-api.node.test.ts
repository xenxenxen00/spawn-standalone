// The three r186 API names the render design relies on (docs/design/rendering.md Appendix C; WP R0). Checked there against
// the installed three@0.186.1 by a Node import of `three/webgpu`, `three/tsl` and the addon modules; this test is that check,
// committed, so an upgrade that renames or drops one of them fails here before anything renders. A three upgrade moves one
// release per change and this list gates it (render §3.2).
//
// Plain Node, no DOM and no GPU: classes and constants are looked up on the module namespaces, `Class#member` on the prototype
// chain, and members that only exist on instances (fields assigned in a constructor) on an object built here. The renderer is
// constructed on a stub canvas and never initialised, so no context is ever requested.
//
// The compat builtins (`builtin/tsl`, `builtin/three`) and the pausable `time` have their own test
// (tests/unit/boundary/builtin-render-facades.node.test.ts).
import * as TSL from 'three/tsl';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';

type Bag = Record<string, unknown>;
type Ctor = abstract new (...args: never[]) => unknown;

const webgpu = THREE as unknown as Bag;
const tsl = TSL as unknown as Bag;

const CLASSES = [
  'WebGPURenderer', 'RenderPipeline', 'PostProcessing', 'MeshStandardNodeMaterial', 'MeshBasicNodeMaterial', 'SpriteNodeMaterial',
  'NodeMaterial', 'LightingModel', 'PhysicalLightingModel', 'LightsNode', 'Lighting', 'QuadMesh', 'PassNode', 'Node', 'Scene',
  'PerspectiveCamera', 'Object3D', 'Group', 'Mesh', 'InstancedMesh', 'BatchedMesh', 'SkinnedMesh', 'Skeleton', 'Bone', 'Sprite',
  'LineSegments', 'BufferGeometry', 'BufferAttribute', 'InstancedBufferAttribute', 'InterleavedBuffer', 'Int16BufferAttribute',
  'Uint8BufferAttribute', 'Uint16BufferAttribute', 'Float32BufferAttribute', 'DataTexture', 'Data3DTexture', 'CanvasTexture',
  'CompressedTexture', 'Texture', 'RenderTarget', 'FogExp2', 'Color', 'Sphere', 'Box3', 'Frustum', 'Matrix4', 'Vector3',
  'Quaternion', 'AmbientLight', 'HemisphereLight', 'DirectionalLight', 'SpotLight', 'PointLight',
] as const;

const CONSTANTS = [
  'HalfFloatType', 'FloatType', 'UnsignedByteType', 'UnsignedShortType', 'RGBAFormat', 'RGFormat', 'RedFormat', 'NearestFilter',
  'LinearFilter', 'AdditiveBlending', 'NormalBlending', 'DoubleSide', 'FrontSide', 'BackSide', 'ACESFilmicToneMapping',
  'NeutralToneMapping', 'NoToneMapping', 'SRGBColorSpace', 'LinearSRGBColorSpace', 'PCFShadowMap', 'PCFSoftShadowMap',
  'DynamicDrawUsage', 'REVISION',
] as const;

/** `Class#member` that live on the prototype chain (methods and accessors) */
const PROTOTYPE_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  WebGPURenderer: [
    'init', 'render', 'compileAsync', 'setAnimationLoop', 'setPixelRatio', 'setSize', 'dispose', 'hasFeature',
    'readRenderTargetPixelsAsync', 'initTexture', 'copyTextureToTexture', 'getOutputBufferType', 'coordinateSystem',
  ],
  Object3D: ['updateWorldMatrix'],
  BatchedMesh: ['deleteGeometry', 'addGeometry', 'addInstance', 'setMatrixAt', 'setColorAt', 'setGeometryIdAt', 'setVisibleAt'],
  PassNode: ['getTextureNode', 'getViewZNode', 'getLinearDepthNode', 'setResolutionScale', 'setMRT'],
  LightingModel: ['start', 'finish', 'direct', 'directRectArea', 'indirect', 'ambientOcclusion'],
  LightsNode: ['setup', 'setupLightsNode', 'setupLights', 'customCacheKey', 'setLights', 'getLights', 'hasLights'],
  Lighting: ['createNode', 'getNode'],
  InstancedMesh: ['setMatrixAt', 'setColorAt'],
  BufferAttribute: ['addUpdateRange', 'clearUpdateRanges', 'setUsage'],
  DataTexture: ['addUpdateRange'],
  SkinnedMesh: ['applyBoneTransform', 'getVertexPosition', 'computeBoundingSphere'],
  Skeleton: ['update', 'computeBoneTexture'],
  Node: ['onObjectUpdate', 'onRenderUpdate', 'onFrameUpdate'],
  // the projection hook the viewmodel material overrides instead of setting `vertexNode` (WP R8, surface-material.ts)
  NodeMaterial: ['setupModelViewProjection', 'setupPositionView'],
};

const TSL_LIVE = ['vec3', 'float', 'mix', 'dot', 'max', 'normalize', 'pow', 'clamp', 'oneMinus', 'PI', 'convertToTexture', 'screenUV', 'uv', 'time', 'fract', 'smoothstep'] as const;
/** Spawn-only names: absent in r186, so a carried import of either fails the build instead of rendering wrong */
const TSL_ABSENT = ['sceneDepth', 'depthFade'] as const;

const TSL_PORT = [
  'Fn', 'If', 'Loop', 'Continue', 'Break', 'uniform', 'uniformArray', 'reference', 'texture', 'textureLoad', 'attribute',
  'instancedBufferAttribute', 'instancedDynamicBufferAttribute', 'billboarding', 'positionWorld', 'positionView', 'positionLocal',
  'positionGeometry', 'positionViewDirection', 'positionWorldDirection', 'normalView', 'normalWorld', 'normalFlat',
  'normalWorldGeometry', 'diffuseColor', 'roughness', 'metalness', 'emissive', 'getDistanceAttenuation', 'pass', 'mrt',
  'renderOutput', 'fog', 'densityFogFactor', 'hash', 'frameId', 'screenCoordinate', 'luminance', 'select', 'step', 'int', 'ivec2',
  'vec2', 'vec4', 'cameraViewMatrix', 'cameraProjectionMatrix', 'modelViewMatrix', 'faceDirection', 'varying', 'skinning',
] as const;

/** a canvas three can hold without a DOM: the renderer is constructed on it and never initialised */
function stubCanvas(): HTMLCanvasElement {
  return {
    width: 300,
    height: 150,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getContext() {
      throw new Error('three-api test: no context may be requested');
    },
  } as unknown as HTMLCanvasElement;
}

describe('three r186 (render Appendix C)', () => {
  it('REVISION is 186 (the pin of package.json: three 0.186.1)', () => {
    expect(THREE.REVISION).toBe('186');
  });

  it('three/webgpu exports every class the design uses', () => {
    const missing = CLASSES.filter((n) => typeof webgpu[n] !== 'function');
    expect(missing).toEqual([]);
  });

  it('NodeUtils is a namespace of helpers', () => {
    expect(typeof webgpu['NodeUtils']).toBe('object');
    expect(webgpu['NodeUtils']).not.toBeNull();
  });

  it('PostProcessing is still there as the deprecated name of RenderPipeline (renamed in r183)', () => {
    const PostProcessing = webgpu['PostProcessing'] as { prototype: object };
    expect(PostProcessing.prototype).toBeInstanceOf(THREE.RenderPipeline);
  });

  it('three/webgpu exports every constant the design uses', () => {
    const missing = CONSTANTS.filter((n) => webgpu[n] === undefined);
    expect(missing).toEqual([]);
    // PCFSoftShadowMap is exported but its behaviour is gone from WebGPURenderer (it warns): the port uses PCFShadowMap
    expect(THREE.PCFShadowMap).not.toBe(THREE.PCFSoftShadowMap);
  });

  it('every `Class#member` resolves on the prototype chain', () => {
    const missing: string[] = [];
    for (const [cls, members] of Object.entries(PROTOTYPE_MEMBERS)) {
      const C = webgpu[cls] as Ctor | undefined;
      if (typeof C !== 'function') {
        missing.push(cls);
        continue;
      }
      for (const m of members) if (!(m in (C.prototype as object))) missing.push(`${cls}#${m}`);
    }
    expect(missing).toEqual([]);
  });

  it('WebGPURenderer: instance fields `info` and `onDeviceLost`, half float output by default, no context before init()', () => {
    const renderer = new THREE.WebGPURenderer({ forceWebGL: true, canvas: stubCanvas() });
    expect(typeof renderer.onDeviceLost).toBe('function');
    expect(renderer.getOutputBufferType()).toBe(THREE.HalfFloatType);
    expect(renderer.coordinateSystem).toBe(THREE.WebGLCoordinateSystem);
    expect((renderer.backend as unknown as { isWebGLBackend?: boolean }).isWebGLBackend).toBe(true);

    const info = renderer.info as unknown as { createProgram: unknown; render: Bag; memory: Bag };
    expect(typeof info.createProgram).toBe('function'); // Info#createProgram: the program counter of render §15.5
    for (const k of ['drawCalls', 'triangles']) expect(typeof info.render[k], `info.render.${k}`).toBe('number');
    for (const k of ['texturesSize', 'total', 'programs']) expect(typeof info.memory[k], `info.memory.${k}`).toBe('number');

    // RenderPipeline#outputColorTransform is an instance field as well; the pipeline is built without touching the GPU
    const pipeline = new THREE.RenderPipeline(renderer);
    expect(pipeline.outputColorTransform).toBe(true);
    expect(typeof pipeline.render).toBe('function');
  });

  it('instance fields of the scene-graph classes', () => {
    const o = new THREE.Object3D();
    expect(o.frustumCulled).toBe(true);
    expect(o.renderOrder).toBe(0);
    expect(o.matrixWorldAutoUpdate).toBe(true);

    expect(new THREE.MeshBasicNodeMaterial().forceSinglePass).toBe(false); // Material#forceSinglePass

    const instanced = new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicNodeMaterial(), 1);
    expect('boundingSphere' in instanced).toBe(true);
    expect(instanced.boundingSphere).toBeNull();

    expect(new THREE.BatchedMesh(1, 3, 3).perObjectFrustumCulled).toBe(true);
    expect(new THREE.Sprite().count).toBe(1);
  });

  it('three/tsl exports the 16 names the live scripts import', () => {
    const missing = TSL_LIVE.filter((n) => tsl[n] === undefined);
    expect(missing).toEqual([]);
  });

  it('the Spawn-only sceneDepth and depthFade are absent', () => {
    for (const n of TSL_ABSENT) expect(n in tsl, n).toBe(false);
  });

  it('three/tsl exports every node the port uses', () => {
    const missing = TSL_PORT.filter((n) => tsl[n] === undefined);
    expect(missing).toEqual([]);
  });
});

describe('three r186 addons (render Appendix C)', () => {
  const fn = (mod: object, name: string): void => expect(typeof (mod as Bag)[name], name).toBe('function');
  const methods = (C: unknown, names: readonly string[]): void => {
    expect(typeof C).toBe('function');
    const proto = (C as { prototype: object }).prototype;
    const missing = names.filter((m) => !(m in proto));
    expect(missing).toEqual([]);
  };

  it('tsl/display: bloom, fxaa, smaa, lut3D', async () => {
    fn(await import('three/addons/tsl/display/BloomNode.js'), 'bloom');
    fn(await import('three/addons/tsl/display/FXAANode.js'), 'fxaa');
    fn(await import('three/addons/tsl/display/SMAANode.js'), 'smaa');
    fn(await import('three/addons/tsl/display/Lut3DNode.js'), 'lut3D');
  });

  it('loaders: GLTFLoader and KTX2Loader with the members the model loader calls', async () => {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    methods(GLTFLoader, ['setKTX2Loader', 'setMeshoptDecoder', 'register', 'loadAsync', 'parseAsync']);
    const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
    methods(KTX2Loader, ['detectSupport', 'setWorkerLimit', 'setTranscoderPath', 'dispose']);
  });

  it('utils: SkeletonUtils and BufferGeometryUtils', async () => {
    const skeleton = await import('three/addons/utils/SkeletonUtils.js');
    for (const n of ['clone', 'retarget', 'retargetClip']) fn(skeleton, n);
    const geometry = await import('three/addons/utils/BufferGeometryUtils.js');
    for (const n of ['mergeGeometries', 'mergeVertices']) fn(geometry, n);
  });

  it('lighting: DynamicLighting (the fallback) and DynamicLightsNode (the pattern GridLightsNode follows)', async () => {
    fn(await import('three/addons/lighting/DynamicLighting.js'), 'DynamicLighting');
    const node = (await import('three/addons/tsl/lighting/DynamicLightsNode.js')) as Bag;
    expect(typeof node['default']).toBe('function');
  });

  it('math and libs: SimplexNoise, the vendored meshopt decoder', async () => {
    fn(await import('three/addons/math/SimplexNoise.js'), 'SimplexNoise');
    const { MeshoptDecoder } = (await import('three/addons/libs/meshopt_decoder.module.js')) as { MeshoptDecoder: Bag };
    expect(typeof MeshoptDecoder).toBe('object');
    expect(typeof MeshoptDecoder['decodeGltfBuffer']).toBe('function');
  });
});
