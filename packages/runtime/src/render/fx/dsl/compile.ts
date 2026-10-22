// fx program compiler (render §13.2, WP R9): program text + params + tier → CompiledProgram, the input of the CPU simulator
// (fx/sim, WP R10). Pure and engine-free.
//
// What compiling does:
//   - resolves `%param|default` from the emit's params (a NaN in a number slot is refused, `sk/fx:9`), `?low:A|B` and
//     `?mobile:A|B` from the viewer's tier and device (render-only branches, `sk/fx:32`), and folds constant arithmetic;
//   - checks every name against the live vocabulary (attribute keys, builtins, methods, fields, shapes, sinks, textures,
//     blends, `$attr`, `#pop`, `@parent`): an unknown token throws in dev builds (`strict`) with the program and its column,
//     and in production is logged once and skipped (the attribute that holds it falls back to its default; an unknown `acc`
//     term is dropped alone);
//   - lays the populations out for the simulator: emission (burst / rate / held / child), birth shape or parent, the
//     per-particle rolls (`a..b`, one slot each in source order), the acceleration terms, the keyframe envelopes with resolved
//     times, and the sink.
//
// Semantics left to the simulator are kept as expression nodes (`call` of a builtin such as `cone`, `curl`, `flick`, `fire`,
// `oklch`), so this module decides no waveform or colour space. [I] choices made here, each marked below: keyframe time
// resolution, `~` binding, the `floor=bounce` default restitution, the default size.
import { excerpt, FxSyntaxError } from './lexer.ts';
import { parseProgram, type AttrAst, type BinOp, type ExprAst, type PopAst, type ProgramAst, type ValueAst } from './parser.ts';

// -------------------------------------------------------------------------------------------------------------------- vocabulary

/** builtins callable in expressions (`sk/fx:38` plus `oklch` colours); shapes and sinks are separate */
export const FX_BUILTINS = [
  'cone', 'sdir', 'blast', 'ci', 'up', 'grav', 'buoy', 'drag', 'radial', 'attract', 'vortex', 'force', 'hdr', 'spin', 'curl',
  'noise', 'flick', 'fire', 'env', 'time', 'floorh', 'wind', 'oklch',
] as const;
export type FxBuiltin = (typeof FX_BUILTINS)[number];
/** builtins that are acceleration fields: valid as `acc=` terms */
export const FX_FIELDS = ['grav', 'drag', 'buoy', 'curl', 'wind', 'attract', 'vortex', 'radial', 'force'] as const;
export type FxField = (typeof FX_FIELDS)[number];
/** `.fn` methods on any expression (`sk/fx:37`); `.c(h)` belongs to shapes */
export const FX_METHODS = [
  'sin', 'cos', 'abs', 'floor', 'fract', 'sqrt', 'neg', 'norm', 'len', 'min', 'max', 'mix', 'cross', 'dot', 'step', 'smooth', 'mod',
  'pow', 'atan2', 'yaw',
] as const;
export type FxMethod = (typeof FX_METHODS)[number];
/** built-in sprite shapes, white, tinted by `col` (`sk/fx:27`) */
export const FX_TEXTURES = [
  'soft-disc', 'smoke-puff', 'ember', 'mote', 'flame-wisp', 'leaf', 'droplet', 'snowflake', 'petal', 'stalk', 'chip', 'grain',
  'splinter', 'shard',
] as const;
export type FxTexture = (typeof FX_TEXTURES)[number];
/** live: add, alpha, distort; multiply/subtract/screen are documented but unused (the renderer logs them) */
export const FX_BLENDS = ['add', 'alpha', 'distort', 'multiply', 'subtract', 'screen'] as const;
export type FxBlend = (typeof FX_BLENDS)[number];
/** per-particle attributes every population has; custom keys (`tint=`, `spin=`, `glo=` …) add their own */
export const FX_ATTRS = ['size', 'age', 'life', 'v', 'rand'] as const;
const POP_KEYS = new Set(['burst', 'rate', 'n', 'life', 'on', 'at', 'v', 'acc', 'size', 'sz', 'col', 'a', 'rot', 'inh', 'wrap', 'floor', 'win', 'r', 'pos', 'delay']);
const SHAPES = new Set(['disc', 'sphere', 'box', 'point', 'line', 'arc', 'path']);
const QUERY_FLAGS = new Set(['low', 'mobile']);
const MAX_POPS = 8; // api:1566

/** [I] restitution of a bare `floor=bounce` (live explicit values: .2, .3, .32; brass rule vy × −0.32, system-weapons.md §9) */
export const FLOOR_BOUNCE_DEFAULT = 0.3;
/** [I] base size of a population without `size=` (light-only and mesh pops always state theirs in the live programs) */
export const DEFAULT_SIZE = 1;

const has = <T extends string>(list: readonly T[], s: string): s is T => (list as readonly string[]).includes(s);

// -------------------------------------------------------------------------------------------------------------------- output

export type Vec3 = readonly [number, number, number];

/** a compiled expression; evaluated by the simulator per effect, per frame or per particle */
export type Expr =
  | { readonly k: 'num'; readonly v: number }
  | { readonly k: 'v3'; readonly v: Vec3 }
  | { readonly k: 'vec'; readonly x: Expr; readonly y: Expr; readonly z: Expr }
  /** `a..b`: uniform roll drawn once per particle at birth; `slot` indexes the population's roll sequence */
  | { readonly k: 'roll'; readonly lo: Expr; readonly hi: Expr; readonly slot: number }
  /** `$name`: a built-in (`FX_ATTRS`) or custom per-particle attribute */
  | { readonly k: 'attr'; readonly name: string }
  /** `#pop`: live particle count of a population (coupling reads the previous tick, `sk/fx:28`) */
  | { readonly k: 'count'; readonly pop: string }
  | { readonly k: 'bin'; readonly op: BinOp; readonly a: Expr; readonly b: Expr }
  | { readonly k: 'neg'; readonly a: Expr }
  | { readonly k: 'call'; readonly fn: FxBuiltin; readonly args: readonly Expr[] }
  | { readonly k: 'method'; readonly fn: FxMethod; readonly target: Expr; readonly args: readonly Expr[] }
  /** keyframe envelope over normalised age; times resolved, non-decreasing, first 0 */
  | { readonly k: 'keys'; readonly frames: readonly KeyFrame[] }
  /** `~`: exponential smoothing of the operand it follows [I: τ = 0.25 s, render §13.2] */
  | { readonly k: 'smooth'; readonly a: Expr };
export interface KeyFrame {
  readonly t: number;
  readonly v: Expr;
}

/** a per-effect or per-particle constant roll (counts, lifetimes, base sizes) */
export interface Roll {
  readonly lo: number;
  readonly hi: number;
}

/** one `acc=` term: the field's acceleration times `scale` */
export interface FieldTerm {
  readonly field: FxField;
  readonly args: readonly Expr[];
  readonly scale: Expr;
}

export type ShapeSpec = (
  | { readonly kind: 'point' }
  | { readonly kind: 'disc'; readonly r: number }
  | { readonly kind: 'sphere'; readonly r: number }
  | { readonly kind: 'box'; readonly half: Vec3 }
  | { readonly kind: 'line'; readonly len: number; readonly axis: Vec3 }
  /** K11: a ring (or part of one) in the XZ plane around the anchor, from angle 0 over `sweep` radians, `width` metres thick */
  | { readonly kind: 'arc'; readonly r: number; readonly sweep: number; readonly width: number }
  /**
   * `path(js{pts})`: polylines around the anchor (`[[x,y,z],…]` one line, or `[[[x,y,z],…],…]` several); a birth picks a
   * segment by length (`segments`: ax,ay,az,bx,by,bz per segment; `cumulative`: running lengths), then a point along it.
   * A zero-length segment is a point, weighted as if 1 mm long
   */
  | { readonly kind: 'path'; readonly segments: readonly number[]; readonly cumulative: readonly number[] }
) & {
  /** `.c(h)`: the shape's centre lifted h metres */
  readonly lift: number;
  /** `on=` spawn region, `at=` held position */
  readonly mode: 'on' | 'at';
};

/** `on=@parent?p`: born where a parent particle dies, with probability p (`sk/fx:23`) */
export interface ParentBirth {
  readonly kind: 'parent';
  readonly parent: string;
  readonly p: number;
  /** `inh=p;v:$v*.4`: position (always, a child is born where its parent died) and attributes evaluated on the parent */
  readonly inherit: { readonly position: boolean; readonly attrs: Readonly<Record<string, Expr>> };
}

export type Emission =
  | { readonly kind: 'burst'; readonly count: Roll }
  | { readonly kind: 'rate'; readonly perSec: Expr }
  | { readonly kind: 'held'; readonly n: Roll }
  /** a population born only from its parent's deaths */
  | { readonly kind: 'child' };

export interface SpriteSink {
  readonly kind: 'sprite';
  readonly tex: FxTexture;
  readonly blend: FxBlend;
  readonly align?: 'velocity' | 'axis';
  /** seconds of travel on `velocity`, metres on `axis` (`sk/fx:26`) */
  readonly stretch?: number;
  readonly soft?: number;
  readonly axis?: Vec3;
  readonly lit?: boolean;
}
export interface MeshSink {
  readonly kind: 'mesh';
  readonly shape: 'box';
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly align?: 'velocity';
}
export interface LightSink {
  readonly kind: 'light';
  readonly color: Expr;
  readonly intensity: Expr;
  readonly radius: Expr;
}
export type Sink = SpriteSink | MeshSink | LightSink;

export interface CompiledPop {
  readonly name: string;
  readonly index: number;
  readonly emit: Emission;
  /** `win=t0;t1`: emission only while the effect's age is inside */
  readonly window?: readonly [number, number];
  /** K11 `pos=<x,y,z>`: metres added to every birth position of the population (not to a child born at its parent's death) */
  readonly pos?: Vec3;
  /** K11 `delay=s`: seconds after the effect starts before the population emits (a burst fires then, a rate or held population starts then) */
  readonly delay?: number;
  readonly birth: ShapeSpec | ParentBirth;
  /** omitted: never expires */
  readonly life?: Roll;
  readonly size: Roll;
  /** initial velocity, rolled once at birth; null: at rest */
  readonly v: Expr | null;
  readonly acc: readonly FieldTerm[];
  /** drawn size over life (default `$size`) */
  readonly sz: Expr;
  readonly col: Expr;
  readonly a: Expr;
  readonly rot?: Expr;
  /** custom per-particle bindings (`tint`, `spin`, `glo`, `g`, `sp` …), readable as `$name` */
  readonly custom: Readonly<Record<string, Expr>>;
  readonly floor?: 'die' | 'stick' | { readonly bounce: number };
  readonly wrap?: Vec3;
  /** null: simulated, not drawn */
  readonly sink: Sink | null;
  /** number of roll slots (`a..b` in expressions) a particle of this population draws at birth */
  readonly rolls: number;
}

export interface CompiledProgram {
  readonly header: { readonly follow?: 'camera' | 'player'; /** K11: a bare `local` line was present; accepted, not acted on */ readonly local?: true };
  readonly pops: readonly CompiledPop[];
  /** what was skipped (non-strict compiles only; a strict compile throws instead) */
  readonly diagnostics: readonly FxDiagnostic[];
}

export interface FxTier {
  /** the `low`/`minimum` render tiers take the A branch of `?low:A|B` */
  readonly low: boolean;
  /** a mobile or tablet device takes the A branch of `?mobile:A|B` */
  readonly mobile: boolean;
}

export type FxDiagnosticCode = 'unknown-token' | 'syntax' | 'param' | 'semantic';
export interface FxDiagnostic {
  readonly code: FxDiagnosticCode;
  readonly message: string;
  /** 1-based */
  readonly line: number;
  /** 1-based */
  readonly col: number;
}

export class FxCompileError extends Error {
  readonly diagnostic: FxDiagnostic;
  readonly program: string;
  constructor(d: FxDiagnostic, program: string) {
    super(`fx ${d.line}:${d.col}: ${d.message}\n${excerpt(program, d.line, d.col)}`);
    this.name = 'FxCompileError';
    this.diagnostic = d;
    this.program = program;
  }
}

export interface CompileOptions {
  /** throw `FxCompileError` at the first problem (default: dev builds) instead of logging it and skipping the token */
  readonly strict?: boolean;
  /** receives each diagnostic; without it a non-strict compile logs each distinct one once with console.warn */
  readonly onDiagnostic?: (d: FxDiagnostic) => void;
  /** default true: reuse a compiled program for the same (text, params, tier, strict) */
  readonly cache?: boolean;
}

const DEV = (import.meta as unknown as { env?: { DEV?: unknown } }).env?.DEV === true;

// -------------------------------------------------------------------------------------------------------------------- caches

const PROGRAM_CACHE_MAX = 512;
const AST_CACHE_MAX = 256;
const TEMPLATE_CACHE_MAX = 256;
const programCache = new Map<string, CompiledProgram>();
/**
 * Programs whose vector params are leaves of the compiled tree (cpu-budget CPU1 1.5): a gore spray passes its own `dir`, so
 * its exact key never repeats. When every occurrence of such a param lowered to a plain `v3` node whose numbers nothing in
 * the compiler read (no folding, no range collapse, no `constVec`), the program for another valid value of that param is
 * the same tree with those nodes replaced by the new `V3`: `instantiate` rebuilds only the nodes on the paths to them and
 * shares every other node (and so its compiled evaluator). Keyed by tier, strictness, the params with each such param
 * replaced by a marker, and the text.
 */
interface ProgramTemplate {
  readonly program: CompiledProgram;
  /** the late-bound params of the compile that made it (a hit must bind the same names) */
  readonly late: ReadonlySet<string>;
  /** the param leaves, by node */
  readonly leaves: ReadonlyMap<object, string>;
  /** every object and array of `program` on a path from the root to a leaf */
  readonly dirty: ReadonlySet<object>;
}
const templateCache = new Map<string, ProgramTemplate>();
const astCache = new Map<string, { ast: ProgramAst; errors: readonly FxSyntaxError[] }>();
const logged = new Set<string>();

function remember<V>(map: Map<string, V>, key: string, value: V, max: number): V {
  if (map.size >= max) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
  return value;
}

/** forget every cached program and parse, and the once-only log memory */
export function clearFxCache(): void {
  programCache.clear();
  templateCache.clear();
  astCache.clear();
  logged.clear();
}

function parsed(text: string): { ast: ProgramAst; errors: readonly FxSyntaxError[] } {
  const hit = astCache.get(text);
  if (hit) return hit;
  const errors: FxSyntaxError[] = [];
  const ast = parseProgram(text, { onError: (e) => errors.push(e) });
  return remember(astCache, text, { ast, errors }, AST_CACHE_MAX);
}

/**
 * The `follow` target of a program's header (`fx follow=camera`), from the cached parse: what an effect's origin follows, which
 * the main thread needs at the spawn while the program itself may be compiled in the fx Worker (DR-53; DESIGN §3). The header
 * loop of `Compiler.program` without its diagnostics, so the same answer as `compileProgram(text, …).header.follow` for every
 * params and tier (the header reads neither): the last valid `follow camera|player` wins, anything else is skipped.
 */
export function fxFollowOf(text: string): 'camera' | 'player' | undefined {
  let follow: 'camera' | 'player' | undefined;
  for (const a of parsed(text).ast.header) {
    if (a.key !== 'follow') continue;
    const v = a.value;
    if (v.t === 'ident' && (v.name === 'camera' || v.name === 'player')) follow = v.name;
  }
  return follow;
}

/**
 * Compile one fx program for one viewer. Cached by (text, params, tier); the result is immutable and shared.
 * Throws `FxCompileError` in strict mode (default in dev builds) on the first syntax error, unknown token or refused param.
 */
export function compileProgram(text: string, params: Readonly<Record<string, unknown>>, tier: FxTier, opts: CompileOptions = {}): CompiledProgram {
  const strict = opts.strict ?? DEV;
  const useCache = opts.cache !== false;
  const head = `${tier.low ? 1 : 0}${tier.mobile ? 1 : 0}${strict ? 1 : 0}\u0000`;
  const key = `${head}${JSON.stringify(params)}\u0000${text}`;
  /** the params that are valid finite vectors: the candidates for late binding */
  let late: Set<string> | null = null;
  let templateKey = '';
  if (useCache) {
    const hit = programCache.get(key);
    if (hit) return hit;
    late = vectorParams(params);
    if (late !== null) {
      const marked = late;
      templateKey = `${head}${JSON.stringify(params, function (this: unknown, k, v: unknown) { return this === params && marked.has(k) ? LATE_MARK : v; })}\u0000${text}`;
      const template = templateCache.get(templateKey);
      if (template && sameNames(template.late, marked)) return remember(programCache, key, instantiate(template, params), PROGRAM_CACHE_MAX);
    }
  }
  const diagnostics: FxDiagnostic[] = [];
  const report = (d: FxDiagnostic): void => {
    diagnostics.push(d);
    if (opts.onDiagnostic) opts.onDiagnostic(d);
    if (strict) throw new FxCompileError(d, text);
    if (!opts.onDiagnostic) {
      const once = `${d.message}\u0000${text}`;
      if (!logged.has(once)) {
        logged.add(once);
        console.warn(new FxCompileError(d, text).message);
      }
    }
  };
  const { ast, errors } = parsed(text);
  for (const e of errors) report({ code: 'syntax', message: e.reason, line: e.line, col: e.col });
  const compiler = new Compiler(text, params, tier, report, late);
  const program = compiler.program(ast, diagnostics);
  if (late !== null && !compiler.tainted && diagnostics.length === 0) {
    const template = templateOf(program, compiler.leaves, late);
    if (template !== null) remember(templateCache, templateKey, template, TEMPLATE_CACHE_MAX);
  }
  return useCache ? remember(programCache, key, program, PROGRAM_CACHE_MAX) : program;
}

/** stands for a late-bound param in a template key (never a JSON value a caller can pass) */
const LATE_MARK = '\u0000late';

/** the params `Compiler.param` lowers to `V3(...asVec(raw))` whatever the slot's default: arrays or {x,y,z} of finite numbers */
function vectorParams(params: Readonly<Record<string, unknown>>): Set<string> | null {
  let out: Set<string> | null = null;
  for (const name of Object.keys(params)) {
    const raw = params[name];
    if (raw === undefined || raw === null) continue;
    const vec = asVec(raw);
    if (vec === null || !vec.every((c) => Number.isFinite(c))) continue;
    (out ??= new Set()).add(name);
  }
  return out;
}

/** the leaf param node of a valid vector value: exactly what `Compiler.param` returns for it */
const leafOf = (raw: unknown): Expr => V3(...(asVec(raw) as [number, number, number]));

const sameNames = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((n) => b.has(n));

function templateOf(program: CompiledProgram, leaves: ReadonlyMap<object, string>, late: ReadonlySet<string>): ProgramTemplate | null {
  const dirty = new Set<object>();
  let found = 0;
  const walk = (node: unknown): boolean => {
    if (node === null || typeof node !== 'object') return false;
    if (leaves.has(node)) {
      found++;
      return true;
    }
    let any = false;
    if (Array.isArray(node)) {
      for (const x of node) if (walk(x)) any = true;
    } else {
      for (const k of Object.keys(node)) if (walk((node as Record<string, unknown>)[k])) any = true;
    }
    if (any) dirty.add(node);
    return any;
  };
  walk(program);
  // a leaf reached twice would be one node shared by two places: `Compiler.param` never does that; refuse rather than guess.
  // No leaf at all: the late params are not read by the text (a spray program without `%dir`), the program is theirs for any value.
  return found === leaves.size && (leaves.size === 0 || dirty.has(program)) ? { program, late, leaves, dirty } : null;
}

/** the template's program for `params`: the dirty paths copied (same keys, same order), each leaf a fresh `V3` of its param */
function instantiate(template: ProgramTemplate, params: Readonly<Record<string, unknown>>): CompiledProgram {
  const { leaves, dirty } = template;
  const copy = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object') return node;
    const leaf = leaves.get(node);
    if (leaf !== undefined) return leafOf(params[leaf]);
    if (!dirty.has(node)) return node;
    if (Array.isArray(node)) return node.map(copy);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(node)) out[k] = copy((node as Record<string, unknown>)[k]);
    return out;
  };
  const root = template.program;
  // a template has no diagnostics; each program gets its own (empty) list, as a compile would
  if (!dirty.has(root)) return { header: root.header, pops: root.pops, diagnostics: [] };
  const program = copy(root) as { -readonly [K in keyof CompiledProgram]: CompiledProgram[K] };
  program.diagnostics = [];
  return program;
}

// -------------------------------------------------------------------------------------------------------------------- compiler

/** thrown inside the compiler to abandon the attribute being compiled; carries the diagnostic */
class Skip extends Error {
  readonly d: FxDiagnostic;
  constructor(d: FxDiagnostic) {
    super(d.message);
    this.d = d;
  }
}

type Value = { readonly k: 'num'; readonly v: number } | { readonly k: 'v3'; readonly v: Vec3 };
const isConst = (e: Expr): e is Value => e.k === 'num' || e.k === 'v3';
const n0 = (x: number): number => (x === 0 ? 0 : x); // no -0 in folded constants
const NUM = (v: number): Expr => ({ k: 'num', v: n0(v) });
const V3 = (x: number, y: number, z: number): Expr => ({ k: 'v3', v: [n0(x), n0(y), n0(z)] });
const ONE = NUM(1);

function foldBin(op: BinOp, a: Value, b: Value): Expr {
  const f = (x: number, y: number): number => (op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : x / y);
  if (a.k === 'num' && b.k === 'num') return NUM(f(a.v, b.v));
  const av: Vec3 = a.k === 'v3' ? a.v : [a.v, a.v, a.v];
  const bv: Vec3 = b.k === 'v3' ? b.v : [b.v, b.v, b.v];
  return V3(f(av[0], bv[0]), f(av[1], bv[1]), f(av[2], bv[2]));
}

interface PopScope {
  /** custom keys of this population (valid `$name`) */
  readonly custom: ReadonlySet<string>;
  slot: number;
}

class Compiler {
  private readonly text: string;
  private readonly params: Readonly<Record<string, unknown>>;
  private readonly tier: FxTier;
  private readonly report: (d: FxDiagnostic) => void;
  private readonly lineStarts: number[] = [0];
  private popNames: ReadonlySet<string> = new Set();
  private customByPop = new Map<string, ReadonlySet<string>>();
  private scope: PopScope = { custom: new Set(), slot: 0 };
  /** the params lowered as late-bound leaves (`ProgramTemplate`); null: none */
  private readonly late: ReadonlySet<string> | null;
  /** the leaf nodes made for `late` params, by node */
  readonly leaves = new Map<object, string>();
  /** true once the compiler read the numbers of a leaf (folded it, compared it, took it as a constant vector) */
  tainted = false;

  constructor(text: string, params: Readonly<Record<string, unknown>>, tier: FxTier, report: (d: FxDiagnostic) => void, late: ReadonlySet<string> | null = null) {
    this.text = text;
    this.params = params;
    this.tier = tier;
    this.report = report;
    this.late = late;
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') this.lineStarts.push(i + 1);
  }

  /** the compiler is about to read the numbers of `e`: a leaf's value then shapes the program, which is no template */
  private reads(e: Expr): void {
    if (this.leaves.has(e)) this.tainted = true;
  }

  private at(pos: number, code: FxDiagnosticCode, message: string): FxDiagnostic {
    let line = 0;
    while (line + 1 < this.lineStarts.length && (this.lineStarts[line + 1] as number) <= pos) line++;
    return { code, message, line: line + 1, col: pos - (this.lineStarts[line] as number) + 1 };
  }

  private skip(pos: number, code: FxDiagnosticCode, message: string): never {
    throw new Skip(this.at(pos, code, message));
  }

  /** run `f`; a Skip is reported and yields `fallback` */
  private guard<T>(f: () => T, fallback: T): T {
    try {
      return f();
    } catch (e) {
      if (!(e instanceof Skip)) throw e;
      this.report(e.d);
      return fallback;
    }
  }

  // ------------------------------------------------------------------ program

  program(ast: ProgramAst, diagnostics: FxDiagnostic[]): CompiledProgram {
    const header: { follow?: 'camera' | 'player'; local?: true } = {};
    if (ast.flags?.includes('local')) header.local = true;
    for (const a of ast.header) {
      this.guard(() => {
        if (a.key !== 'follow') this.skip(a.pos, 'unknown-token', `unknown header option '${a.key}'`);
        const v = a.value;
        if (v.t === 'ident' && (v.name === 'camera' || v.name === 'player')) header.follow = v.name;
        else this.skip(v.pos, 'unknown-token', `unknown follow target '${v.t === 'ident' ? v.name : printable(v)}'`);
      }, undefined);
    }
    const names = new Set<string>();
    for (const p of ast.pops) {
      if (names.has(p.name)) this.guard(() => this.skip(p.pos, 'semantic', `duplicate population '${p.name}'`), undefined);
      names.add(p.name);
    }
    if (ast.pops.length > MAX_POPS) {
      const extra = ast.pops[MAX_POPS] as PopAst;
      this.guard(() => this.skip(extra.pos, 'semantic', `${ast.pops.length} populations: an effect holds at most ${MAX_POPS} populations (api:1566)`), undefined);
    }
    this.popNames = names;
    for (const p of ast.pops) {
      this.customByPop.set(p.name, new Set(p.attrs.filter((a) => !POP_KEYS.has(a.key)).map((a) => a.key)));
    }
    const refs = new Set<string>();
    collectAttrRefs(ast, refs);
    const pops = ast.pops.slice(0, MAX_POPS).map((p, i) => this.pop(p, i, refs));
    return { header, pops, diagnostics };
  }

  private pop(p: PopAst, index: number, refs: ReadonlySet<string>): CompiledPop {
    const custom = this.customByPop.get(p.name) ?? new Set<string>();
    this.scope = { custom, slot: 0 };
    const attrs = new Map<string, AttrAst>();
    for (const a of p.attrs) {
      if (attrs.has(a.key)) this.guard(() => this.skip(a.pos, 'semantic', `duplicate attribute '${a.key}' in pop ${p.name}`), undefined);
      if (!POP_KEYS.has(a.key) && !refs.has(a.key)) {
        // a custom binding nobody reads is a misspelt key (`lfe=`): the engine has no such attribute
        this.guard(() => this.skip(a.pos, 'unknown-token', `unknown attribute '${a.key}' (not a population key, and no $${a.key} reads it)`), undefined);
        continue;
      }
      attrs.set(a.key, a);
    }
    const get = (k: string): AttrAst | undefined => attrs.get(k);

    // emission
    const emitKeys = ['burst', 'rate', 'n'].filter((k) => attrs.has(k));
    if (emitKeys.length > 1) {
      this.guard(() => this.skip((get(emitKeys[1] as string) as AttrAst).pos, 'semantic', `pop ${p.name} has more than one of burst=, rate=, n=`), undefined);
    }
    let emit: Emission | null = null;
    const burst = get('burst');
    const rate = get('rate');
    const held = get('n');
    if (burst) emit = this.guard((): Emission => ({ kind: 'burst', count: this.roll(burst.value) }), null);
    else if (rate) emit = this.guard((): Emission => ({ kind: 'rate', perSec: this.expr(rate.value) }), null);
    else if (held) emit = this.guard((): Emission => ({ kind: 'held', n: this.roll(held.value) }), null);

    // birth
    const on = get('on');
    const atA = get('at');
    let birth: ShapeSpec | ParentBirth = { kind: 'point', lift: 0, mode: 'on' };
    if (on && atA) this.guard(() => this.skip(atA.pos, 'semantic', `pop ${p.name} has both on= and at=`), undefined);
    const shapeAttr = on ?? atA;
    // K11: `at=<x,y,z>` (a vector, not a shape) is a point held at that offset from the anchor; it joins `pos=`
    let atOffset: Vec3 | null = null;
    if (atA && atA.value.t === 'vec') {
      const vec = atA.value;
      atOffset = this.guard(() => this.constVec(vec), null);
      if (atOffset !== null) birth = { kind: 'point', lift: 0, mode: 'at' };
    } else if (shapeAttr) birth = this.guard(() => this.birth(shapeAttr, on ? 'on' : 'at'), birth);
    const inh = get('inh');
    if (birth.kind === 'parent') {
      const parent = birth;
      if (inh) birth = this.guard(() => ({ ...parent, inherit: this.inherit(inh.value, parent.parent) }), parent);
      if (emit === null) emit = { kind: 'child' };
    } else if (inh) {
      this.guard(() => this.skip(inh.pos, 'semantic', `inh= needs on=@<parent> (pop ${p.name})`), undefined);
    }
    if (emit === null) {
      this.guard(() => this.skip(p.pos, 'semantic', `pop ${p.name} emits nothing (no burst=, rate=, n= or on=@parent)`), undefined);
      emit = { kind: 'burst', count: { lo: 0, hi: 0 } };
    }

    const out: {
      -readonly [K in keyof CompiledPop]: CompiledPop[K];
    } = {
      name: p.name,
      index,
      emit,
      birth,
      size: { lo: DEFAULT_SIZE, hi: DEFAULT_SIZE },
      v: null,
      acc: [],
      sz: { k: 'attr', name: 'size' },
      col: V3(1, 1, 1),
      a: ONE,
      custom: {},
      sink: null,
      rolls: 0,
    };
    const win = get('win');
    if (win) this.guard(() => void (out.window = this.numbers(win.value, 2) as unknown as readonly [number, number]), undefined);
    const posA = get('pos');
    if (posA) this.guard(() => void (out.pos = this.constVec(this.asExpr(posA.value))), undefined);
    const delayA = get('delay');
    if (delayA) {
      this.guard(() => {
        const d = this.constNum(this.asExpr(delayA.value));
        if (!(d >= 0)) this.skip(delayA.pos, 'semantic', `delay= must be zero or more seconds, found ${d}`);
        out.delay = d;
      }, undefined);
    }
    if (atOffset !== null) out.pos = out.pos === undefined ? atOffset : [out.pos[0] + atOffset[0], out.pos[1] + atOffset[1], out.pos[2] + atOffset[2]];
    const life = get('life');
    if (life) this.guard(() => void (out.life = this.roll(life.value)), undefined);
    const size = get('size');
    if (size) this.guard(() => void (out.size = this.roll(size.value)), undefined);
    const v = get('v');
    if (v) this.guard(() => void (out.v = this.expr(v.value)), undefined);
    const acc = get('acc');
    if (acc) out.acc = this.acc(acc.value);
    for (const key of ['sz', 'col', 'a'] as const) {
      const a = get(key);
      if (a) this.guard(() => void (out[key] = this.expr(a.value)), undefined);
    }
    const rot = get('rot');
    if (rot) this.guard(() => void (out.rot = this.expr(rot.value)), undefined);
    const customOut: Record<string, Expr> = {};
    for (const [key, a] of attrs) if (!POP_KEYS.has(key)) this.guard(() => void (customOut[key] = this.expr(a.value)), undefined);
    out.custom = customOut;
    const floor = get('floor');
    if (floor) this.guard(() => void (out.floor = this.floor(floor.value)), undefined);
    const wrap = get('wrap');
    if (wrap) this.guard(() => void (out.wrap = this.numbers(wrap.value, 3) as unknown as Vec3), undefined);
    const r = get('r');
    if (r) out.sink = this.guard(() => this.sink(r.value), null);
    out.rolls = this.scope.slot;
    return out;
  }

  // ------------------------------------------------------------------ attribute forms

  /** a constant roll: `a..b`, a number, or anything folding to one */
  private roll(v: ValueAst): Roll {
    const e = this.asExpr(v);
    if (e.t === 'range') return { lo: this.constNum(e.lo), hi: this.constNum(e.hi) };
    if (e.t === 'query') return this.roll(this.query(e));
    const x = this.constNum(e);
    return { lo: x, hi: x };
  }

  private constNum(e: ExprAst): number {
    const saved = this.scope.slot;
    const x = this.lower(e);
    this.scope.slot = saved;
    if (x.k !== 'num') this.skip(e.pos, 'semantic', `expected a constant number, found ${printable(e)}`);
    return x.v;
  }

  private constVec(e: ExprAst): Vec3 {
    const x = this.lower(e);
    if (x.k !== 'v3') this.skip(e.pos, 'semantic', `expected a constant vector, found ${printable(e)}`);
    this.reads(x);
    return x.v;
  }

  /** `a;b;c` lists of constant numbers (win=, wrap=) */
  private numbers(v: ValueAst, count: number): number[] {
    const items = v.t === 'list' ? v.items.map((i) => i.value) : [this.asExpr(v)];
    if (items.length !== count || (v.t === 'list' && v.items.some((i) => i.label !== null))) {
      this.skip(v.pos, 'semantic', `expected ${count} numbers separated by ';', found ${printable(v)}`);
    }
    return items.map((i) => this.constNum(i));
  }

  private expr(v: ValueAst): Expr {
    return this.lower(this.asExpr(v));
  }

  /** a value that must be a single expression (not a `;` list or a parent birth) */
  private asExpr(v: ValueAst): ExprAst {
    if (v.t === 'list' || v.t === 'parent') this.skip(v.pos, 'semantic', `expected an expression, found ${printable(v)}`);
    return v;
  }

  private birth(a: AttrAst, mode: 'on' | 'at'): ShapeSpec | ParentBirth {
    const v = a.value;
    if (v.t === 'parent') {
      if (mode === 'at') this.skip(v.pos, 'semantic', 'at= takes a shape; a parent birth is on=@<pop>');
      if (!this.popNames.has(v.pop)) this.skip(v.pos, 'unknown-token', `unknown population '@${v.pop}'`);
      const p = v.p === null ? 1 : this.constNum(v.p);
      return { kind: 'parent', parent: v.pop, p, inherit: { position: true, attrs: {} } };
    }
    let e = this.asExpr(v);
    let lift = 0;
    if (e.t === 'method' && e.name === 'c') {
      if (e.args.length !== 1) this.skip(e.pos, 'semantic', '.c(h) takes one height');
      lift = this.constNum(e.args[0] as ExprAst);
      e = e.target;
    }
    if (e.t !== 'call') this.skip(e.pos, 'unknown-token', `expected a shape (disc, sphere, box, point, line, arc), found ${printable(e)}`);
    if (!SHAPES.has(e.name)) this.skip(e.pos, 'unknown-token', `unknown shape '${e.name}'`);
    const args = e.args;
    const want = (n: number): void => {
      if (args.length !== n) this.skip(e.pos, 'semantic', `${e.name}() takes ${n} argument${n === 1 ? '' : 's'}, found ${args.length}`);
    };
    const base = { lift, mode } as const;
    switch (e.name) {
      case 'point':
        want(0);
        return { kind: 'point', ...base };
      case 'disc':
        want(1);
        return { kind: 'disc', r: this.constNum(args[0] as ExprAst), ...base };
      case 'sphere':
        want(1);
        return { kind: 'sphere', r: this.constNum(args[0] as ExprAst), ...base };
      case 'box':
        if (args.length === 1) return { kind: 'box', half: this.constVec(args[0] as ExprAst), ...base };
        want(3);
        return { kind: 'box', half: [this.constNum(args[0] as ExprAst), this.constNum(args[1] as ExprAst), this.constNum(args[2] as ExprAst)], ...base };
      case 'arc': {
        if (args.length < 1 || args.length > 3) this.skip(e.pos, 'semantic', `arc() takes a radius, a sweep in radians and a thickness, found ${args.length} arguments`);
        const r = this.constNum(args[0] as ExprAst);
        const sweep = args.length > 1 ? this.constNum(args[1] as ExprAst) : Math.PI * 2;
        const width = args.length > 2 ? this.constNum(args[2] as ExprAst) : 0;
        return { kind: 'arc', r, sweep, width, ...base };
      }
      case 'path': {
        want(1);
        const data = args[0] as ExprAst;
        if (data.t !== 'js') this.skip(data.pos, 'semantic', `path() takes a js{[[x,y,z],…]} block of points, found ${printable(data)}`);
        return { kind: 'path', ...pathSegments((at, msg) => this.skip(at, 'semantic', msg), (data as Extract<ExprAst, { t: 'js' }>).src, data.pos), ...base };
      }
      default: {
        want(4);
        const [len, ax, ay, az] = args.map((x) => this.constNum(x)) as [number, number, number, number];
        return { kind: 'line', len, axis: [ax, ay, az], ...base };
      }
    }
  }

  private inherit(v: ValueAst, parent: string): ParentBirth['inherit'] {
    const items = v.t === 'list' ? v.items : [{ label: null, value: this.asExpr(v), pos: v.pos }];
    const attrs: Record<string, Expr> = {};
    const saved = this.scope;
    for (const it of items) {
      if (it.label === null) {
        if (it.value.t === 'ident' && it.value.name === 'p') continue; // position (always inherited)
        this.skip(it.value.pos, 'unknown-token', `unknown inherit item ${printable(it.value)} (expected p or name:expr)`);
      }
      // evaluated on the dying parent: its custom keys are readable
      this.scope = { custom: this.customByPop.get(parent) ?? new Set(), slot: saved.slot };
      try {
        attrs[it.label] = this.lower(it.value);
      } finally {
        saved.slot = this.scope.slot;
        this.scope = saved;
      }
    }
    return { position: true, attrs };
  }

  private floor(v: ValueAst): NonNullable<CompiledPop['floor']> {
    const e = this.asExpr(v);
    if (e.t === 'ident' && (e.name === 'die' || e.name === 'stick')) return e.name;
    if (e.t === 'ident' && e.name === 'bounce') return { bounce: FLOOR_BOUNCE_DEFAULT };
    if (e.t === 'call' && e.name === 'bounce' && e.args.length === 1) return { bounce: this.constNum(e.args[0] as ExprAst) };
    return this.skip(e.pos, 'unknown-token', `unknown floor mode '${e.t === 'ident' || e.t === 'call' ? e.name : printable(e)}'`);
  }

  /** `acc=` as a sum of field terms; a product distributes over a parenthesised sum; an unknown term is dropped alone */
  private acc(v: ValueAst): FieldTerm[] {
    const out: FieldTerm[] = [];
    const root = this.guard(() => this.asExpr(v), null);
    if (!root) return out;
    const terms: Array<{ e: ExprAst; scale: ExprAst[]; sign: number }> = [];
    const flatten = (e: ExprAst, scale: ExprAst[], sign: number): void => {
      if (e.t === 'bin' && (e.op === '+' || e.op === '-')) {
        flatten(e.a, scale, sign);
        flatten(e.b, scale, e.op === '-' ? -sign : sign);
      } else if (e.t === 'neg') flatten(e.a, scale, -sign);
      else if (e.t === 'bin' && e.op === '*' && isSum(e.a)) flatten(e.a, [...scale, e.b], sign);
      else if (e.t === 'bin' && e.op === '*' && isSum(e.b)) flatten(e.b, [...scale, e.a], sign);
      else terms.push({ e, scale, sign });
    };
    flatten(root, [], 1);
    for (const t of terms) {
      const term = this.guard(() => this.fieldTerm(t.e, t.scale, t.sign), null);
      if (term) out.push(term);
    }
    return out;
  }

  private fieldTerm(e: ExprAst, outer: ExprAst[], sign: number): FieldTerm {
    // the product's factors: exactly one field call, the rest scalars
    const factors: ExprAst[] = [];
    const divisors: ExprAst[] = [];
    const split = (x: ExprAst): void => {
      if (x.t === 'bin' && x.op === '*') {
        split(x.a);
        split(x.b);
      } else if (x.t === 'bin' && x.op === '/') {
        split(x.a);
        divisors.push(x.b);
      } else factors.push(x);
    };
    split(e);
    for (const o of outer) split(o);
    const calls = factors.filter((f) => f.t === 'call');
    const fields = calls.filter((f) => f.t === 'call' && has(FX_FIELDS, f.name));
    if (fields.length !== 1) {
      const bad = calls.find((f) => f.t === 'call' && !has(FX_FIELDS, f.name));
      if (bad && bad.t === 'call' && !has(FX_BUILTINS, bad.name)) this.skip(bad.pos, 'unknown-token', `unknown function '${bad.name}'`);
      if (bad && bad.t === 'call') this.skip(bad.pos, 'semantic', `'${bad.name}' is not an acceleration field (acc= takes ${FX_FIELDS.join(', ')})`);
      this.skip(e.pos, 'semantic', `an acc= term needs exactly one field, found ${printable(e)}`);
    }
    const field = fields[0] as Extract<ExprAst, { t: 'call' }>;
    if (field.named.length) this.skip(field.pos, 'unknown-token', `${field.name}() takes no named arguments`);
    const args = field.args.map((a) => this.lower(a));
    let scale: Expr = sign < 0 ? NUM(-1) : ONE;
    for (const f of factors) if (f !== field) scale = this.mul('*', scale, this.lower(f));
    for (const d of divisors) scale = this.mul('/', scale, this.lower(d));
    return { field: field.name as FxField, args, scale };
  }

  private sink(v: ValueAst): Sink {
    const e = this.asExpr(v);
    if (e.t !== 'call') this.skip(e.pos, 'unknown-token', `expected a sink (sprite, mesh, light), found ${printable(e)}`);
    const word = (x: ExprAst | undefined, what: string): string => {
      if (x?.t !== 'ident') this.skip(x?.pos ?? e.pos, 'semantic', `${e.name}(): expected ${what}, found ${x ? printable(x) : 'nothing'}`);
      return x.name;
    };
    switch (e.name) {
      case 'sprite': {
        const [tex, blend, align, stretch, soft, ...rest] = e.args;
        if (rest.length) this.skip((rest[0] as ExprAst).pos, 'semantic', 'sprite() takes at most 5 positional arguments');
        const t = word(tex, 'a texture');
        const b = blend === undefined ? 'alpha' : word(blend, 'a blend');
        const out: { -readonly [K in keyof SpriteSink]: SpriteSink[K] } = { kind: 'sprite', tex: 'soft-disc', blend: 'alpha' };
        // the blend is checked first: an unknown texture alone falls back to soft-disc in lenient mode
        if (!has(FX_BLENDS, b)) this.skip((blend as ExprAst).pos, 'unknown-token', `unknown blend '${b}'`);
        out.blend = b;
        if (align !== undefined) {
          const al = word(align, 'an alignment');
          if (al !== 'velocity' && al !== 'axis') this.skip(align.pos, 'unknown-token', `unknown sprite alignment '${al}'`);
          out.align = al;
        }
        if (stretch !== undefined) out.stretch = this.constNum(stretch);
        if (soft !== undefined) out.soft = this.constNum(soft);
        for (const n of e.named) {
          if (n.name === 'axis') out.axis = this.constVec(n.value);
          else if (n.name === 'lit' && n.value.t === 'ident' && (n.value.name === 'true' || n.value.name === 'false')) out.lit = n.value.name === 'true';
          else this.skip(n.pos, 'unknown-token', `unknown sprite option '${n.name}='`);
        }
        if (has(FX_TEXTURES, t)) out.tex = t;
        else this.guard(() => this.skip((tex as ExprAst).pos, 'unknown-token', `unknown sprite texture '${t}'`), undefined);
        return out;
      }
      case 'mesh': {
        const [shape, sx, sy, sz, align, ...rest] = e.args;
        if (rest.length || e.named.length) this.skip(e.pos, 'unknown-token', 'mesh() takes (box, sx, sy, sz[, velocity])');
        const s = word(shape, 'a mesh shape');
        if (s !== 'box') this.skip((shape as ExprAst).pos, 'unknown-token', `unknown mesh shape '${s}'`);
        if (sx === undefined || sy === undefined || sz === undefined) this.skip(e.pos, 'semantic', 'mesh(box, sx, sy, sz) needs three sizes');
        const out: { -readonly [K in keyof MeshSink]: MeshSink[K] } = { kind: 'mesh', shape: 'box', sx: this.constNum(sx), sy: this.constNum(sy), sz: this.constNum(sz) };
        if (align !== undefined) {
          const al = word(align, 'an alignment');
          if (al !== 'velocity') this.skip(align.pos, 'unknown-token', `unknown mesh alignment '${al}'`);
          out.align = al;
        }
        return out;
      }
      case 'light': {
        if (e.args.length !== 3 || e.named.length) this.skip(e.pos, 'semantic', 'light() takes (color, intensity, radius)');
        const [c, i, r] = e.args as [ExprAst, ExprAst, ExprAst];
        return { kind: 'light', color: this.lower(c), intensity: this.lower(i), radius: this.lower(r) };
      }
      default:
        return this.skip(e.pos, 'unknown-token', `unknown sink '${e.name}'`);
    }
  }

  // ------------------------------------------------------------------ expressions

  private query(e: Extract<ExprAst, { t: 'query' }>): ExprAst {
    if (!QUERY_FLAGS.has(e.flag)) this.skip(e.pos, 'unknown-token', `unknown flag '?${e.flag}' (expected ?low or ?mobile)`);
    return (e.flag === 'low' ? this.tier.low : this.tier.mobile) ? e.a : e.b;
  }

  private mul(op: BinOp, a: Expr, b: Expr): Expr {
    if (isConst(a) && isConst(b)) {
      this.reads(a);
      this.reads(b);
      return foldBin(op, a, b);
    }
    if (op === '*' && a.k === 'num' && a.v === 1) return b;
    if ((op === '*' || op === '/') && b.k === 'num' && b.v === 1) return a;
    return { k: 'bin', op, a, b };
  }

  lower(e: ExprAst): Expr {
    switch (e.t) {
      case 'num':
        return NUM(e.v);
      case 'vec': {
        if (e.items.length !== 3) this.skip(e.pos, 'semantic', `a vector has 3 components, found ${e.items.length}`);
        const [x, y, z] = e.items.map((i) => this.lower(i)) as [Expr, Expr, Expr];
        if (x.k === 'num' && y.k === 'num' && z.k === 'num') return V3(x.v, y.v, z.v);
        for (const [c, src] of [[x, e.items[0]], [y, e.items[1]], [z, e.items[2]]] as const) {
          if (c.k === 'v3') this.skip((src as ExprAst).pos, 'semantic', 'a vector component must be a number');
        }
        return { k: 'vec', x, y, z };
      }
      case 'param':
        return this.param(e);
      case 'attr': {
        if (!has(FX_ATTRS, e.name) && !this.scope.custom.has(e.name)) this.skip(e.pos, 'unknown-token', `unknown attribute '$${e.name}'`);
        return { k: 'attr', name: e.name };
      }
      case 'count':
        if (!this.popNames.has(e.pop)) this.skip(e.pos, 'unknown-token', `unknown population '#${e.pop}'`);
        return { k: 'count', pop: e.pop };
      case 'ident':
        return this.skip(e.pos, 'unknown-token', `unknown word '${e.name}'`);
      case 'call': {
        if (!has(FX_BUILTINS, e.name)) this.skip(e.pos, 'unknown-token', `unknown function '${e.name}'`);
        if (e.named.length) this.skip((e.named[0] as { pos: number }).pos, 'unknown-token', `${e.name}() takes no named arguments`);
        const args = e.args.map((a) => this.lower(a));
        if (e.name === 'hdr') {
          // an HDR linear colour: a vector whose components may exceed 1 (bloom reads them)
          if (args.length !== 3) this.skip(e.pos, 'semantic', 'hdr(r,g,b) takes 3 numbers');
          const [r, g, b] = args as [Expr, Expr, Expr];
          if (r.k === 'num' && g.k === 'num' && b.k === 'num') return V3(r.v, g.v, b.v);
          return { k: 'vec', x: r, y: g, z: b };
        }
        return { k: 'call', fn: e.name, args };
      }
      case 'method': {
        if (!has(FX_METHODS, e.name)) this.skip(e.pos, 'unknown-token', `unknown method '.${e.name}'`);
        return { k: 'method', fn: e.name, target: this.lower(e.target), args: e.args.map((a) => this.lower(a)) };
      }
      case 'bin':
        return this.mul(e.op, this.lower(e.a), this.lower(e.b));
      case 'neg': {
        const a = this.lower(e.a);
        if (a.k === 'num') return NUM(-a.v);
        if (a.k === 'v3') {
          this.reads(a);
          return V3(-a.v[0], -a.v[1], -a.v[2]);
        }
        return { k: 'neg', a };
      }
      case 'range': {
        const lo = this.lower(e.lo);
        const hi = this.lower(e.hi);
        if (isConst(lo) && isConst(hi) && lo.k === hi.k) {
          this.reads(lo);
          this.reads(hi);
        }
        if (isConst(lo) && isConst(hi) && lo.k === hi.k && JSON.stringify(lo.v) === JSON.stringify(hi.v)) return lo;
        return { k: 'roll', lo, hi, slot: this.scope.slot++ };
      }
      case 'keys':
        return this.keys(e);
      case 'smooth':
        return { k: 'smooth', a: this.lower(e.a) };
      case 'query':
        return this.lower(this.query(e));
      case 'js':
        return this.skip(e.pos, 'semantic', 'a js{…} block is data for path(), not a value');
    }
  }

  /**
   * [I] keyframe times (render §13.2): the first frame is at 0; an explicit `t:` is kept; a bare last frame is at 1; bare frames
   * between two known times are spaced evenly. A time earlier than its predecessor is raised to it (the value then jumps there:
   * `.5>.9:1>.6:.4` in the muzzle flashes, `scripts/effects/programs.js`).
   */
  private keys(e: Extract<ExprAst, { t: 'keys' }>): Expr {
    const n = e.frames.length;
    const times: Array<number | null> = e.frames.map((f, i) => (i === 0 ? 0 : f.t === null ? (i === n - 1 ? 1 : null) : this.constNum(f.t)));
    for (let i = 1; i < n; i++) {
      if (times[i] !== null) continue;
      let j = i;
      while (times[j] === null) j++;
      const t0 = times[i - 1] as number;
      const t1 = times[j] as number;
      for (let k = i; k < j; k++) times[k] = t0 + ((t1 - t0) * (k - i + 1)) / (j - i + 1);
    }
    let prev = 0;
    const frames = e.frames.map((f, i) => {
      const t = Math.max(prev, times[i] as number);
      prev = t;
      return { t, v: this.lower(f.v) };
    });
    return { k: 'keys', frames };
  }

  private param(e: Extract<ExprAst, { t: 'param' }>): Expr {
    const has_ = Object.prototype.hasOwnProperty.call(this.params, e.name);
    const raw = has_ ? this.params[e.name] : undefined;
    const fallback = (why: string): Expr => {
      if (e.def === null) this.skip(e.pos, 'param', `param %${e.name} ${why} and has no default`);
      if (has_) this.report(this.at(e.pos, 'param', `param %${e.name} ${why}; using its default`));
      return typeof e.def === 'number' ? NUM(e.def) : V3(...(e.def as unknown as [number, number, number]));
    };
    if (raw === undefined || raw === null) return fallback('is not given');
    const wantsVec = Array.isArray(e.def);
    const vec = asVec(raw);
    if (vec) {
      if (e.def !== null && !wantsVec) return fallback(`is a vector where a number is expected`);
      if (vec.some((c) => !Number.isFinite(c))) return fallback('has a NaN component (refused)');
      const leaf = V3(...vec);
      if (this.late?.has(e.name) === true) this.leaves.set(leaf, e.name);
      return leaf;
    }
    const x = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
    if (!Number.isFinite(x)) return fallback('is not a number (a NaN in a number slot is refused)');
    if (wantsVec) return fallback('is a number where a vector is expected');
    return NUM(x);
  }
}

// -------------------------------------------------------------------------------------------------------------------- helpers

function asVec(raw: unknown): [number, number, number] | null {
  if (Array.isArray(raw) && raw.length === 3) return [Number(raw[0]), Number(raw[1]), Number(raw[2])];
  if (raw && typeof raw === 'object' && 'x' in raw && 'y' in raw && 'z' in raw) {
    const o = raw as { x: unknown; y: unknown; z: unknown };
    return [Number(o.x), Number(o.y), Number(o.z)];
  }
  return null;
}

function isSum(e: ExprAst): boolean {
  return (e.t === 'bin' && (e.op === '+' || e.op === '-')) || (e.t === 'neg' && isSum(e.a));
}

function printable(v: ValueAst): string {
  switch (v.t) {
    case 'num':
      return String(v.v);
    case 'ident':
    case 'call':
    case 'method':
      return `'${v.name}'`;
    case 'attr':
      return `$${v.name}`;
    case 'count':
      return `#${v.pop}`;
    case 'param':
      return `%${v.name}`;
    case 'list':
      return 'a ;-list';
    case 'parent':
      return `@${v.pop}`;
    default:
      return `a ${v.t} expression`;
  }
}

function collectAttrRefs(ast: ProgramAst, out: Set<string>): void {
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    const o = n as Record<string, unknown>;
    if (o['t'] === 'attr' && typeof o['name'] === 'string') out.add(o['name']);
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
  };
  walk(ast.pops);
}

const isPoint = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === 'number' && Number.isFinite(c));

/** `path(js{…})`'s data: JSON points, one polyline or a list of them, into segments with running lengths */
function pathSegments(skip: (pos: number, msg: string) => never, src: string, pos: number): { segments: number[]; cumulative: number[] } {
  let data: unknown;
  try {
    data = JSON.parse(src);
  } catch {
    return skip(pos, 'path() data must be a JSON array of [x,y,z] points (js{[[0,0,0],[0,1,0]]})');
  }
  const lines: unknown[] = Array.isArray(data) && data.length > 0 && isPoint(data[0]) ? [data] : Array.isArray(data) ? data : [];
  const segments: number[] = [];
  const cumulative: number[] = [];
  let total = 0;
  for (const line of lines) {
    if (!Array.isArray(line) || !line.every(isPoint)) return skip(pos, 'path() data: every polyline is a list of [x,y,z] points');
    const pts = line as [number, number, number][];
    if (pts.length === 1) pts.push(pts[0]!);
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k]!, b = pts[k + 1]!;
      segments.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      total += Math.max(1e-3, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
      cumulative.push(total);
    }
  }
  if (segments.length === 0) return skip(pos, 'path() needs at least one point');
  return { segments, cumulative };
}
