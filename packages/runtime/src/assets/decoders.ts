export interface VendorUrls {
  readonly meshoptDecoder: string;
  readonly ktx2: { readonly transcoderPath: string; readonly jsTranscoder: string; readonly wasmTranscoder: string };
  readonly bridgeFallback?: string;
}

function pageBase(): string {
  const doc = (globalThis as { document?: { baseURI?: string } }).document;
  if (doc?.baseURI) return doc.baseURI;
  throw new Error('decoders: no base URL (pass one outside a page)');
}

/** The vendor table with every URL absolute, resolved against `base` (default `document.baseURI`). */
export function vendorUrls(base: string = pageBase(), table: VendorUrls): VendorUrls {
  const abs = (u: string): string => new URL(u, base).href;
  const out: { -readonly [K in keyof VendorUrls]: VendorUrls[K] } = {
    meshoptDecoder: abs(table.meshoptDecoder),
    ktx2: {
      transcoderPath: abs(table.ktx2.transcoderPath),
      jsTranscoder: abs(table.ktx2.jsTranscoder),
      wasmTranscoder: abs(table.ktx2.wasmTranscoder),
    },
  };
  if (table.bridgeFallback !== undefined) out.bridgeFallback = abs(table.bridgeFallback);
  if (!out.ktx2.transcoderPath.endsWith('/')) throw new Error(`decoders: the transcoder path must be a directory, got ${table.ktx2.transcoderPath}`);
  return out;
}

/** three's `MeshoptDecoder` as far as `GLTFLoader.setMeshoptDecoder` and this module use it */
export interface MeshoptDecoderLike {
  ready: Promise<void>;
  supported: boolean;
}

export type ModuleImporter = (url: string) => Promise<Record<string, unknown>>;

const importByUrl: ModuleImporter = (url) => import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>;

const decoders = new Map<string, Promise<MeshoptDecoderLike>>();

/** Imports the vendored meshopt module by URL (once per URL) and waits for its wasm. */
export function loadMeshoptDecoder(url: string, importer: ModuleImporter = importByUrl): Promise<MeshoptDecoderLike> {
  let job = decoders.get(url);
  if (job === undefined) {
    job = importer(url).then(async (module) => {
      const decoder = module['MeshoptDecoder'] as MeshoptDecoderLike | undefined;
      if (decoder === undefined || typeof decoder !== 'object' || !('ready' in decoder)) throw new Error(`decoders: ${url} does not export MeshoptDecoder`);
      await decoder.ready;
      return decoder;
    });
    decoders.set(url, job);
    job.catch(() => {
      if (decoders.get(url) === job) decoders.delete(url);
    });
  }
  return job;
}

/** the two loaders as far as the decoders are concerned */
export interface DecoderTargets {
  ktx2: { setTranscoderPath(path: string): unknown };
  gltf: { setMeshoptDecoder(decoder: never): unknown };
}

export interface ConfigureDecodersOptions {
  /** default `document.baseURI` */
  base?: string;
  importer?: ModuleImporter;
}

/**
 * Points the loaders at the vendored decoders (build §5.10 item 6): `KTX2Loader.setTranscoderPath` on the vendored Basis
 * directory and `GLTFLoader.setMeshoptDecoder` with the vendored meshopt module. Resolves with the absolute URLs it used.
 */
export async function configureDecoders(table: VendorUrls, targets: DecoderTargets, opts: ConfigureDecodersOptions = {}): Promise<VendorUrls> {
  const urls = vendorUrls(opts.base ?? pageBase(), table);
  targets.ktx2.setTranscoderPath(urls.ktx2.transcoderPath);
  const decoder = await loadMeshoptDecoder(urls.meshoptDecoder, opts.importer);
  targets.gltf.setMeshoptDecoder(decoder as never);
  return urls;
}
