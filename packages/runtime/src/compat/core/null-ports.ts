// Null implementations of every kernel port (docs/design/core-runtime.md §15, docs/architecture.md §9.1): the kernel runs
// headless with them (unit tests, tools, the bake). Each is what "no such domain" means: no bodies, no ground, no render
// build to wait for, no input, no camera yet, no assets, no UI, and a platform with an in-memory save store, no user and no
// ads. A real headless run swaps in the pure-TS physics, nav and motion ports (core §14) and a fixture asset port.
import type {
  AssetFactsPort,
  AttachmentResolver,
  CameraPort,
  InputPort,
  KernelPorts,
  MotionPort,
  PhysicsPort,
  PlaceBake,
  HostPlatform,
  SaveStore,
  SceneSyncPort,
  UiPort,
} from './ports.ts';
import type { InputState, PlaceId } from './types.ts';

/** a sample with nothing held, pressed or moved; a new object each time (consumers may keep or mutate it) */
export function emptyInputState(): InputState {
  return { axes: {}, held: {}, pressed: {}, released: {}, actions: {} };
}

/** a place with nothing baked: no colliders, no nav grid, no terrain */
export function emptyPlaceBake(place: PlaceId): PlaceBake {
  return { colliders: { place, keys: [], instances: [], runtimeKeys: [] }, navgrid: null, terrain: null };
}

const noop = (): void => {};

export function createNullPhysicsPort(): PhysicsPort {
  // one world handle shared by both VMs, as in v1 (motion §5.1)
  const world = Object.freeze({ kind: 'null-physics-world' as const });
  return {
    buildPlace: noop,
    disposePlace: noop,
    rowSpawned: noop,
    rowDestroyed: noop,
    onPhysicsWrite: noop,
    setPosition: noop,
    setRotation: noop,
    setVelocity: noop,
    setAngularVelocity: noop,
    setForce: noop,
    setSpectating: noop,
    applyImpulse: noop,
    step: noop,
    drainTriggerEnters: () => [],
    groundY: () => null,
    vmWorlds: Object.freeze({ platform: world, client: world }),
    setVisualProxies: noop,
  };
}

export function createNullMotionPort(): MotionPort {
  return { advanceTick: noop };
}

export function createNullScenePort(): SceneSyncPort {
  return {
    // nothing to build: the place counts as built at once (the LOADING gate does not wait on a headless run)
    buildPlace: (_place, _rows, _bake, onProgress) => {
      onProgress(1);
      return Promise.resolve();
    },
    disposePlace: noop,
    activate: noop,
    bounds: () => undefined,
    socket: () => null,
  };
}

export function createNullAttachmentResolver(): AttachmentResolver {
  // null: the row takes its parent's world pose
  return { worldPose: () => null };
}

export function createNullInputPort(): InputPort {
  return {
    sampleTick: emptyInputState,
    sampleRig: emptyInputState,
    // nothing is declared, so every action is dropped (contract §12.2: an undeclared sendAction is dropped silently)
    injectAction: () => false,
    setBlocked: noop,
    discardEdges: noop,
    declared: Object.freeze({}),
  };
}

export function createNullCameraPort(): CameraPort {
  return { presentedCamera: () => null, view: () => undefined, worldCamera: () => ({}) };
}

export function createNullAssetFactsPort(): AssetFactsPort {
  return { get: () => undefined, placeBake: (place) => Promise.resolve(emptyPlaceBake(place)) };
}

export function createNullUiPort(): UiPort {
  return { markDirty: noop, uiEvent: noop };
}

/**
 * An in-memory SaveStore: ready at once, survives as long as the object. `set(key, '')` throws: the contract forbids it and
 * the Playgama Bridge would delete the key, so a caller that writes '' must fail in tests instead of passing.
 */
export function createMemorySaveStore(): SaveStore {
  const data = new Map<string, string>();
  return {
    ready: Promise.resolve(),
    get: (key) => data.get(key) ?? null,
    set: (key, value) => {
      if (value === '') throw new TypeError(`SaveStore.set("${key}", ''): an empty value is never written (the Bridge deletes on '')`);
      data.set(key, value);
    },
    remove: (key) => {
      data.delete(key);
    },
    flush: () => Promise.resolve(),
  };
}

/** build §6.1 with no host behind it: the web/null adapter's answers, no ads, no user, never paused or muted by a host */
export function createNullPlatform(): HostPlatform {
  return {
    save: createMemorySaveStore(),
    init: () => Promise.resolve(),
    setLoadingProgress: noop,
    getUser: () => Promise.resolve(null),
    // no host, so no platform event ever fires
    on: () => noop,
  };
}

/** a fresh null implementation of every port */
export function createNullPorts(): KernelPorts {
  return {
    physics: createNullPhysicsPort(),
    motion: createNullMotionPort(),
    scene: createNullScenePort(),
    attach: createNullAttachmentResolver(),
    input: createNullInputPort(),
    camera: createNullCameraPort(),
    assets: createNullAssetFactsPort(),
    ui: createNullUiPort(),
    platform: createNullPlatform(),
  };
}

/** `ports` with every missing (or undefined) entry replaced by its null implementation (KernelOptions.ports, core §3.7) */
export function withNullPorts(ports: Partial<KernelPorts>): KernelPorts {
  return {
    physics: ports.physics ?? createNullPhysicsPort(),
    motion: ports.motion ?? createNullMotionPort(),
    scene: ports.scene ?? createNullScenePort(),
    attach: ports.attach ?? createNullAttachmentResolver(),
    input: ports.input ?? createNullInputPort(),
    camera: ports.camera ?? createNullCameraPort(),
    assets: ports.assets ?? createNullAssetFactsPort(),
    ui: ports.ui ?? createNullUiPort(),
    platform: ports.platform ?? createNullPlatform(),
  };
}
