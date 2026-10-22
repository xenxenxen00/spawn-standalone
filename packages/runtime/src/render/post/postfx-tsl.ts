// The TSL look vocabulary behind `builtin/postfx` (docs/design/rendering.md §10.4, §10.5, Appendix B.4; engine-threejs.md §7.3;
// WP R5b). A place's look script (`scripts/looks/*.js`) runs as written: it imports `grade`, `vignette`, `grain`, `tint` from
// `builtin/postfx`, calls them on `ctx.scene` (a TSL vec4 node) with options that mix numbers, arrays, colour strings and
// `ctx.param` uniforms, and returns the node the pipeline draws (look-runner.ts, render-pipeline.ts).
//
//   grade      exposure → white balance → lift/gain → gamma → contrast (pivot: the env's live calibrationPivot
//              uniform, from `calibration.grade.contrastPivot`) → saturation → haze; an absent or undefined
//              field is neutral and generates no node ("Color adjustments are neutral when omitted", api-reference.md:1671)
//   vignette   `screenUV`; defaults roundness 2, feather 0.45, black
//   grain      one PCG hash per pixel and frame, added to every channel
//   tint       `mix(c, c · tintColor, amount)` (imported by kf2-mix, never called)
//   bloom(c)   returns `c` unchanged: the engine's bloom runs before the look (render §10.3)
//   film, scanlines, dotScreen, chromaticAberration, dof, pixelate, blur   no live use: they throw, naming the effect
//
// No tone mapping here: the pipeline places `renderOutput` before the look (`tonemapOrder = 'aces-look'`, the default: the look
// grades the display frame) or after it (`'look-aces'`). The formulas are the same in either domain; what changes is the domain
// of the look's colour constants, which the environment carries: a colour string is linear under `'look-aces'` and sRGB-encoded
// under `'aces-look'`, arrays pass as given, and the default haze colour is the fog colour in that domain (render §10.1).
//
// The environment (`PostfxEnv`) is what a look cannot pass itself: the scene's view depth for the haze, the fog uniforms, the
// grain's frame seed, the domain. The pipeline makes one and runs the look inside `withPostfxEnv`. Every call is also logged
// there with its options as passed; `lookOpsOf` resolves that log to the op list of the M0 recorder (look-recorder.ts, the test
// oracle), and the low-tier LUT bake reads the first grade's per-colour options from it (render §10.6).
//
// The CPU reference of this math is post-ref.ts, written separately; the R5b read-back tests hold the two equal.
import { float, frameId, hash, luminance, max, mix, pow, screenCoordinate, screenUV, smoothstep, uint, uniform, vec3, vec4 } from 'three/tsl';
import { Vector3 } from 'three/webgpu';
import type { Node, UniformNode } from 'three/webgpu';
import type { GradeOp, LookOp } from './look-recorder.ts';
import { GRAIN_FRAME_PRIME, GRAIN_ROW_PRIME, VIGNETTE_SCALE, srgbOETF, type GradeCoreOptions, type Linear3 } from './post-ref.ts';
import { calibration } from '../calibration.ts';

export type { Linear3 } from './post-ref.ts';

/** a look's scalar: a number, a `ctx.param` uniform or any float node */
export type NumLike = number | Node;
/** a look's colour or per-channel value: a number, `[r, g, b]`, `"oklch(L C H)"` / `"#rrggbb"`, or a vec3 node */
export type Vec3Like = number | readonly number[] | string | Node;

export interface TslGradeOptions {
  exposure?: NumLike | undefined;
  saturation?: NumLike | undefined;
  contrast?: NumLike | undefined;
  /** accepted, neutral: it has no live caller and render §10.5 gives it no formula */
  brightness?: NumLike | undefined;
  lift?: Vec3Like | undefined;
  gamma?: NumLike | undefined;
  gain?: Vec3Like | undefined;
  temperature?: NumLike | undefined;
  tint?: NumLike | undefined;
  haze?: NumLike | undefined;
  hazeColor?: Vec3Like | undefined;
}

export interface TslVignetteOptions {
  color?: Vec3Like | undefined;
  roundness?: NumLike | undefined;
  feather?: NumLike | undefined;
}

/** the domain of the frame the look grades (render §10.1): `'display'` under `tonemapOrder = 'aces-look'`, else `'linear'` */
export type LookDomain = 'display' | 'linear';

export class PostfxError extends Error {
  override name = 'PostfxError';
}

/** engine/api-reference.md:1671 (the same values as look-recorder.ts `VIGNETTE_DEFAULTS`) */
export const POSTFX_VIGNETTE_DEFAULTS = Object.freeze({ roundness: 2, feather: 0.45, color: Object.freeze([0, 0, 0]) as readonly number[] });

// ── the call log ──────────────────────────────────────────────────────────────────────────────────────────────────

interface CallBase {
  /** the colour node the call took */
  input: Node;
  /** the node it returned */
  output: Node;
}
export interface GradeCall extends CallBase {
  fn: 'grade';
  /** the options as passed, `undefined` fields dropped */
  options: TslGradeOptions;
}
export interface VignetteCall extends CallBase {
  fn: 'vignette';
  intensity: NumLike;
  options: TslVignetteOptions;
}
export interface GrainCall extends CallBase {
  fn: 'grain';
  intensity: NumLike;
}
export interface TintCall extends CallBase {
  fn: 'tint';
  color: Vec3Like;
  amount: NumLike;
}
export type PostfxCall = GradeCall | VignetteCall | GrainCall | TintCall;

/**
 * LUT folding (render §10.6). On the low-tier path the look's `ctx.scene` is the LUT lookup; the first postfx call of the look,
 * if it is a `grade` of that node whose per-colour options resolve to numbers, leaves them to the LUT (`core` is that call) and
 * emits only its haze. `conflict` is set when the look hands the LUT scene to another postfx call after that: the LUT already
 * holds the grade there, so the pipeline rebuilds without folding.
 */
export interface LutFold {
  scene: Node;
  core: GradeCall | null;
  conflict: boolean;
}

// ── the environment ───────────────────────────────────────────────────────────────────────────────────────────────

export interface PostfxEnv {
  readonly domain: LookDomain;
  /** the scene pass's view-space z (`scenePass.getViewZNode()`); the haze squares it, so its sign does not matter */
  viewZ: Node;
  /** the grain's frame seed; three's `frameId` unless a test fixes it */
  grainFrame: Node;
  /** `FogExp2` density of the place's atmosphere (0 until the atmosphere writes it) */
  readonly fogDensity: UniformNode<'float', number>;
  /** the fog colour in the look's domain: the default haze colour */
  readonly fogColor: UniformNode<'vec3', Vector3>;
  /** the live calibration pivot for contrast: `calibration.grade.contrastPivot` as a uniform (no rebuild) */
  readonly calibrationPivot: UniformNode<'float', number>;
  /** a uniform write (no rebuild): `linear` is the fog colour as the scene uses it */
  setFog(density: number, linear: readonly number[]): void;
  /** re-encodes the fog colour for the new domain; colour strings already in a built graph need a rebuild */
  setDomain(domain: LookDomain): void;
  /** writes `calibration.grade.contrastPivot` into `calibrationPivot` (no rebuild): the `?calibrate=1` panel calls this after editing the pivot */
  syncCalibrationPivot(): void;
  /** every postfx call since `reset()`, in call order */
  readonly calls: PostfxCall[];
  fold: LutFold | null;
  /** before a look runs: empties the call log and drops the fold */
  reset(): void;
}

export interface PostfxEnvInit {
  domain?: LookDomain;
  viewZ?: Node;
  grainFrame?: Node;
}

/**
 * A pipeline env registered for the `?calibrate=1` live sync (render §17), with a hook that rebakes
 * derived artifacts (the low-tier LUT) after the uniform write. Registration is explicit and lifecycle-safe:
 * the runtime pipeline registers at creation and unregisters from `dispose()`; the module-level `defaultEnv`
 * and hand-built test/tool envs are never registered, so disposed or replaced pipelines stop receiving syncs.
 */
interface CalibrationSyncTarget {
  env: PostfxEnv;
  onSync: (() => void) | undefined;
}

const syncTargets = new Set<CalibrationSyncTarget>();

/**
 * Registers `env` for panel-driven calibration sync. Returns the unregister function, which the pipeline
 * calls from its `dispose()` (a disposed pipeline's env is never synced again, and a device-loss replacement
 * registers fresh, so the set only ever holds live pipelines).
 */
export function trackCalibrationEnv(env: PostfxEnv, onSync?: () => void): () => void {
  const target: CalibrationSyncTarget = { env, onSync };
  syncTargets.add(target);
  return () => {
    syncTargets.delete(target);
  };
}

/**
 * The `?calibrate=1` panel's live-calibration report (render §17): a `grade.contrastPivot` edit syncs every
 * registered pipeline env's `calibrationPivot` uniform (no rebuild) and rebakes a folded low-tier LUT.
 * `src/render/index.ts` installs this as the panel's `onLiveChange`; it is exported so the unit test drives
 * the real callback rather than a double.
 */
export function syncPanelLiveCalibration(paths: string[]): void {
  if (!paths.includes('grade.contrastPivot')) return;
  for (const target of syncTargets) {
    target.env.syncCalibrationPivot();
    target.onSync?.();
  }
}

export function createPostfxEnv(init: PostfxEnvInit = {}): PostfxEnv {
  let domain: LookDomain = init.domain ?? 'display';
  const fogLinear: Linear3 = [0, 0, 0];
  const fogDensity = uniform(0).setName('ssFogDensity');
  const fogColor = uniform(new Vector3(0, 0, 0)).setName('ssHazeFogColor');
  // Live uniform for the calibration pivot: grade() divides by this instead of a build-time float(), so a panel
  // edit of calibration.grade.contrastPivot takes effect through syncCalibrationPivot() without a rebuild.
  const calibrationPivot = uniform(calibration.grade.contrastPivot).setName('ssCalibrationPivot');
  const calls: PostfxCall[] = [];
  const writeFog = (): void => {
    const c = domain === 'display' ? srgbOETF(fogLinear) : fogLinear;
    fogColor.value.set(c[0], c[1], c[2]);
  };
  const env: PostfxEnv = {
    get domain(): LookDomain {
      return domain;
    },
    viewZ: init.viewZ ?? float(0),
    grainFrame: init.grainFrame ?? frameId,
    fogDensity,
    fogColor,
    calibrationPivot,
    setFog(density, linear) {
      if (typeof density !== 'number' || !Number.isFinite(density) || density < 0) throw new PostfxError(`postfx: fog density must be a number ≥ 0, got ${String(density)}`);
      const c = triple('setFog', 'the fog colour', linear);
      fogDensity.value = density;
      fogLinear[0] = c[0];
      fogLinear[1] = c[1];
      fogLinear[2] = c[2];
      writeFog();
    },
    setDomain(next) {
      if (next !== 'display' && next !== 'linear') throw new PostfxError(`postfx: unknown look domain ${JSON.stringify(next)}`);
      domain = next;
      writeFog();
    },
    syncCalibrationPivot() {
      const p = calibration.grade.contrastPivot;
      if (!(Number.isFinite(p) && p > 0)) throw new PostfxError(`postfx: calibration.grade.contrastPivot must be a positive finite number, got ${p}`);
      calibrationPivot.value = p;
    },
    calls,
    fold: null,
    reset() {
      calls.length = 0;
      env.fold = null;
    },
  };
  return env;
}

/** the environment of a postfx call made outside any `withPostfxEnv` (a look built by hand in a tool or a test) */
const defaultEnv = createPostfxEnv();
let activeEnv: PostfxEnv = defaultEnv;

/** Runs `fn` with `env` as the environment of every `builtin/postfx` call inside it (a look's `look(ctx)`). */
export function withPostfxEnv<T>(env: PostfxEnv, fn: () => T): T {
  const previous = activeEnv;
  activeEnv = env;
  try {
    return fn();
  } finally {
    activeEnv = previous;
  }
}

// ── values ────────────────────────────────────────────────────────────────────────────────────────────────────────

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && (v as { isNode?: unknown }).isNode === true;
const isUniform = (v: unknown): v is UniformNode<string, unknown> => isNode(v) && (v as { isUniformNode?: unknown }).isUniformNode === true;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const show = (v: unknown): string => (isNode(v) ? 'a node' : (JSON.stringify(v) ?? String(v)));

function triple(fn: string, what: string, v: unknown): Linear3 {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(finite)) throw new PostfxError(`builtin/postfx.${fn}: ${what} must be [r, g, b], got ${show(v)}`);
  return [v[0] as number, v[1] as number, v[2] as number];
}

/**
 * OKLCH → linear sRGB with the matrices of authored content (negative channels clamped to 0), and `#rrggbb` through
 * the sRGB EOTF (`poly.js:189-192`): the law of render §5. `color/color.ts` (`cssToLinear`, WP R1a) is the render lane's
 * converter; this copy keeps the look vocabulary free of that package, as the recorder's copy does, and the look tests hold
 * the two copies equal on every live colour string. Null for anything else.
 */
export function lookColorToLinear(s: string): Linear3 | null {
  const o = /^\s*oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.]+%?\s*)?\)\s*$/i.exec(s);
  if (o) {
    const L = parseFloat(o[1]!) / (o[2] ? 100 : 1);
    const C = parseFloat(o[3]!);
    const h = (parseFloat(o[4]!) * Math.PI) / 180;
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const t = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      Math.max(0, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * t),
      Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * t),
      Math.max(0, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * t),
    ];
  }
  const x = /^\s*#([0-9a-f]{6})\s*$/i.exec(s);
  if (x) {
    const ch = (i: number): number => {
      const v = parseInt(x[1]!.slice(i, i + 2), 16) / 255;
      return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
    };
    return [ch(0), ch(2), ch(4)];
  }
  return null;
}

function parseColor(fn: string, what: string, s: string): Linear3 {
  const c = lookColorToLinear(s);
  if (c === null) throw new PostfxError(`builtin/postfx.${fn}: ${what} ${JSON.stringify(s)} is not an oklch() or #rrggbb colour`);
  return c;
}

/**
 * A look's constant as the shader takes it in `domain` (render §10.1, §10.4): a colour string is converted to linear and, under
 * `'display'`, encoded with the sRGB OETF; an array is used as given in either domain; a number fills the three channels.
 */
export function lookColorConstant(v: number | readonly number[] | string, domain: LookDomain, fn = 'look', what = 'colour'): Linear3 {
  if (typeof v === 'string') {
    const lin = parseColor(fn, what, v);
    return domain === 'display' ? srgbOETF(lin) : lin;
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new PostfxError(`builtin/postfx.${fn}: ${what} must be finite, got ${String(v)}`);
    return [v, v, v];
  }
  return triple(fn, what, v);
}

/** number | node → float node */
function n(fn: string, what: string, v: unknown): Node<'float'> {
  if (isNode(v)) return v as Node<'float'>;
  if (finite(v)) return float(v);
  throw new PostfxError(`builtin/postfx.${fn}: ${what} must be a finite number or a node, got ${show(v)}`);
}

/** number | [r, g, b] | colour string | node → vec3 node, constants in the environment's domain */
function v3(fn: string, what: string, v: unknown, env: PostfxEnv): Node<'vec3'> {
  if (isNode(v)) return v as Node<'vec3'>;
  if (typeof v === 'number' || typeof v === 'string' || Array.isArray(v)) {
    const c = lookColorConstant(v as number | string | number[], env.domain, fn, what);
    return vec3(c[0], c[1], c[2]);
  }
  throw new PostfxError(`builtin/postfx.${fn}: ${what} must be a number, [r, g, b], a colour string or a node, got ${show(v)}`);
}

function colorIn(fn: string, color: unknown): Node<'vec4'> {
  if (!isNode(color)) {
    throw new PostfxError(`builtin/postfx.${fn}: the colour must be ctx.scene or a node made from it, got ${show(color)}`);
  }
  return color as Node<'vec4'>;
}

function optionsOf(fn: string, v: unknown, keys: ReadonlySet<string>): Record<string, unknown> {
  if (v === undefined) return {};
  if (typeof v !== 'object' || v === null || Array.isArray(v) || isNode(v)) throw new PostfxError(`builtin/postfx.${fn}: options must be an object, got ${show(v)}`);
  const out: Record<string, unknown> = {};
  for (const [k, value] of Object.entries(v)) {
    if (!keys.has(k)) throw new PostfxError(`builtin/postfx.${fn}: unknown option '${k}'`);
    if (value !== undefined) out[k] = value; // undefined = omitted = neutral
  }
  return out;
}

/** the LUT scene handed to a postfx call after its grade was folded into the LUT */
function noteFoldUse(env: PostfxEnv, color: Node): void {
  const fold = env.fold;
  if (fold !== null && color === fold.scene && fold.core !== null) fold.conflict = true;
}

// ── resolving the log to numbers ──────────────────────────────────────────────────────────────────────────────────

function num(where: string, v: unknown): number {
  if (finite(v)) return v;
  if (isUniform(v) && finite(v.value)) return v.value;
  throw new PostfxError(`postfx: ${where} is ${show(v)}, not a number or a float uniform, so it has no CPU value`);
}

/** a per-channel option as the recorder records it: a number, or `[r, g, b]` */
function scalarOrTriple(where: string, v: unknown): number | Linear3 {
  if (Array.isArray(v)) return triple('grade', where, v);
  return num(where, v);
}

/** a colour as the recorder records it: strings converted to linear, arrays as given */
function linearColor(fn: string, what: string, v: unknown): Linear3 {
  if (typeof v === 'string') return parseColor(fn, what, v);
  if (Array.isArray(v)) return triple(fn, what, v);
  throw new PostfxError(`postfx: ${fn}.${what} is ${show(v)}, not a colour string or [r, g, b], so it has no CPU value`);
}

const GRADE_SCALARS = ['exposure', 'saturation', 'contrast', 'brightness', 'gamma', 'temperature', 'tint', 'haze'] as const;
const GRADE_KEYS: ReadonlySet<string> = new Set([...GRADE_SCALARS, 'lift', 'gain', 'hazeColor']);
const VIGNETTE_KEYS: ReadonlySet<string> = new Set(['color', 'roundness', 'feather']);
const CORE_SCALARS = ['exposure', 'saturation', 'contrast', 'gamma', 'temperature', 'tint'] as const;

function resolveCall(call: PostfxCall): LookOp {
  switch (call.fn) {
    case 'grade': {
      const op: GradeOp = { op: 'grade' };
      const o = call.options as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        if (k === 'lift' || k === 'gain') op[k] = scalarOrTriple(`grade.${k}`, o[k]);
        else if (k === 'hazeColor') op.hazeColor = linearColor('grade', 'hazeColor', o[k]);
        else op[k as (typeof GRADE_SCALARS)[number]] = num(`grade.${k}`, o[k]);
      }
      return op;
    }
    case 'vignette': {
      const o = call.options;
      return {
        op: 'vignette',
        intensity: num('vignette.intensity', call.intensity),
        color: o.color === undefined ? ([...POSTFX_VIGNETTE_DEFAULTS.color] as Linear3) : linearColor('vignette', 'color', o.color),
        roundness: o.roundness === undefined ? POSTFX_VIGNETTE_DEFAULTS.roundness : num('vignette.roundness', o.roundness),
        feather: o.feather === undefined ? POSTFX_VIGNETTE_DEFAULTS.feather : num('vignette.feather', o.feather),
      };
    }
    case 'grain':
      return { op: 'grain', intensity: num('grain.intensity', call.intensity) };
    case 'tint':
      return { op: 'tint', color: linearColor('tint', 'color', call.color), amount: num('tint.amount', call.amount) };
  }
}

/** the calls that lead from `scene` to `result`, first to last (a call whose result the look dropped is not among them) */
export function lookChain(calls: readonly PostfxCall[], result: Node, scene: Node): PostfxCall[] {
  const chain: PostfxCall[] = [];
  let at = result;
  while (at !== scene) {
    const call = calls.find((c) => c.output === at);
    if (call === undefined) break;
    chain.unshift(call);
    at = call.input;
  }
  return chain;
}

/**
 * The look's op list in the M0 recorder's shape (look-recorder.ts `LookOp`): the calls that lead from `scene` to `result`, each
 * with its options as numbers (uniforms read at their current value, colour strings linear, vignette defaults filled). Throws
 * when an option is a node expression, which has no CPU value.
 */
export function lookOpsOf(calls: readonly PostfxCall[], result: Node, scene: Node): LookOp[] {
  return lookChain(calls, result, scene).map(resolveCall);
}

/**
 * The per-colour options of a grade call as numbers in `domain`, uniforms read now; null when one of them cannot be resolved
 * (a node expression), in which case the grade cannot be baked into a LUT.
 */
export function gradeCoreOf(call: GradeCall, domain: LookDomain): GradeCoreOptions | null {
  const o = call.options as Record<string, unknown>;
  const core: GradeCoreOptions = {};
  try {
    for (const k of CORE_SCALARS) if (o[k] !== undefined) core[k] = num(`grade.${k}`, o[k]);
    for (const k of ['lift', 'gain'] as const) {
      const v = o[k];
      if (v === undefined) continue;
      if (typeof v === 'string' || Array.isArray(v)) core[k] = lookColorConstant(v as string | number[], domain, 'grade', k);
      else core[k] = num(`grade.${k}`, v);
    }
  } catch (e) {
    if (e instanceof PostfxError) return null;
    throw e;
  }
  return core;
}

// ── builtin/postfx ────────────────────────────────────────────────────────────────────────────────────────────────

/** render §10.5: exposure → white balance → lift/gain → gamma → contrast → saturation → haze */
export function grade(color: Node, opts?: TslGradeOptions): Node {
  const env = activeEnv;
  const input = colorIn('grade', color);
  const o = optionsOf('grade', opts, GRADE_KEYS);
  const call: GradeCall = { fn: 'grade', input, output: input, options: o as TslGradeOptions };

  // validate every option before anything is emitted, so a bad one fails whether or not the core is folded
  for (const k of GRADE_SCALARS) if (o[k] !== undefined) n('grade', k, o[k]);
  for (const k of ['lift', 'gain', 'hazeColor'] as const) if (o[k] !== undefined) v3('grade', k, o[k], env);

  const fold = env.fold;
  let folded = false;
  if (fold !== null && input === fold.scene) {
    if (fold.core === null && env.calls.length === 0 && gradeCoreOf(call, env.domain) !== null) {
      fold.core = call;
      folded = true;
    } else {
      noteFoldUse(env, input);
    }
  }

  let c: Node<'vec3'> = vec3(input.rgb);
  if (!folded) {
    if (o['exposure'] !== undefined) c = c.mul(n('grade', 'exposure', o['exposure'])); // linear law
    if (o['temperature'] !== undefined || o['tint'] !== undefined) {
      const t = n('grade', 'temperature', o['temperature'] ?? 0);
      const g = n('grade', 'tint', o['tint'] ?? 0);
      c = c.mul(vec3(t.add(1), g.mul(-0.5).add(1), t.oneMinus())); // white balance
    }
    if (o['gain'] !== undefined || o['lift'] !== undefined) {
      c = max(c.mul(v3('grade', 'gain', o['gain'] ?? 1, env)).add(v3('grade', 'lift', o['lift'] ?? 0, env).mul(c.oneMinus())), 0); // lift/gain
    }
    if (o['gamma'] !== undefined) c = pow(max(c, 0), vec3(n('grade', 'gamma', o['gamma']).reciprocal())); // gamma > 1 opens the mids
    // power-law contrast around the LIVE calibration pivot (env.calibrationPivot): post-build edits of
    // calibration.grade.contrastPivot reach the graph through syncCalibrationPivot(), no rebuild (render §17)
    if (o['contrast'] !== undefined) c = pow(max(c, 0).div(env.calibrationPivot), vec3(n('grade', 'contrast', o['contrast']))).mul(env.calibrationPivot);
    if (o['saturation'] !== undefined) c = mix(vec3(luminance(c)), c, n('grade', 'saturation', o['saturation']));
  }
  if (o['haze'] !== undefined) {
    const hazeColor = o['hazeColor'] !== undefined ? v3('grade', 'hazeColor', o['hazeColor'], env) : env.fogColor;
    const fog = env.fogDensity.mul(env.viewZ as Node<'float'>).pow2().negate().exp().oneMinus(); // FogExp2
    c = mix(c, hazeColor, n('grade', 'haze', o['haze']).mul(fog));
  }
  const out = vec4(c, input.a);
  call.output = out;
  env.calls.push(call);
  return out;
}

/** `p = |uv − 0.5|·2; d = (pₓ^r + p_y^r)^(1/r) · 0.7071; mix(c, color, intensity · smoothstep(1 − feather, 1, d))` */
export function vignette(color: Node, intensity: NumLike, opts?: TslVignetteOptions): Node {
  const env = activeEnv;
  const input = colorIn('vignette', color);
  const o = optionsOf('vignette', opts, VIGNETTE_KEYS);
  noteFoldUse(env, input);
  const amount = n('vignette', 'intensity', intensity);
  const p = screenUV.sub(0.5).abs().mul(2);
  const r = n('vignette', 'roundness', o['roundness'] ?? POSTFX_VIGNETTE_DEFAULTS.roundness);
  const d = p.x.pow(r).add(p.y.pow(r)).pow(r.reciprocal()).mul(VIGNETTE_SCALE);
  const feather = n('vignette', 'feather', o['feather'] ?? POSTFX_VIGNETTE_DEFAULTS.feather);
  const vig = v3('vignette', 'color', o['color'] ?? POSTFX_VIGNETTE_DEFAULTS.color, env);
  const out = vec4(mix(input.rgb, vig, amount.mul(smoothstep(feather.oneMinus(), 1, d))), input.a);
  env.calls.push({ fn: 'vignette', input, output: out, intensity, options: o as TslVignetteOptions });
  return out;
}

/**
 * `c += (hash − 0.5) · intensity`, the same on every channel. The seed is `x + y·0x9E3779B1 + frame·0x85EBCA6B` in uint32
 * arithmetic over the integer pixel and the frame id (post-ref.ts `grainSeed`): render §10.5's `hash(screenCoordinate +
 * frameId)` names no scalar seed, and a seed of this form gives each frame its own pattern.
 */
export function grain(color: Node, intensity: NumLike): Node {
  const env = activeEnv;
  const input = colorIn('grain', color);
  noteFoldUse(env, input);
  const amount = n('grain', 'intensity', intensity);
  const seed = uint(screenCoordinate.x)
    .add(uint(screenCoordinate.y).mul(uint(GRAIN_ROW_PRIME)))
    .add(uint(env.grainFrame as Node<'uint'>).mul(uint(GRAIN_FRAME_PRIME)));
  const out = vec4(input.rgb.add(hash(seed).sub(0.5).mul(amount)), input.a);
  env.calls.push({ fn: 'grain', input, output: out, intensity });
  return out;
}

/** `tint(color, "oklch(L C H)", amount)` = `mix(c, c · tintColor, amount)` (engine/api-reference.md:1676) */
export function tint(color: Node, col: Vec3Like, amount: NumLike): Node {
  const env = activeEnv;
  const input = colorIn('tint', color);
  noteFoldUse(env, input);
  const t = v3('tint', 'color', col, env);
  const out = vec4(mix(input.rgb, input.rgb.mul(t), n('tint', 'amount', amount)), input.a);
  env.calls.push({ fn: 'tint', input, output: out, color: col, amount });
  return out;
}

/**
 * "bloom returns the existing color; configure bloom with the look's bloomStrength, bloomRadius, and bloomThreshold parameters"
 * (engine/api-reference.md:1671): the engine's bloom runs before the look (render §10.3), so this returns `c` unchanged.
 */
export function bloom<T>(c: T, ..._ignored: unknown[]): T {
  return c;
}

function noLiveUse(name: string): (...args: unknown[]) => never {
  const f = (): never => {
    throw new PostfxError(`builtin/postfx.${name}: has no live use (spawn-engine-contract.md §20) and no port; a look may call grade, vignette, grain, tint and bloom`);
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
