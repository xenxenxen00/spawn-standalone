// Albedo tints (opt-in, `PackOptions.albedoTints`): the mean linear rgb of an albedo texture a generator names with
// `ctx.albedo(name)`. The packed maps carry the texture names but nothing samples them, so a part on a dark texture drew in
// its bare colour (Crown & Clash: the slate marble squares came out as light as the ivory ones). Multiplying the part's colour
// by the texture mean puts the average back; the texture's detail is still missing.
import { albedoTintKey } from './pack.ts';

export type AlbedoTint = readonly [number, number, number];

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** The mean linear rgb of 8-bit sRGB pixels (`channels` per pixel, rgb first), averaged in linear light. */
export function meanLinearRgb(pixels: ArrayLike<number>, channels = 4): AlbedoTint {
  const n = Math.floor(pixels.length / channels);
  if (n === 0) return [1, 1, 1];
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    r += srgbToLinear((pixels[o] ?? 0) / 255);
    g += srgbToLinear((pixels[o + 1] ?? 0) / 255);
    b += srgbToLinear((pixels[o + 2] ?? 0) / 255);
  }
  const q = (v: number): number => Math.round((v / n) * 1e4) / 1e4;
  return [q(r), q(g), q(b)];
}

/** Decodes an image to 8-bit RGBA pixels (any size: a small one is enough for a mean). */
export type PixelDecoder = (url: string) => Promise<ArrayLike<number>>;

/** the browser decoder: fetch, `createImageBitmap` scaled to 64 x 64, read back through an `OffscreenCanvas` */
export const browserPixelDecoder: PixelDecoder = async (url) => {
  const blob = await (await fetch(url)).blob();
  const g = globalThis as unknown as {
    createImageBitmap(b: Blob, o: { resizeWidth: number; resizeHeight: number; resizeQuality: string }): Promise<unknown>;
    OffscreenCanvas: new (w: number, h: number) => { getContext(k: '2d'): { drawImage(i: unknown, x: number, y: number): void; getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } };
  };
  const bitmap = await g.createImageBitmap(blob, { resizeWidth: 64, resizeHeight: 64, resizeQuality: 'medium' });
  const ctx = new g.OffscreenCanvas(64, 64).getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, 64, 64).data;
};

/**
 * The tint table of `names` (texture names as generators pass them to `ctx.albedo`), each resolved to a URL by `resolveUrl`.
 * A name that does not resolve or fails to decode is left out (its parts keep the bare colour). Keys are `albedoTintKey(name)`.
 */
export async function measureAlbedoTints(
  names: readonly string[],
  resolveUrl: (name: string) => string | null | undefined,
  decode: PixelDecoder = browserPixelDecoder,
): Promise<Record<string, AlbedoTint>> {
  const out: Record<string, AlbedoTint> = {};
  await Promise.all(names.map(async (name) => {
    const url = resolveUrl(name);
    if (!url) return;
    try {
      out[albedoTintKey(name)] = meanLinearRgb(await decode(url));
    } catch {
      // left out: the bare colour
    }
  }));
  return out;
}
