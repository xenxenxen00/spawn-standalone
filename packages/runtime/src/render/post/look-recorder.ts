// The look recording shim (render §10.4; system-rendering-look.md §2.1, §4.1, §10.2). Engine-free.
//
// A place's look script (`atmosphere.look.script`, e.g. scripts/looks/kf2-mix.js) is carried unchanged. It imports
// `grade`, `vignette`, `grain`, `tint` from `builtin/postfx`, which resolves to this module (src/compat/builtin/postfx.ts).
// `recordLook()` runs its `look(ctx)` export once: `ctx.scene` is a colour token, every postfx call appends one op to the
// recording and returns a new token, `ctx.param(name, def)` answers `placeParams[name] ?? def` and records the name. The result,
// `LookUniforms`, feeds the uber shader of the post chain (render §10.2, §10.5; WP R5b) and the low-tier LUT bake (§10.6).
//
// Only what the uber shader can express is accepted, loudly: a linear chain of at most MAX_LOOK_OPS ops starting at
// `ctx.scene`, numeric options, the effects the live tree uses. Anything else (a TSL node, a branch, `film`, a string where a
// number belongs) throws a LookRecorderError naming the problem. "Color adjustments are neutral when omitted"
// (engine/api-reference.md:1671): a recorded `grade` keeps exactly the fields the script passed; every absent field is neutral.

export type Linear3 = [number, number, number];

/** Colour value flowing through a look: `ctx.scene` and every postfx result. Opaque to the look script. */
export interface Token {
  readonly __lookToken: number;
}

/** A place's `atmosphere.look.params` value (engine/api-reference.md:556: num | bool | str; arrays for vector params). */
export type LookParamValue = number | boolean | string | readonly number[];
export type LookParams = Readonly<Record<string, LookParamValue>>;

export interface LookCtx {
  readonly scene: Token;
  /** `placeParams[name] ?? def`; records `name` */
  param(name: string, def: number | readonly number[]): LookParamValue;
}

export interface LookModule {
  look(ctx: LookCtx): Token;
}

/** Colour forms a look passes: `"oklch(L C H[ / a])"`, `"#rrggbb"`, or linear `[r, g, b]`. */
export type LookColor = string | readonly number[];

/** Options as a look script passes them; an `undefined` field counts as omitted (neutral). */
export interface GradeOptions {
  exposure?: number | undefined;
  saturation?: number | undefined;
  contrast?: number | undefined;
  brightness?: number | undefined;
  lift?: number | readonly number[] | undefined;
  gamma?: number | undefined;
  gain?: number | readonly number[] | undefined;
  temperature?: number | undefined;
  tint?: number | undefined;
  haze?: number | undefined;
  hazeColor?: LookColor | undefined;
}

export interface VignetteOptions {
  color?: LookColor | undefined;
  roundness?: number | undefined;
  feather?: number | undefined;
}

export interface GradeOp {
  op: 'grade';
  exposure?: number;
  saturation?: number;
  contrast?: number;
  brightness?: number;
  lift?: Linear3 | number;
  gamma?: number;
  gain?: Linear3 | number;
  temperature?: number;
  tint?: number;
  haze?: number;
  hazeColor?: Linear3;
}
export interface VignetteOp {
  op: 'vignette';
  intensity: number;
  color: Linear3;
  roundness: number;
  feather: number;
}
export interface GrainOp {
  op: 'grain';
  intensity: number;
}
export interface TintOp {
  op: 'tint';
  color: Linear3;
  amount: number;
}
export type LookOp = GradeOp | VignetteOp | GrainOp | TintOp;

export interface BloomParams {
  strength: number;
  radius: number;
  threshold: number;
}

export type ToneMapping = 'aces' | 'neutral';

export interface LookUniforms {
  /** ops in recorded order (all live looks: grade → vignette [→ grain]) */
  ops: LookOp[];
  bloom: BloomParams;
  toneMapping: ToneMapping;
  /** every `ctx.param` name the script read, with the value it got */
  params: Record<string, LookParamValue>;
}

/** The uber shader has this many op slots (render §10.4). */
export const MAX_LOOK_OPS = 4;

/**
 * Engine bloom when neither the place nor the script names a bloom param: `scripts/look-default.js:3-4,16-18`
 * ("the engine uses the bloom defaults below"), as assumed for Training (system-rendering-look.md §4.4).
 */
export const ENGINE_BLOOM_DEFAULTS: Readonly<BloomParams> = Object.freeze({ strength: 0.15, radius: 0.6, threshold: 1 });

/** vignette defaults (engine/api-reference.md:1671: roundness 2, feather 0.45; the colour default is black). */
export const VIGNETTE_DEFAULTS = Object.freeze({ roundness: 2, feather: 0.45, color: [0, 0, 0] as Linear3 });

export class LookRecorderError extends Error {
  override name = 'LookRecorderError';
}

// ── recordings ────────────────────────────────────────────────────────────────────────────────────────────────────

interface Recording {
  /** token chain: tokens[0] = ctx.scene, tokens[i + 1] = result of ops[i] */
  tokens: Token[];
  ops: LookOp[];
  open: boolean;
}

let nextToken = 1;
const owner = new WeakMap<Token, Recording>();

function mint(rec: Recording): Token {
  const t: Token = Object.freeze({ __lookToken: nextToken++ });
  owner.set(t, rec);
  rec.tokens.push(t);
  return t;
}

function headOf(fn: string, color: unknown): Recording {
  const rec = typeof color === 'object' && color !== null ? owner.get(color as Token) : undefined;
  if (!rec) {
    throw new LookRecorderError(
      `builtin/postfx.${fn}: the colour must be ctx.scene or the result of a previous postfx call ` +
        '(the recording shim takes only ctx.scene and the results of its own postfx calls, never a TSL node; render §10.4)',
    );
  }
  if (!rec.open) throw new LookRecorderError(`builtin/postfx.${fn}: called with a colour of a look recording that has ended`);
  if (rec.tokens[rec.tokens.length - 1] !== color) {
    throw new LookRecorderError(
      `builtin/postfx.${fn}: the look branches (this colour already has a postfx op applied); the uber shader takes one linear chain`,
    );
  }
  return rec;
}

function append(fn: string, color: unknown, op: LookOp): Token {
  const rec = headOf(fn, color);
  if (rec.ops.length >= MAX_LOOK_OPS) {
    throw new LookRecorderError(`builtin/postfx.${fn}: more than ${MAX_LOOK_OPS} look ops; the uber shader has ${MAX_LOOK_OPS} slots`);
  }
  rec.ops.push(op);
  return mint(rec);
}

// ── value checks and colours ──────────────────────────────────────────────────────────────────────────────────────

function num(fn: string, what: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new LookRecorderError(`builtin/postfx.${fn}: ${what} must be a finite number, got ${JSON.stringify(v)}`);
  }
  return v;
}

function vec3(fn: string, what: string, v: unknown): Linear3 {
  if (!Array.isArray(v) || v.length !== 3) {
    throw new LookRecorderError(`builtin/postfx.${fn}: ${what} must be [r, g, b], got ${JSON.stringify(v)}`);
  }
  return [num(fn, `${what}[0]`, v[0]), num(fn, `${what}[1]`, v[1]), num(fn, `${what}[2]`, v[2])];
}

function scalarOrVec3(fn: string, what: string, v: unknown): number | Linear3 {
  return Array.isArray(v) ? vec3(fn, what, v) : num(fn, what, v);
}

/**
 * OKLCH → linear sRGB with exactly the matrices of authored content (negatives clamped to 0), the game's own
 * converter (system-rendering-look.md §2.3). The same law as render's `color/color.ts` `cssToLinear` (WP R1a); kept local so
 * this module has no dependency on that package.
 */
function oklchToLinear(s: string): Linear3 | null {
  const m = /^\s*oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.]+%?\s*)?\)\s*$/i.exec(s);
  if (!m) return null;
  const L = parseFloat(m[1]!) / (m[2] ? 100 : 1);
  const C = parseFloat(m[3]!);
  const h = (parseFloat(m[4]!) * Math.PI) / 180;
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

/** `#rrggbb` → linear (sRGB EOTF per channel, `poly.js:189-192`). */
function hexToLinear(s: string): Linear3 | null {
  const m = /^\s*#([0-9a-f]{6})\s*$/i.exec(s);
  if (!m) return null;
  const ch = (i: number): number => {
    const v = parseInt(m[1]!.slice(i, i + 2), 16) / 255;
    return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  };
  return [ch(0), ch(2), ch(4)];
}

function color(fn: string, what: string, v: unknown): Linear3 {
  if (typeof v === 'string') {
    const c = oklchToLinear(v) ?? hexToLinear(v);
    if (!c) throw new LookRecorderError(`builtin/postfx.${fn}: ${what} ${JSON.stringify(v)} is not an oklch() or #rrggbb colour`);
    return c;
  }
  return vec3(fn, what, v); // arrays inside postfx options are linear values (spawn-engine-contract.md "Colour")
}

function options(fn: string, v: unknown): Record<string, unknown> {
  if (v === undefined) return {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new LookRecorderError(`builtin/postfx.${fn}: options must be an object, got ${JSON.stringify(v)}`);
  }
  return v as Record<string, unknown>;
}

// ── builtin/postfx ────────────────────────────────────────────────────────────────────────────────────────────────

const GRADE_SCALARS = ['exposure', 'saturation', 'contrast', 'brightness', 'gamma', 'temperature', 'tint', 'haze'] as const;
const GRADE_KEYS = new Set<string>([...GRADE_SCALARS, 'lift', 'gain', 'hazeColor']);

export function grade(c: Token, opts?: GradeOptions): Token {
  const o = options('grade', opts);
  const op: GradeOp = { op: 'grade' };
  for (const [k, v] of Object.entries(o)) {
    if (!GRADE_KEYS.has(k)) throw new LookRecorderError(`builtin/postfx.grade: unknown option '${k}'`);
    if (v === undefined) continue; // omitted = neutral
    if (k === 'lift' || k === 'gain') op[k] = scalarOrVec3('grade', k, v);
    else if (k === 'hazeColor') op.hazeColor = color('grade', k, v);
    else op[k as (typeof GRADE_SCALARS)[number]] = num('grade', k, v);
  }
  return append('grade', c, op);
}

export function vignette(c: Token, intensity: number, opts?: VignetteOptions): Token {
  const o = options('vignette', opts);
  for (const k of Object.keys(o)) {
    if (k !== 'color' && k !== 'roundness' && k !== 'feather') {
      throw new LookRecorderError(`builtin/postfx.vignette: unknown option '${k}'`);
    }
  }
  return append('vignette', c, {
    op: 'vignette',
    intensity: num('vignette', 'intensity', intensity),
    color: o['color'] === undefined ? [...VIGNETTE_DEFAULTS.color] : color('vignette', 'color', o['color']),
    roundness: o['roundness'] === undefined ? VIGNETTE_DEFAULTS.roundness : num('vignette', 'roundness', o['roundness']),
    feather: o['feather'] === undefined ? VIGNETTE_DEFAULTS.feather : num('vignette', 'feather', o['feather']),
  });
}

export function grain(c: Token, intensity: number): Token {
  return append('grain', c, { op: 'grain', intensity: num('grain', 'intensity', intensity) });
}

/** `tint(color, "oklch(L C H)", amount)` (engine/api-reference.md:1676); imported by kf2-mix but never called. */
export function tint(c: Token, col: LookColor, amount: number): Token {
  return append('tint', c, { op: 'tint', color: color('tint', 'color', col), amount: num('tint', 'amount', amount) });
}

/** Engine bloom runs before the look; `bloom()` "returns the existing color" (engine/api-reference.md:1671). */
export function bloom(c: Token): Token {
  headOf('bloom', c);
  return c;
}

function noLiveUse(name: string): (...args: unknown[]) => never {
  const f = (): never => {
    throw new LookRecorderError(
      `builtin/postfx.${name}: has no live use (spawn-engine-contract.md §20) and no port; only grade, vignette, grain, tint and bloom are recorded`,
    );
  };
  Object.defineProperty(f, 'name', { value: name });
  return f;
}

export const film = noLiveUse('film');
export const scanlines = noLiveUse('scanlines');
export const dotScreen = noLiveUse('dotScreen');
export const chromaticAberration = noLiveUse('chromaticAberration');
export const dof = noLiveUse('dof');
export const pixelate = noLiveUse('pixelate');
export const blur = noLiveUse('blur');

// ── recordLook ────────────────────────────────────────────────────────────────────────────────────────────────────

function bloomParam(name: string, place: LookParams, read: Record<string, LookParamValue>, engine: number): number {
  const v = place[name] ?? read[name] ?? engine;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new LookRecorderError(`look param ${name} must be a finite number, got ${JSON.stringify(v)}`);
  }
  return v;
}

/**
 * Runs `mod.look(ctx)` once and returns its uniforms. Re-run when the place loads or a look param is written.
 * Bloom: each param is the place's value, else the script's `ctx.param` default, else ENGINE_BLOOM_DEFAULTS
 * ("a patchAtmosphere'd look param overrides the script's default", `scripts/look-default.js:13-15`).
 */
export function recordLook(mod: LookModule, placeParams: LookParams, toneMapping: ToneMapping = 'aces'): LookUniforms {
  if (typeof (mod as Partial<LookModule> | null)?.look !== 'function') {
    throw new LookRecorderError('recordLook: the look module has no look(ctx) export');
  }
  if (toneMapping !== 'aces' && toneMapping !== 'neutral') {
    throw new LookRecorderError(`recordLook: toneMapping must be "aces" or "neutral", got ${JSON.stringify(toneMapping)}`);
  }
  const place: LookParams = placeParams;
  const rec: Recording = { tokens: [], ops: [], open: true };
  const scene = mint(rec);
  const read: Record<string, LookParamValue> = {};
  const ctx: LookCtx = Object.freeze({
    scene,
    param(name: string, def: number | readonly number[]): LookParamValue {
      const v = (Object.hasOwn(place, name) ? place[name] : undefined) ?? def;
      read[name] = v;
      return v;
    },
  });
  let out: unknown;
  try {
    out = mod.look(ctx);
  } finally {
    rec.open = false;
  }
  const at = rec.tokens.indexOf(out as Token);
  if (at < 0) {
    throw new LookRecorderError('recordLook: look(ctx) must return ctx.scene or the result of a builtin/postfx call');
  }
  return {
    ops: rec.ops.slice(0, at),
    bloom: {
      strength: bloomParam('bloomStrength', place, read, ENGINE_BLOOM_DEFAULTS.strength),
      radius: bloomParam('bloomRadius', place, read, ENGINE_BLOOM_DEFAULTS.radius),
      threshold: bloomParam('bloomThreshold', place, read, ENGINE_BLOOM_DEFAULTS.threshold),
    },
    toneMapping,
    params: read,
  };
}
