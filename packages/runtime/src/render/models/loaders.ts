// Model loaders (docs/design/rendering.md §11.1; WP R6): `GLTFLoader` + a cached `KTX2Loader` + the vendored meshopt decoder.
//
//   const loaders = await createModelLoaders(renderer, { vendor });     // after `await renderer.init()`
//   const gltf = await loaders.gltf.loadAsync(url);
//
// - Decoders are the vendored files only (src/assets/decoders.ts): `setTranscoderPath` on `vendor/basis.<hash8>/`, the meshopt
//   module imported by URL. No CDN decoder, no Draco, no Basis URL of three's own.
// - `detectSupport(renderer)` picks the transcode target from the device (three's fixed order: ASTC 4×4, BC7, ETC2, ETC1, BC3,
//   PVRTC, RGBA8); it needs an initialised renderer.
// - Worker limit: the one worker budget of render §6.3 (`geometryWorkerBudget(cores).ktx2`: 1, or 2 from six workers up). The
//   transcoding runs in `KTX2Loader`'s own blob-URL workers; this module starts none.
// - `CachedKTX2Loader` answers a repeated URL from a session cache: one fetch and one transcode per URL, concurrent loads of a
//   URL share the one in flight. Each answer is a clone carrying `userData.ssUrl` (the clone shares the mip data), so
//   `GLTFLoader` can set what it sets per file (name, sampler, colour space) without touching another file's texture; the
//   template build swaps the clone for the canonical texture of that URL (texture-cache.ts), which is the only one uploaded.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { CompressedTexture, LoadingManager, WebGPURenderer } from 'three/webgpu';
import { configureDecoders, type ModuleImporter, type VendorUrls } from '../../assets/decoders.ts';
import { geometryWorkerBudget } from '../geometry/geometry-service.ts';
import { TEXTURE_URL_KEY } from './texture-cache.ts';

type OnLoad = (texture: CompressedTexture) => void;
type OnProgress = (event: ProgressEvent) => void;
type OnError = (err: unknown) => void;

/** A URL with its dot segments resolved (against the page when it is relative and there is one). */
export function normalizeUrl(url: string): string {
  const base = (globalThis as { document?: { baseURI?: string } }).document?.baseURI;
  try {
    return (base === undefined ? new URL(url) : new URL(url, base)).href;
  } catch {
    return url;
  }
}

export class CachedKTX2Loader extends KTX2Loader {
  /** `requests`: `load` calls; `transcodes`: URLs actually fetched and transcoded; `hits`: answered from the cache */
  readonly stats = { requests: 0, transcodes: 0, hits: 0 };
  readonly #session = new Map<string, Promise<CompressedTexture>>();

  constructor(manager?: LoadingManager) {
    super(manager);
  }

  /** URLs in the session cache (loaded or in flight) */
  get cachedUrls(): string[] {
    return [...this.#session.keys()];
  }

  /** The fetch and transcode of one URL: `KTX2Loader.load`. Tests replace it. */
  protected loadUncached(url: string, onLoad: OnLoad, onProgress: OnProgress | undefined, onError: OnError): void {
    super.load(url, onLoad, onProgress, onError);
  }

  override load(requested: string, onLoad: OnLoad, onProgress?: OnProgress, onError?: OnError): void {
    this.stats.requests++;
    // GLTFLoader joins a relative URI onto the file's directory without resolving it (`…/m/../t/x.ktx2`): one key per file
    const url = normalizeUrl(requested);
    let job = this.#session.get(url);
    if (job === undefined) {
      this.stats.transcodes++;
      job = new Promise<CompressedTexture>((resolve, reject) => {
        this.loadUncached(
          url,
          (texture) => {
            texture.userData[TEXTURE_URL_KEY] = url;
            resolve(texture);
          },
          onProgress,
          reject,
        );
      });
      this.#session.set(url, job);
      // a failed URL is not cached: a later model may try it again
      job.catch(() => {
        if (this.#session.get(url) === job) this.#session.delete(url);
      });
    } else this.stats.hits++;
    job.then(
      (texture) => onLoad(texture.clone() as CompressedTexture),
      (err: unknown) => onError?.(err),
    );
  }

  /** Forgets a URL (its canonical texture was disposed): the next load fetches and transcodes it again. */
  forget(url: string): void {
    this.#session.delete(normalizeUrl(url));
  }

  /** Forgets everything (device loss: the rebuild reloads). */
  clear(): void {
    this.#session.clear();
  }
}

/** the KTX2 worker limit of render §6.3 for a core count */
export function ktx2WorkerLimit(hardwareConcurrency: number): number {
  return geometryWorkerBudget(hardwareConcurrency).ktx2;
}

export interface ModelLoadersOptions {
  /** Host-supplied decoder URLs; omitted: ordinary uncompressed glTF only. */
  vendor?: VendorUrls;
  /** default `document.baseURI` */
  base?: string;
  /** default `ktx2WorkerLimit(navigator.hardwareConcurrency)` */
  workerLimit?: number;
  /** imports the meshopt module (tests) */
  importer?: ModuleImporter;
  manager?: LoadingManager;
}

export interface ModelLoaders {
  gltf: GLTFLoader;
  ktx2: CachedKTX2Loader;
  /** the absolute decoder URLs in use */
  urls: VendorUrls | null;
  workerLimit: number;
  dispose(): void;
}

/** Builds the loaders for an initialised renderer (see the header). */
export async function createModelLoaders(renderer: WebGPURenderer, opts: ModelLoadersOptions): Promise<ModelLoaders> {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4;
  const workerLimit = opts.workerLimit ?? ktx2WorkerLimit(cores);
  const ktx2 = new CachedKTX2Loader(opts.manager);
  const gltf = new GLTFLoader(opts.manager);
  const urls = opts.vendor === undefined ? null : await configureDecoders(opts.vendor, { ktx2, gltf }, { ...(opts.base === undefined ? {} : { base: opts.base }), ...(opts.importer === undefined ? {} : { importer: opts.importer }) });
  if (opts.vendor !== undefined) ktx2.detectSupport(renderer);
  ktx2.setWorkerLimit(workerLimit);
  gltf.setKTX2Loader(ktx2);
  return {
    gltf,
    ktx2,
    urls,
    workerLimit,
    dispose() {
      ktx2.clear();
      ktx2.dispose();
    },
  };
}
