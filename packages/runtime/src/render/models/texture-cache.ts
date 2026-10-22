// One canonical texture per URL (docs/design/rendering.md §11.1 "One texture per URL"; WP R6).
//
// `GLTFLoader` hands every file its own texture objects (it clones the loaded texture per use), and `WebGPURenderer` uploads one
// GPU texture per `Texture` object. The 66 shared KTX2 images are referenced by hundreds of models, so the template build asks
// this cache for the canonical texture of each map's URL and binds that one: each image is uploaded once. The per-file objects
// are dropped with the glTF scene and never reach the GPU; they share the canonical's mip data, so they cost nothing.
//
//   URL           `texture.userData.ssUrl`, set by `CachedKTX2Loader` (loaders.ts) and kept by `Texture.clone()`. A texture
//                 without one (an embedded image, a test fixture) is keyed by its image source, which clones share too.
//   colour space  set once, from the role of the first use: albedo and emissive sRGB, normal and ORM linear. A later use in
//                 the other class does not flip it (a texture has one GPU format); it is logged once per URL.
//   lifetime      refcounted by owner (a `ModelTemplate`): `release(owner)` drops every texture the owner acquired, and a
//                 texture nobody holds is disposed (its GPU copy goes with it) and reported through `onDispose`.
//   mip data      `releaseMipData(renderer)` (tier `minimum`, §15.4): uploads what is not uploaded yet and drops the CPU copy
//                 of the mips. three re-uploads only when `texture.version` changes, which nothing here does afterwards; a
//                 device-loss rebuild reloads those URLs through the loaders.
import { NoColorSpace, SRGBColorSpace } from 'three/webgpu';
import type { Texture } from 'three/webgpu';

export type TextureRole = 'albedo' | 'emissive' | 'normal' | 'orm';

/** `texture.userData` key of the absolute URL a texture was loaded from */
export const TEXTURE_URL_KEY = 'ssUrl';

/** The cache key of a texture: its URL, else its image source. */
export function textureKeyOf(texture: Texture): string {
  const url = texture.userData[TEXTURE_URL_KEY] as string | undefined;
  return typeof url === 'string' && url !== '' ? url : `source:${texture.source.uuid}`;
}

const isColor = (role: TextureRole): boolean => role === 'albedo' || role === 'emissive';

interface Entry {
  texture: Texture;
  color: boolean;
  owners: Set<object>;
  released: boolean;
}

export interface TextureCacheOptions {
  /** one line per URL used in both colour-space classes; default `console.warn` */
  log?: (message: string) => void;
  /** a canonical texture was disposed: its key (the loader forgets the URL, so a later model fetches it again) */
  onDispose?: (key: string) => void;
}

/** what `releaseMipData` needs of the renderer */
export interface TextureUploader {
  initTexture(texture: Texture): void;
}

export class TextureCache {
  readonly #entries = new Map<string, Entry>();
  readonly #byOwner = new Map<object, Set<string>>();
  readonly #conflicts = new Set<string>();
  readonly #log: (message: string) => void;
  readonly #onDispose: ((key: string) => void) | undefined;

  constructor(opts: TextureCacheOptions = {}) {
    this.#log = opts.log ?? ((m) => console.warn(m));
    this.#onDispose = opts.onDispose;
  }

  /** canonical textures alive */
  get size(): number {
    return this.#entries.size;
  }

  keys(): string[] {
    return [...this.#entries.keys()];
  }

  /** the canonical texture of a key (a URL), if one is alive */
  get(key: string): Texture | undefined {
    return this.#entries.get(key)?.texture;
  }

  /** owners holding a key */
  refs(key: string): number {
    return this.#entries.get(key)?.owners.size ?? 0;
  }

  /**
   * The canonical texture for `loaded` (a per-file texture of the glTF loader), held by `owner` from now on. The first texture
   * seen for a URL becomes the canonical one.
   */
  acquire(loaded: Texture, role: TextureRole, owner: object): Texture {
    const key = textureKeyOf(loaded);
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      loaded.colorSpace = isColor(role) ? SRGBColorSpace : NoColorSpace;
      entry = { texture: loaded, color: isColor(role), owners: new Set(), released: false };
      this.#entries.set(key, entry);
    } else if (entry.color !== isColor(role) && !this.#conflicts.has(key)) {
      this.#conflicts.add(key);
      this.#log(`texture cache: ${key} is used as ${role} but was first bound as ${entry.color ? 'a colour (sRGB)' : 'a data (linear)'} texture; its colour space stays`);
    }
    entry.owners.add(owner);
    let held = this.#byOwner.get(owner);
    if (held === undefined) this.#byOwner.set(owner, (held = new Set()));
    held.add(key);
    return entry.texture;
  }

  /** Drops everything `owner` holds; textures nobody holds any more are disposed. Returns the keys disposed. */
  release(owner: object): string[] {
    const held = this.#byOwner.get(owner);
    if (held === undefined) return [];
    this.#byOwner.delete(owner);
    const disposed: string[] = [];
    for (const key of held) {
      const entry = this.#entries.get(key);
      if (entry === undefined) continue;
      entry.owners.delete(owner);
      if (entry.owners.size > 0) continue;
      this.#entries.delete(key);
      this.#conflicts.delete(key);
      entry.texture.dispose();
      disposed.push(key);
      this.#onDispose?.(key);
    }
    return disposed;
  }

  /** Uploads every canonical texture that still has its mip data and drops that data (see the header). Returns how many. */
  releaseMipData(renderer: TextureUploader): number {
    let n = 0;
    for (const entry of this.#entries.values()) {
      if (entry.released) continue;
      const t = entry.texture as Texture & { isCompressedTexture?: boolean; mipmaps: Array<{ data: unknown; width: number; height: number }> };
      if (t.isCompressedTexture !== true) continue;
      renderer.initTexture(t);
      // sizes stay (three reads `mipmaps.length` and the level sizes for its memory figure); the byte arrays go
      for (const level of t.mipmaps) level.data = null;
      entry.released = true;
      n++;
    }
    return n;
  }

  /** whether a key's CPU mip data was released */
  isReleased(key: string): boolean {
    return this.#entries.get(key)?.released ?? false;
  }

  dispose(): void {
    for (const [key, entry] of this.#entries) {
      entry.texture.dispose();
      this.#onDispose?.(key);
    }
    this.#entries.clear();
    this.#byOwner.clear();
    this.#conflicts.clear();
  }
}
