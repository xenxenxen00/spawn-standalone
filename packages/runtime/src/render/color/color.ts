// Colour pipeline (docs/design/rendering.md §5; `system-rendering-look.md` §2.3; WP R1a).
//
// Every colour the port hands three.js is linear sRGB, converted here. three's `Color.setRGB(r, g, b)` takes working-space
// (linear) values, while `setHex`, `setStyle` and CSS strings convert from sRGB: render code uses `setRGB` and `vec3` uniforms
// with the triples of this module and never gives three a hex number or a CSS string.
//
//   OKLCH    exactly the conversion of the live authored content (the game's own `oklchToLin`): the same regex
//            (a `%` lightness divides by 100, the hue is in degrees, an alpha after `/` is not part of the colour), the same
//            matrices to the digit, negative channels clamped to 0. Out-of-gamut colours therefore clip the way the game's own
//            conversions do; the engine's converter is unknown, so this is the most consistent choice.
//   #rrggbb  the sRGB EOTF per channel (`poly.js:189-192`). `#rgb`, `#rrggbbaa`, `rgb()/rgba()` and five CSS names are
//            accepted as well (UI colours; `poly.js` returns null for them, and no live generator passes one).
//   emissive `ctx.emissive(r, g, b)` carries display values, above 1 = HDR (authored content); decoded by
//            the law of [CAL `emissiveDecode`]. Cell `material.emissive` × `emissiveIntensity`, fx `<r,g,b>` and `hdr(r,g,b)`
//            and light colours are linear values and need no decode.
//
// `render/geometry/pack.ts` (R2) carries its own copy of these conversions, written before this module existed; the unit test
// holds the two equal on every live colour string.
//
// Engine-free: no `three` import, so boot code and Node tools may use it (X-26).
import { calibration, type EmissiveDecode } from '../calibration.ts';

/** linear sRGB, unclamped above 1 (HDR) */
export type Linear3 = [number, number, number];

// scripts/gen/poly.js:182
const OKLCH_RE = /oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/;

/** `poly.js` `oklchToLin`; null when the string holds no `oklch(L C H`. */
export function oklchToLinear(s: string): Linear3 | null {
  const m = OKLCH_RE.exec(s);
  if (!m) return null;
  return oklchNumbersToLinear(parseFloat(m[1]!) / (m[2] ? 100 : 1), parseFloat(m[3]!), parseFloat(m[4]!));
}

/** The conversion of `oklchToLinear` on numbers already parsed: lightness 0..1, chroma, hue in degrees. A new triple every call. */
export function oklchNumbersToLinear(L: number, C: number, hueDeg: number): Linear3 {
  const h = (hueDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const ss = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    Math.max(0, 4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * ss),
    Math.max(0, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * ss),
    Math.max(0, -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * ss),
  ];
}

/** the sRGB EOTF of `poly.js:191` (and three's `SRGBToLinear`), valid above 1 as well */
export function srgbToLinear(v: number): number {
  return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
}

/** the sRGB OETF */
export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** `poly.js` `hexToLin` for `#rrggbb` (case-insensitive); also `#rgb` and `#rrggbbaa` (the alpha is read by `cssAlpha`). */
export function hexToLinear(s: string): Linear3 | null {
  const t = s.trim();
  let hex = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(t)?.[1];
  if (hex === undefined) {
    const short = /^#([0-9a-f]{3})$/i.exec(t);
    if (!short) return null;
    hex = short[1]!.replace(/./g, (c) => c + c);
  }
  const h = hex;
  const ch = (i: number): number => srgbToLinear(parseInt(h.slice(i, i + 2), 16) / 255);
  return [ch(0), ch(2), ch(4)];
}

const RGB_RE = /^rgba?\(\s*([\d.]+)(%?)[\s,]+([\d.]+)(%?)[\s,]+([\d.]+)(%?)/i;
/** the CSS names the UI lane uses in colour slots; anything else is not a colour here */
const NAMED: Readonly<Record<string, string>> = { white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff' };

/**
 * A colour string → linear sRGB: `oklch(L C H[ / a])` and `#rrggbb` exactly as the live `poly.js`; `rgb()/rgba()` and a few CSS
 * names for UI colours. Null for anything else (including a non-string). A new triple every call.
 */
export function cssToLinear(c: string): Linear3 | null {
  if (typeof c !== 'string') return null;
  const s = c.trim();
  if (s.startsWith('oklch')) return oklchToLinear(s);
  if (s.startsWith('#')) return hexToLinear(s);
  const rgb = RGB_RE.exec(s);
  if (rgb) {
    const ch = (v: string, pct: string): number => srgbToLinear(Math.min(1, parseFloat(v) / (pct ? 100 : 255)));
    return [ch(rgb[1]!, rgb[2]!), ch(rgb[3]!, rgb[4]!), ch(rgb[5]!, rgb[6]!)];
  }
  const named = NAMED[s.toLowerCase()];
  return named === undefined ? null : hexToLinear(named);
}

/** The alpha a colour string carries (`oklch(L C H / a)`, `#rrggbbaa`, `rgba(…, a)`), clamped to 0..1; undefined when it has none. */
export function cssAlpha(c: string): number | undefined {
  if (typeof c !== 'string') return undefined;
  const s = c.trim();
  const slash = /\/\s*([\d.]+)(%?)\s*\)/.exec(s);
  if (slash) return Math.min(1, Math.max(0, parseFloat(slash[1]!) / (slash[2] ? 100 : 1)));
  const hex8 = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(s);
  if (hex8) return parseInt(hex8[1]!, 16) / 255;
  const rgba = /^rgba\(\s*[\d.]+%?[\s,]+[\d.]+%?[\s,]+[\d.]+%?[\s,]+([\d.]+)(%?)/i.exec(s);
  if (rgba) return Math.min(1, Math.max(0, parseFloat(rgba[1]!) / (rgba[2] ? 100 : 1)));
  return undefined;
}

/**
 * An emissive display value → linear, HDR above 1 [CAL `emissiveDecode`]; a negative or non-finite value is 0.
 *   'srgb-eotf'   the sRGB EOTF applied to the raw number (grows as x^2.4 above 1: a display 1.8 decodes to 3.87)
 *   'hdr-linear'  `linear(x / hdr) · hdr`: the display value is taken as a display colour ≤ 1 scaled by an HDR factor. `hdr`
 *                 is that factor when the caller knows it; by default the value itself above 1 (display white × hdr), else 1
 */
export function decodeDisplay(v: number, law: EmissiveDecode = calibration.emissiveDecode, hdr?: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (law === 'srgb-eotf') return srgbToLinear(v);
  const k = hdr !== undefined && hdr > 0 ? hdr : Math.max(1, v);
  return srgbToLinear(v / k) * k;
}

/**
 * The `ctx.emissive` forms → linear: a colour string (already a colour, no display decode), `[r, g, b]` display values, or
 * null (no emissive). Under 'hdr-linear' the HDR factor of a triple is its largest channel when that exceeds 1.
 */
export function emissiveFromArgs(a: string | number[] | null, law: EmissiveDecode = calibration.emissiveDecode): Linear3 | null {
  if (a === null || a === undefined) return null;
  if (typeof a === 'string') return cssToLinear(a);
  if (!Array.isArray(a) || a.length < 3) return null;
  const r = Number(a[0]);
  const g = Number(a[1]);
  const b = Number(a[2]);
  if (law === 'srgb-eotf') return [decodeDisplay(r, law), decodeDisplay(g, law), decodeDisplay(b, law)];
  const peak = Math.max(1, r, g, b);
  const hdr = Number.isFinite(peak) ? peak : 1;
  return [decodeDisplay(r, law, hdr), decodeDisplay(g, law, hdr), decodeDisplay(b, law, hdr)];
}

/** linear → 8-bit sRGB (round to nearest), clamped to 0..255: for UI swatches and test images, never for three */
export function linearToSrgb8(c: Linear3): [number, number, number] {
  const ch = (v: number): number => {
    if (!(v > 0)) return 0;
    return Math.round(Math.min(1, linearToSrgb(v)) * 255);
  };
  return [ch(c[0]), ch(c[1]), ch(c[2])];
}
