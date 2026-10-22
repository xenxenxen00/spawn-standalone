// The built-in fx atlas as a three texture (`atlas-default.ts` holds the pixels).
import { DataTexture, LinearFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three/webgpu';
import { generateDefaultAtlas } from './atlas-default.ts';

export function defaultAtlasTexture(): DataTexture {
  const { width, height, data } = generateDefaultAtlas();
  const t = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
  t.colorSpace = SRGBColorSpace;
  // no mipmaps: tiles would bleed into each other at distance, as they would in a packed image
  t.generateMipmaps = false;
  t.minFilter = LinearFilter;
  t.magFilter = LinearFilter;
  t.name = 'ss:fx-atlas:builtin';
  t.needsUpdate = true;
  return t;
}

/** a 1 x 1 transparent texture: the atlas slot of a lights-only fx runtime (`FxSystemOptions.lightsOnly`), never sampled */
export function placeholderAtlasTexture(): DataTexture {
  const t = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat, UnsignedByteType);
  t.name = 'ss:fx-atlas:none';
  t.needsUpdate = true;
  return t;
}
