// The texture-script runner (docs/architecture.md X-47, §9.3 RH1; `docs/analysis/system-rendering-look.md` Appendix C.2;
// `docs/analysis/sync-6b9b53e3.md` §5).
//
// A texture script is a carried module that paints a texture on a 2D canvas: `export function texture(ctx)` and an optional
// `export const meta = { filter, wrap }`. The live tree has one, `scripts/tex-beam.js` (the torch haze fade, worn by the
// `ss-torch-cone` primitives of authored content). A `material.texture` that names one
// (`material-spec.ts` `isTextureScriptPath`) is resolved here instead of by a file load.
//
//   the realm    `texture(ctx)` gets a ctx of this module's, not a kernel realm (docs/architecture.md §9.3 C5): only
//                `ctx.canvas(w, h)`, which returns a 2D-context shim with `width`, `height`, `createImageData(w, h)`,
//                `getImageData(x, y, w, h)` and `putImageData(image, dx, dy)` over an RGBA byte buffer. "The first canvas
//                IS the texture" (`skills/2d-mode.md:17-26`): a script that asks for more gets them, and only the first is
//                uploaded. The call runs once per script path
//   the texture  one RGBA8 `DataTexture` per path, sRGB like every row texture (the canvas holds display values; the
//                hardware decodes, so no program depends on it), no mipmaps. Rows flip on the way in: canvas row 0 is the
//                top of the image, and three samples a `DataTexture` (no `flipY`) with v = 0 at its first row, so the
//                canvas's LAST row lands at v = 0 (the cylinder's bottom, the lamp end of a haze cone), as on Spawn
//   meta         `filter: 'linear'` (the default) or `'nearest'`; `wrap: 'clamp'` or `'repeat'` (the default; the
//                documented `wrap: 'clamp'` "fits it once", `skills/geometry.md:32`). Anything else is reported once and
//                the default is used
//
// A script whose `texture` is missing or throws, or that paints no canvas, rejects its path's promise: the row-texture
// loader (bridge/attach.ts `createRowTextures`) logs it once and the row keeps drawing with the shared plain white texture
// (primitives.ts `whiteTexture`). Nothing of a failed script reaches the game.
import { ClampToEdgeWrapping, DataTexture, LinearFilter, NearestFilter, RGBAFormat, RepeatWrapping, SRGBColorSpace, UnsignedByteType } from 'three/webgpu';

/** the largest canvas edge a texture script may ask for */
export const TEXTURE_SCRIPT_MAX_SIZE = 4096;

export interface TextureScriptMeta {
  filter?: unknown;
  wrap?: unknown;
}

/** what a carried texture script exports */
export interface TextureScriptModule {
  texture?: unknown;
  meta?: unknown;
}

/** `ctx.createImageData` / `getImageData`: the subset of the DOM `ImageData` the scripts read and write */
export interface ScriptImageData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** the 2D-context shim `ctx.canvas(w, h)` returns */
export interface ScriptCanvas {
  readonly width: number;
  readonly height: number;
  createImageData(w: number, h: number): ScriptImageData;
  getImageData(x: number, y: number, w: number, h: number): ScriptImageData;
  putImageData(image: ScriptImageData, dx: number, dy: number): void;
}

export interface TextureScriptCtx {
  canvas(w: number, h: number): ScriptCanvas;
}

/** the painted pixels, canvas order (row 0 = top), before the upload */
export interface TextureScriptImage {
  width: number;
  height: number;
  /** RGBA, row 0 = the canvas's top row */
  data: Uint8ClampedArray;
  filter: 'linear' | 'nearest';
  wrap: 'repeat' | 'clamp';
}

const edge = (v: unknown, what: string): number => {
  const n = typeof v === 'number' ? Math.floor(v) : NaN;
  if (!Number.isFinite(n) || n < 1 || n > TEXTURE_SCRIPT_MAX_SIZE) throw new RangeError(`${what} must be an integer from 1 to ${TEXTURE_SCRIPT_MAX_SIZE}, got ${String(v)}`);
  return n;
};

function imageData(w: number, h: number): ScriptImageData {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}

function scriptCanvas(width: number, height: number, pixels: Uint8ClampedArray): ScriptCanvas {
  return {
    width,
    height,
    createImageData: (w, h) => imageData(edge(w, 'createImageData width'), edge(h, 'createImageData height')),
    getImageData(x, y, w, h) {
      const out = imageData(edge(w, 'getImageData width'), edge(h, 'getImageData height'));
      for (let row = 0; row < out.height; row++) {
        const sy = Math.floor(y) + row;
        if (sy < 0 || sy >= height) continue;
        for (let col = 0; col < out.width; col++) {
          const sx = Math.floor(x) + col;
          if (sx < 0 || sx >= width) continue;
          const s = (sy * width + sx) * 4;
          const d = (row * out.width + col) * 4;
          out.data[d] = pixels[s]!;
          out.data[d + 1] = pixels[s + 1]!;
          out.data[d + 2] = pixels[s + 2]!;
          out.data[d + 3] = pixels[s + 3]!;
        }
      }
      return out;
    },
    putImageData(image, dx, dy) {
      const src = image.data;
      const w = image.width;
      const h = image.height;
      if (!(src instanceof Uint8ClampedArray) || src.length < w * h * 4) throw new TypeError('putImageData: not an image of createImageData');
      // the DOM rule: the image is copied with its top-left at (dx, dy), clipped to the canvas, no blending
      for (let row = 0; row < h; row++) {
        const ty = Math.floor(dy) + row;
        if (ty < 0 || ty >= height) continue;
        for (let col = 0; col < w; col++) {
          const tx = Math.floor(dx) + col;
          if (tx < 0 || tx >= width) continue;
          const s = (row * w + col) * 4;
          const d = (ty * width + tx) * 4;
          pixels[d] = src[s]!;
          pixels[d + 1] = src[s + 1]!;
          pixels[d + 2] = src[s + 2]!;
          pixels[d + 3] = src[s + 3]!;
        }
      }
    },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * Runs a texture script once: its pixels in canvas order, with the sampler `meta` asks for. Throws when the module is not
 * a texture script or paints no canvas (`textureFromScript` turns that into a log line).
 */
export function runTextureScript(mod: TextureScriptModule, path: string, log: (message: string) => void = (m) => console.warn(m)): TextureScriptImage {
  if (typeof mod.texture !== 'function') throw new TypeError(`texture script ${path}: exports no texture(ctx)`);
  let first: { width: number; height: number; data: Uint8ClampedArray } | null = null;
  const ctx: TextureScriptCtx = {
    canvas(w, h) {
      const width = edge(w, 'ctx.canvas width');
      const height = edge(h, 'ctx.canvas height');
      const data = new Uint8ClampedArray(width * height * 4);
      first ??= { width, height, data };
      return scriptCanvas(width, height, data);
    },
  };
  (mod.texture as (c: TextureScriptCtx) => unknown)(ctx);
  const painted = first as { width: number; height: number; data: Uint8ClampedArray } | null;
  if (painted === null) throw new Error(`texture script ${path}: texture(ctx) painted no canvas`);
  const meta: TextureScriptMeta = isRecord(mod.meta) ? (mod.meta as TextureScriptMeta) : {};
  let filter: 'linear' | 'nearest' = 'linear';
  if (meta.filter === 'nearest' || meta.filter === 'linear') filter = meta.filter;
  else if (meta.filter !== undefined) log(`[texture-script] ${path}: meta.filter ${JSON.stringify(meta.filter)} is not 'linear' or 'nearest'; linear is used`);
  let wrap: 'repeat' | 'clamp' = 'repeat';
  if (meta.wrap === 'clamp' || meta.wrap === 'repeat') wrap = meta.wrap;
  else if (meta.wrap !== undefined) log(`[texture-script] ${path}: meta.wrap ${JSON.stringify(meta.wrap)} is not 'clamp' or 'repeat'; repeat is used`);
  return { width: painted.width, height: painted.height, data: painted.data, filter, wrap };
}

/** The upload of a painted image: canvas rows flipped (the last row at v = 0), sRGB, the meta's sampler. */
export function textureFromImage(image: TextureScriptImage, name: string): DataTexture {
  const { width, height } = image;
  const rows = new Uint8Array(width * height * 4);
  const stride = width * 4;
  for (let y = 0; y < height; y++) rows.set(image.data.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
  const texture = new DataTexture(rows, width, height, RGBAFormat, UnsignedByteType);
  texture.name = name;
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.flipY = false;
  const filter = image.filter === 'nearest' ? NearestFilter : LinearFilter;
  texture.magFilter = filter;
  texture.minFilter = filter;
  const wrap = image.wrap === 'clamp' ? ClampToEdgeWrapping : RepeatWrapping;
  texture.wrapS = wrap;
  texture.wrapT = wrap;
  texture.needsUpdate = true;
  return texture;
}

export interface TextureScriptsOptions {
  /** the carried module at a tree path (src/game-api/engine-content.ts `engineContent`) */
  load: (path: string) => Promise<Record<string, unknown>>;
  log?: (message: string) => void;
}

export interface TextureScripts {
  /** the texture of a script path: one per path (every row that names it shares it); rejects when the script fails */
  texture(path: string): Promise<DataTexture>;
  /** script paths run so far */
  readonly paths: readonly string[];
  dispose(): void;
}

/** The runner over a module loader: each script runs once, its texture is shared by every row that names it. */
export function createTextureScripts(opts: TextureScriptsOptions): TextureScripts {
  const log = opts.log ?? ((m: string): void => console.warn(m));
  const made = new Map<string, Promise<DataTexture>>();
  const done: DataTexture[] = [];
  let disposed = false;
  return {
    texture(path) {
      const key = path.replace(/^\/+/, '');
      let hit = made.get(key);
      if (hit === undefined) {
        hit = opts.load(key).then((mod) => {
          const texture = textureFromImage(runTextureScript(mod as TextureScriptModule, key, log), key);
          if (disposed) texture.dispose();
          else done.push(texture);
          return texture;
        });
        made.set(key, hit);
      }
      return hit;
    },
    get paths() {
      return [...made.keys()];
    },
    dispose() {
      disposed = true;
      for (const t of done.splice(0)) t.dispose();
      made.clear();
    },
  };
}
