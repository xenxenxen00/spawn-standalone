// Copied from purge-protocol-web ebab692 src/app/real-ports.ts (createRealPorts, createIndexLibrary), made game-agnostic for
// composeGame `wiring: 'default'`: the PortWiringEnv is the shell's ShellWiringEnv (the asset resolver is optional: without
// one no library clips are catalogued; the tier is an option, `lowTier`, default false), and the inspect/RenderLinks types
// are the shell's.
//
// Physics (Rapier, loaded on `ensurePhysics()`), nav (observing the physics port) and motion (the `anim`, `mixer` and `ik`
// channels, the bone attachments, the presentation pass), made before the kernel and attached to it in `onKernel`:
//
//   before the kernel   `createNavPort()`, `nav.observe(createPhysicsPort({ dynamics: createRapierDynamics }))`, the clip
//                       registry with the library catalogue of the asset index (`clip-<name>.glb` → its `.jsonz`), `createMotion`,
//                       the presenter over `threeSkin`
//   onKernel            `physics.attachKernel(k, { geometry })`, `nav.attachKernel(k)`, `motion.install(k)`, and the default anim
//                       host of `builtin/anim` over the registry's anim entries (`virtual:ss/anim`: authored + cooked clips)
//   attachRenderer      the render side of the game exists: the bone attachments read the models' normalisation and rigs
import { inflateSync } from 'fflate';
import type { AssetResolver } from '../assets/resolver.ts';
import { createAnimHost, setDefaultAnimHost, type AnimFileEntry } from '../compat/builtin/anim.ts';
import type { CoreKernel } from '../compat/core/kernel.ts';
import type { RowRec, Vec3 } from '../compat/core/types.ts';
import { ClipRegistry } from '../compat/motion/clip-registry.ts';
import { LibraryClips } from '../compat/motion/library.ts';
import type { PoseRig } from '../compat/motion/pose.ts';
import { retargetBinder } from '../compat/motion/retarget.ts';
import { createMotion, type Motion, type MotionPresenter } from '../compat/motion/scheduler-hooks.ts';
import { rigOfSkin, threeSkin, type SkinSource } from '../compat/motion/three-skin.ts';
import { createNavPort, type NavPort } from '../compat/nav/port.ts';
import { createPhysicsPort, type PhysicsHost, type PhysicsPortImpl } from '../compat/physics/port.ts';
import { createRapierDynamics } from '../compat/physics/rapier/dynamics.ts';
import { installBoneChannels } from '../render/rig/bones-channel.ts';
import { createRigMixer } from '../render/rig/rig-mixer.ts';
import type { ShellWiring, ShellWiringEnv } from './compose-game.ts';

/** what the motion domain reads of the render side once the engine exists (render's GameWorld) */
export interface RenderLinks {
  model(rowId: string): unknown;
  rigFrame(rowId: string): ArrayLike<number> | null;
}

/** the wiring plus its parts, for tests and tools */
export interface DefaultWiring extends ShellWiring {
  readonly physics: PhysicsPortImpl;
  readonly nav: NavPort;
  readonly motion: Motion;
  readonly presenter: MotionPresenter;
  readonly clips: ClipRegistry;
  readonly library: LibraryClips;
  inspect(): Record<string, unknown>;
}

export interface DefaultWiringOptions {
  /** fetches a file of the asset index (tests); default `globalThis.fetch` */
  fetch?: (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  /** the physics port; default `createPhysicsPort({ dynamics: createRapierDynamics })` */
  physics?: PhysicsPortImpl;
  /** the low / minimum tier: the mixer's low-tier LOD distances (default false) */
  lowTier?: boolean;
  /**
   * K3: procedural rigs. Motion makes a RigMixer for every row (`createMixer: createRigMixer`: identical to a Mixer for a row
   * without `bones` channels) and `onKernel` installs the `bones` property channel. Default false (PP).
   */
  rigs?: boolean;
  warn?: (message: string) => void;
}

const CLIP_ENTRY = /^clip-(.+)\.glb$/;

/** a `.jsonz` file of the asset index: one raw deflate stream over JSON */
async function fetchJsonz(fetcher: NonNullable<DefaultWiringOptions['fetch']>, url: string): Promise<unknown> {
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
  return JSON.parse(new TextDecoder().decode(inflateSync(new Uint8Array(await res.arrayBuffer()))));
}

/** The library catalogue of an asset index: the compiled clips by name, each with the file of its source rig. */
export function createIndexLibrary(assets: AssetResolver | null, opts: Pick<DefaultWiringOptions, 'fetch' | 'warn'> = {}): LibraryClips {
  const fetcher = opts.fetch ?? ((url: string) => globalThis.fetch(url));
  const rigUrls = new Map<string, string>();
  const names: string[] = [];
  for (const [key, entry] of Object.entries(assets?.index.entries ?? {})) {
    const m = entry.k === 'clip' ? CLIP_ENTRY.exec(key) : null;
    if (m !== null && entry.u !== null) names.push(m[1]!);
  }
  const library = new LibraryClips({
    async loadClip(name) {
      const key = `clip-${name}.glb`;
      const url = assets?.resolve(key) ?? null;
      if (url === null || assets === null) throw new Error(`${key} is not in the asset index`);
      const json = await fetchJsonz(fetcher, url);
      const rig = (json as { sourceRig?: unknown } | null)?.sourceRig;
      const rigFile = assets.entry(key)?.d?.[0];
      if (typeof rig === 'string' && rigFile !== undefined && !rigUrls.has(rig)) rigUrls.set(rig, new URL(rigFile, assets.base).href);
      return json;
    },
    async loadRig(id) {
      const url = rigUrls.get(id);
      if (url === undefined) throw new Error(`no file for the source rig ${id} in the asset index`);
      return fetchJsonz(fetcher, url);
    },
    onError: (name, error) => (opts.warn ?? ((m: string) => console.warn(m)))(`[motion] library clip ${name} did not load: ${error.message}`),
  });
  library.catalogue(names);
  return library;
}

/** composeGame `wiring: 'default'`: physics, nav and motion (see the header) */
export function createDefaultWiring(env: ShellWiringEnv, opts: DefaultWiringOptions = {}): DefaultWiring {
  const warn = opts.warn ?? ((m: string): void => console.warn(m));
  const nav = createNavPort({ warn: (m) => warn(`[nav] ${m}`) });
  const physics = nav.observe(opts.physics ?? createPhysicsPort({ dynamics: createRapierDynamics }));
  const raycaster = physics.staticRaycaster();

  const clips = new ClipRegistry();
  const library = createIndexLibrary(env.assets ?? null, { ...(opts.fetch ? { fetch: opts.fetch } : {}), warn });
  clips.setLibrary(library);
  retargetBinder.setSourceRigs((id) => library.rig(id));

  let kernel: CoreKernel | null = null;
  let links: RenderLinks | null = null;
  const motion = createMotion({
    registry: clips,
    bind: retargetBinder.tryBind,
    isSimulated: (place) => place !== null && kernel !== null && kernel.places.isSimulated(place),
    ...(opts.rigs ? { createMixer: createRigMixer } : {}),
    normalisation: (parent: RowRec) => links?.rigFrame(parent.id) ?? null,
    rigOf: (parent: RowRec): PoseRig | null => {
      const model = links?.model(parent.id) ?? null;
      return model === null ? null : rigOfSkin(model as SkinSource);
    },
  });
  const presenter = motion.presenter({
    skin: threeSkin,
    eye: (): Vec3 | null => env.eye(),
    lowTier: opts.lowTier ?? false,
    castDown: (x, y, z, maxDist) => raycaster.castDown({ x, y, z }, maxDist)?.y ?? null,
  });

  const undo: Array<() => void> = [];
  let disposed = false;
  return {
    physics,
    nav,
    motion,
    presenter,
    clips,
    library,
    ports: { physics, motion: motion.port, attach: motion.attach },
    ensurePhysics: () => physics.ensure(),
    raycaster,
    mixer: presenter as never,
    setVisualProxies: (place, soup) => physics.setVisualProxies(place, soup),
    onKernel(k) {
      kernel = k;
      const geometry = env.geometry as unknown as NonNullable<PhysicsHost['geometry']> | undefined;
      physics.attachKernel(k, { ...(geometry && typeof geometry.colliderForSync === 'function' ? { geometry } : {}), warn: (m) => warn(`[physics] ${m}`) });
      nav.attachKernel(k);
      undo.push(motion.install(k));
      if (opts.rigs) undo.push(installBoneChannels(motion.anim, k));
      const registry = k.registry as unknown as { anim?(path: string): AnimFileEntry | undefined };
      setDefaultAnimHost(createAnimHost({ registry: clips, file: (path) => registry.anim?.(path) }));
      undo.push(() => setDefaultAnimHost(null));
    },
    inspect() {
      const resident = physics.residentPlaces();
      return {
        physics: { storedBuilds: physics.storedBuilds, resident, built: resident.filter((p) => physics.isBuilt(p)) },
        nav: { places: nav.residentPlaces() },
        motion: { mixers: motion.anim.size, presented: presenter.stats.rows, evaluated: presenter.stats.evaluated, bonesWritten: presenter.stats.bonesWritten },
        clips: { catalogued: library.names().length, authoredFiles: clips.authoredFiles().length },
        renderer: links !== null,
      };
    },
    attachRenderer(next) {
      links = next;
      motion.attach.invalidate();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      links = null;
      for (const off of undo.splice(0).reverse()) off();
      retargetBinder.setSourceRigs(() => undefined);
      retargetBinder.clear();
      nav.dispose();
      physics.dispose();
    },
  };
}
