import type { CompiledPop, CompiledProgram, Expr, ParentBirth, ShapeSpec, Vec3 } from '../dsl/compile.ts';
import { FX_TEXTURES } from '../dsl/compile.ts';
import { compileExpr, compileField, evaluate, type FxEvalContext, type FxExprFn, type FxFieldFn, type FxValue } from './expression.ts';

export const FX_MAX_PARTICLES = 30_000;
export const FX_MAX_DT = 1 / 20;
const TAU = Math.PI * 2;

export interface FxSimulationOptions {
  readonly seed?: number;
  /** hard per-effect ceiling; a shared FxSystem may lower births further each frame */
  readonly capacity?: number;
  /** typed-array allocation at construction; grows geometrically up to `capacity` */
  readonly initialCapacity?: number;
  /** initial birth allowance, used by the FxSystem to share a global particle budget */
  readonly birthBudget?: number;
  readonly heldFactor?: number;
  readonly gravity?: Vec3;
  readonly wind?: Vec3;
  readonly origin?: Vec3;
  readonly floorHeight?: (x: number, z: number) => number | null;
  /** Ranges roll inside their bounds by default (current the legacy host); explicit false preserves the legacy unit roll. */
  readonly rangeRolls?: boolean;
}

export interface FxPopulationView {
  readonly program: CompiledPop;
  readonly indices: Uint32Array;
  readonly count: number;
}

interface Population {
  readonly program: CompiledPop;
  indices: Uint32Array;
  count: number;
  accumulator: number;
  target: number;
  /** K11 `delay=`: particles a delayed burst or held population still has to emit; -1 when none are waiting */
  pending: number;
  /** the per-particle expressions of `program`, compiled once (cpu-budget X-38) */
  readonly fns: PopulationFns;
}

interface PopulationFns {
  readonly acc: readonly FxFieldFn[];
  readonly sz: FxExprFn;
  readonly col: FxExprFn;
  readonly a: FxExprFn;
  readonly rot: FxExprFn | null;
  readonly spriteAlpha: boolean;
}

/**
 * The evaluators of a population, built once per compiled population and shared by every simulation of it (cpu-budget CPU1
 * 1.5: a gore spray starts a simulation of a cached program; the closures read nothing but the context they are called with).
 */
const popFnsCache = new WeakMap<CompiledPop, PopulationFns>();
const populationFns = (p: CompiledPop): PopulationFns => {
  let fns = popFnsCache.get(p);
  if (fns === undefined) {
    fns = {
      acc: p.acc.map(compileField),
      sz: compileExpr(p.sz),
      col: compileExpr(p.col),
      a: compileExpr(p.a),
      rot: p.rot === undefined ? null : compileExpr(p.rot),
      spriteAlpha: p.sink?.kind === 'sprite' && p.sink.blend === 'alpha',
    };
    popFnsCache.set(p, fns);
  }
  return fns;
};

interface CustomField {
  values: Float32Array;
  width: 1 | 3;
}

/** an `FxEvalContext` the simulator refills in place (`#fill`) */
type ReusableContext = { -readonly [K in keyof FxEvalContext]: FxEvalContext[K] } & {
  index: number;
  pi: number;
  inherited: Readonly<Record<string, FxValue>> | undefined;
  readonly pos: [number, number, number];
  readonly vel: [number, number, number];
};

const asVec = (v: FxValue): Vec3 => (typeof v === 'number' ? [v, v, v] : v);
const asNumber = (v: FxValue, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const finiteVec = (v: Vec3): Vec3 => [Number.isFinite(v[0]) ? v[0] : 0, Number.isFinite(v[1]) ? v[1] : 0, Number.isFinite(v[2]) ? v[2] : 0];

/** A deterministic, fixed-capacity FX sim. The renderers read the active SoA slots directly. */
export class FxSimulation {
  readonly program: CompiledProgram;
  positions: Float32Array;
  velocities: Float32Array;
  ages: Float32Array;
  lives: Float32Array;
  baseSizes: Float32Array;
  sizes: Float32Array;
  rotations: Float32Array;
  rgba: Float32Array;
  textureIndices: Float32Array;
  #slots: Int32Array;
  #next: Int32Array;
  #rolls: Float32Array;
  #rand: Float32Array;
  #stuck: Uint8Array;
  #bornStep: Uint32Array;
  readonly #custom = new Map<string, CustomField>();
  readonly #smooth = new Map<number, Map<Expr, number>>();
  readonly #populations: Population[];
  readonly #views: FxPopulationView[];
  readonly #byName = new Map<string, number>();
  readonly #previousCounts: Int32Array;
  readonly #gravity: Vec3;
  readonly #wind: Vec3;
  readonly #floorHeight: (x: number, z: number) => number | null;
  readonly #heldFactor: number;
  readonly #rangeRolls: boolean;
  readonly #random: () => number;
  readonly #rollWidth: number;
  #free = 0;
  #active = 0;
  #birthRemaining = 0;
  #limit = 0;
  #time = 0;
  #stepIndex = 0;
  #origin: Vec3 = [0, 0, 0];
  #stopped = false;
  #disposed = false;

  constructor(program: CompiledProgram, options: FxSimulationOptions = {}) {
    this.program = program;
    const limit = options.capacity ?? FX_MAX_PARTICLES;
    const capacity = options.initialCapacity ?? limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > FX_MAX_PARTICLES) throw new RangeError(`FX capacity must be an integer in [1, ${FX_MAX_PARTICLES}]`);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > limit) throw new RangeError(`FX initial capacity must be an integer in [1, ${limit}]`);
    this.#heldFactor = options.heldFactor ?? 1;
    this.#rangeRolls = options.rangeRolls !== false;
    // the reusable contexts are built by field initialisers, before this body runs
    this.#main.rangeRolls = this.#birthCtx.rangeRolls = this.#rangeRolls;
    if (!Number.isFinite(this.#heldFactor) || this.#heldFactor < 0) throw new RangeError('FX held factor must be a finite non-negative number');
    this.#gravity = finiteVec(options.gravity ?? [0, -24, 0]);
    this.#wind = finiteVec(options.wind ?? [0, 0, 0]);
    this.#origin = finiteVec(options.origin ?? [0, 0, 0]);
    this.#floorHeight = options.floorHeight ?? (() => null);
    this.#random = mulberry32(Number.isFinite(options.seed) ? (options.seed as number) | 0 : 0);
    this.#capacity = capacity;
    this.#limit = limit;
    this.#birthRemaining = Math.max(0, Math.floor(options.birthBudget ?? limit));

    this.positions = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.ages = new Float32Array(capacity);
    this.lives = new Float32Array(capacity);
    this.baseSizes = new Float32Array(capacity);
    this.sizes = new Float32Array(capacity);
    this.rotations = new Float32Array(capacity);
    this.rgba = new Float32Array(capacity * 4);
    this.textureIndices = new Float32Array(capacity);
    this.#slots = new Int32Array(capacity).fill(-1);
    this.#next = new Int32Array(capacity);
    this.#rand = new Float32Array(capacity);
    this.#stuck = new Uint8Array(capacity);
    this.#bornStep = new Uint32Array(capacity);
    this.#previousCounts = new Int32Array(program.pops.length);
    this.#rollWidth = Math.max(1, ...program.pops.map((p) => p.rolls));
    this.#rolls = new Float32Array(capacity * this.#rollWidth);
    this.#free = 0;
    for (let i = 0; i < capacity; i++) this.#next[i] = i + 1 < capacity ? i + 1 : -1;

    this.#populations = program.pops.map((p, index) => {
      this.#byName.set(p.name, index);
      return { program: p, indices: new Uint32Array(capacity), count: 0, accumulator: 0, target: 0, pending: -1, fns: populationFns(p) };
    });
    this.#views = this.#populations.map((p) => {
      const view = { program: p.program, get indices(): Uint32Array { return p.indices; }, get count(): number { return p.count; } };
      return view;
    });
    for (let pi = 0; pi < program.pops.length; pi++) {
      for (const name of Object.keys(program.pops[pi]!.custom)) this.#custom.set(`${pi}:${name}`, { values: new Float32Array(capacity * 3), width: 1 });
    }

    for (const p of this.#populations) {
      // K11 `delay=`: a delayed burst or held population starts in `step` once the effect is old enough
      const delayed = (p.program.delay ?? 0) > 0;
      if (p.program.emit.kind === 'burst') {
        if (delayed) p.pending = this.#rollCount(p.program.emit.count);
        else this.#emit(p, this.#rollCount(p.program.emit.count));
      } else if (p.program.emit.kind === 'held') {
        p.target = Math.floor(this.#rollCount(p.program.emit.n) * this.#heldFactor);
        if (delayed) p.pending = p.target;
        else this.#emit(p, p.target);
      }
    }
    this.#updateAppearance();
  }

  get particleCount(): number { return this.#active; }
  get time(): number { return this.#time; }
  get populations(): readonly FxPopulationView[] { return this.#views; }
  get finished(): boolean {
    if (!this.#stopped && this.#populations.some((p) => p.program.emit.kind === 'held')) return false;
    if (this.#populations.some((p) => p.pending >= 0)) return false;
    if (!this.#stopped && this.#populations.some((p) => p.program.emit.kind === 'rate' && (p.program.window === undefined || this.#time < p.program.window[1]))) return false;
    return this.#active === 0;
  }

  population(name: string): FxPopulationView | undefined {
    const i = this.#byName.get(name);
    return i === undefined ? undefined : this.#views[i];
  }

  /** Evaluate a sink expression in the particle's live attribute context. */
  value(population: string, index: number, expr: Expr, now = this.#time): FxValue | undefined {
    const pi = this.#byName.get(population);
    if (pi === undefined || index < 0 || index >= this.#capacity || this.#slots[index]! < 0) return undefined;
    return evaluate(expr, this.#context(index, pi, now, 0));
  }

  /** Stop future rate/held emission; existing particles finish normally. */
  stop(): void { this.#stopped = true; }

  /** Update the emitter origin used by shape, field and wrap expressions. */
  setOrigin(origin: Vec3): void { this.#origin = finiteVec(origin); }

  step(dt: number, now = this.#time + dt, origin: Vec3 = this.#origin, birthBudget = this.#limit): void {
    if (this.#disposed) return;
    if (!Number.isFinite(dt) || dt < 0 || !Number.isFinite(now) || now < 0) throw new RangeError('FX step requires finite, non-negative time');
    this.#origin = finiteVec(origin);
    this.#birthRemaining = Math.max(0, Math.floor(Number.isFinite(birthBudget) ? birthBudget : this.#limit));
    this.#stepIndex++;
    const step = Math.min(dt, FX_MAX_DT);
    this.#time += step;
    if (step > 0) {
      for (let pi = 0; pi < this.#populations.length; pi++) {
        const p = this.#populations[pi]!;
        const main = this.#fillShared(this.#main, pi, now, step);
        for (let slot = 0; slot < p.count;) {
          const index = p.indices[slot]!;
          if (this.#bornStep[index] === this.#stepIndex) { slot++; continue; }
          this.ages[index] = this.ages[index]! + step;
          // the context is filled only where it is read (cpu-budget CPU1 1.1): by a dying particle's children, and by the
          // acceleration terms of a moving one. A particle stuck to the floor (`floor=stick`) has fixed position and zero
          // velocity: nothing reads its step context. `#fill` writes nothing but the `main` slot, which every later reader
          // (rate emission, `#updateAppearance`) refills first.
          if (this.lives[index]! <= 0 || this.ages[index]! >= this.lives[index]!) {
            this.#die(p, pi, index, this.#fillParticle(main, index));
            continue;
          }
          if (this.#stuck[index] === 0) {
            const ctx = this.#fillParticle(main, index);
            const acc = this.#acc;
            acc[0] = 0; acc[1] = 0; acc[2] = 0;
            const terms = p.fns.acc;
            for (let t = 0; t < terms.length; t++) terms[t]!(ctx, acc);
            const ax = acc[0], ay = acc[1], az = acc[2];
            const o = index * 3;
            this.velocities[o] = this.velocities[o]! + ax * step;
            this.velocities[o + 1] = this.velocities[o + 1]! + ay * step;
            this.velocities[o + 2] = this.velocities[o + 2]! + az * step;
            this.positions[o] = this.positions[o]! + this.velocities[o]! * step;
            this.positions[o + 1] = this.positions[o + 1]! + this.velocities[o + 1]! * step;
            this.positions[o + 2] = this.positions[o + 2]! + this.velocities[o + 2]! * step;
            this.#collideFloor(p, index);
            this.#wrap(p.program, index);
          }
          slot++;
        }
      }
    }
    // K11 `delay=`: the delayed bursts and held populations that are due
    for (const p of this.#populations) {
      if (p.pending >= 0 && this.#time >= (p.program.delay ?? 0)) {
        const n = p.pending;
        p.pending = -1;
        if (!this.#stopped || p.program.emit.kind === 'burst') this.#emit(p, n);
      }
    }
    if (!this.#stopped) {
      for (const p of this.#populations) {
        if (p.pending >= 0) continue;
        if (p.program.emit.kind === 'held') this.#emit(p, Math.max(0, p.target - p.count));
        else if (p.program.emit.kind === 'rate' && this.#time >= (p.program.delay ?? 0) && (p.program.window === undefined || (this.#time >= p.program.window[0] && this.#time <= p.program.window[1]))) {
          const ctx = this.#fill(this.#main, -1, p.program.index, now, step);
          const rate = Math.max(0, asNumber(evaluate(p.program.emit.perSec, ctx))) * this.#heldFactor;
          p.accumulator += rate * step;
          const n = Math.floor(p.accumulator);
          if (n > 0) {
            p.accumulator -= n;
            this.#emit(p, n);
          }
        }
      }
    }
    for (let i = 0; i < this.#populations.length; i++) this.#previousCounts[i] = this.#populations[i]!.count;
    this.#updateAppearance(now);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const p of this.#populations) p.count = 0;
    this.#active = 0;
    this.#smooth.clear();
  }

  #rollCount(roll: { lo: number; hi: number }): number {
    return Math.max(0, Math.floor(roll.lo + this.#random() * (roll.hi - roll.lo + 1)));
  }

  #emit(pop: Population, requested: number, position?: Vec3, inherited?: Readonly<Record<string, FxValue>>): void {
    const count = Math.min(Math.max(0, Math.floor(requested)), this.#limit - this.#active, this.#birthRemaining);
    if (count > 0) this.#ensureCapacity(this.#active + count);
    this.#birthRemaining -= count;
    for (let i = 0; i < count; i++) this.#birth(pop, position, inherited);
  }

  #capacity = 0;

  #ensureCapacity(required: number): void {
    if (required <= this.#capacity) return;
    const previous = this.#capacity;
    const next = Math.min(this.#limit, Math.max(required, previous * 2));
    const grow = <T extends Float32Array | Uint8Array | Int32Array | Uint32Array>(array: T, length: number): T => {
      const result = new (array.constructor as { new(length: number): T })(length);
      result.set(array as never);
      return result;
    };
    this.positions = grow(this.positions, next * 3);
    this.velocities = grow(this.velocities, next * 3);
    this.ages = grow(this.ages, next);
    this.lives = grow(this.lives, next);
    this.baseSizes = grow(this.baseSizes, next);
    this.sizes = grow(this.sizes, next);
    this.rotations = grow(this.rotations, next);
    this.rgba = grow(this.rgba, next * 4);
    this.textureIndices = grow(this.textureIndices, next);
    this.#slots = grow(this.#slots, next);
    this.#next = grow(this.#next, next);
    this.#rand = grow(this.#rand, next);
    this.#stuck = grow(this.#stuck, next);
    this.#bornStep = grow(this.#bornStep, next);
    this.#rolls = grow(this.#rolls, next * this.#rollWidth);
    for (const field of this.#custom.values()) field.values = this.#growField(field.values, next);
    for (const p of this.#populations) {
      const indices = new Uint32Array(next);
      indices.set(p.indices);
      p.indices = indices;
    }
    for (let i = previous; i < next; i++) this.#next[i] = i + 1 < next ? i + 1 : this.#free;
    this.#free = previous;
    this.#capacity = next;
  }

  #growField(values: Float32Array, capacity: number): Float32Array {
    const next = new Float32Array(capacity * 3);
    next.set(values);
    return next;
  }

  #birth(pop: Population, inheritedPosition?: Vec3, inherited?: Readonly<Record<string, FxValue>>): void {
    const i = this.#free;
    if (i < 0) return;
    this.#free = this.#next[i]!;
    const pi = pop.program.index;
    const rollOffset = i * this.#rollWidth;
    const rolls = this.#rolls;
    for (let k = 0; k < pop.program.rolls; k++) rolls[rollOffset + k] = this.#random();
    this.#slots[i] = pop.count;
    pop.indices[pop.count++] = i;
    this.#active++;
    const origin = inheritedPosition ?? this.#shape(pop.program.birth);
    const offset = i * 3;
    // K11 `pos=`: the population's own offset, not applied to a child born where its parent died
    const shift = inheritedPosition === undefined ? pop.program.pos : undefined;
    this.positions[offset] = origin[0] + (shift?.[0] ?? 0); this.positions[offset + 1] = origin[1] + (shift?.[1] ?? 0); this.positions[offset + 2] = origin[2] + (shift?.[2] ?? 0);
    this.velocities[offset] = 0; this.velocities[offset + 1] = 0; this.velocities[offset + 2] = 0;
    this.ages[i] = 0;
    this.lives[i] = pop.program.life === undefined ? Number.POSITIVE_INFINITY : pop.program.life.lo + this.#random() * (pop.program.life.hi - pop.program.life.lo);
    this.baseSizes[i] = pop.program.size.lo + this.#random() * (pop.program.size.hi - pop.program.size.lo);
    this.sizes[i] = this.baseSizes[i]!;
    this.rotations[i] = 0;
    this.rgba.set([1, 1, 1, 1], i * 4);
    this.#rand[i] = this.#random();
    this.#bornStep[i] = this.#stepIndex;
    this.#stuck[i] = 0;
    const ctx = this.#fill(this.#birthCtx, i, pi, 0, 0, inherited);
    const velocity = inherited?.['v'] ?? (pop.program.v === null ? [0, 0, 0] : evaluate(pop.program.v, ctx));
    const v = asVec(velocity);
    this.velocities[offset] = v[0]; this.velocities[offset + 1] = v[1]; this.velocities[offset + 2] = v[2];
    for (const [name, expr] of Object.entries(pop.program.custom)) {
      const field = this.#custom.get(`${pi}:${name}`)!;
      const value = inherited?.[name] ?? evaluate(expr, this.#fill(this.#birthCtx, i, pi, 0, 0, inherited));
      field.width = typeof value === 'number' ? 1 : 3;
      const v = asVec(value);
      const at = i * 3;
      field.values[at] = v[0]; field.values[at + 1] = v[1]; field.values[at + 2] = v[2];
    }
    if (pop.program.sink?.kind === 'sprite') this.textureIndices[i] = Math.max(0, FX_TEXTURES.indexOf(pop.program.sink.tex));
    if (pop.program.floor !== undefined) {
      const floor = this.#floorHeight(this.positions[offset]!, this.positions[offset + 2]!);
      if (floor !== null && Number.isFinite(floor)) this.positions[offset + 1] = Math.max(this.positions[offset + 1]!, floor);
    }
  }

  #shape(shape: ShapeSpec | ParentBirth): Vec3 {
    if (shape.kind === 'parent') return this.#origin;
    let x = 0, y = 0, z = 0;
    switch (shape.kind) {
      case 'point': break;
      case 'disc': {
        const r = Math.sqrt(this.#random()) * shape.r;
        const a = this.#random() * TAU;
        x = Math.cos(a) * r; z = Math.sin(a) * r;
        break;
      }
      case 'sphere': {
        const r = Math.cbrt(this.#random()) * shape.r;
        const yy = this.#random() * 2 - 1;
        const a = this.#random() * TAU;
        const q = Math.sqrt(1 - yy * yy);
        x = q * Math.cos(a) * r; y = yy * r; z = q * Math.sin(a) * r;
        break;
      }
      case 'box':
        x = (this.#random() * 2 - 1) * shape.half[0];
        y = (this.#random() * 2 - 1) * shape.half[1];
        z = (this.#random() * 2 - 1) * shape.half[2];
        break;
      case 'line': {
        const t = this.#random() - 0.5;
        x = shape.axis[0] * t * shape.len; y = shape.axis[1] * t * shape.len; z = shape.axis[2] * t * shape.len;
        break;
      }
      case 'arc': {
        const a = this.#random() * shape.sweep;
        const r = shape.r + (this.#random() - 0.5) * shape.width;
        x = Math.cos(a) * r; z = Math.sin(a) * r;
        break;
      }
      case 'path': {
        const cum = shape.cumulative;
        const pick = this.#random() * cum[cum.length - 1]!;
        let k = 0;
        while (k < cum.length - 1 && cum[k]! < pick) k++;
        const t = this.#random();
        const o = k * 6, sg = shape.segments;
        x = sg[o]! + (sg[o + 3]! - sg[o]!) * t;
        y = sg[o + 1]! + (sg[o + 4]! - sg[o + 1]!) * t;
        z = sg[o + 2]! + (sg[o + 5]! - sg[o + 2]!) * t;
      }
    }
    return [this.#origin[0] + x, this.#origin[1] + y + shape.lift, this.#origin[2] + z];
  }

  /**
   * The reusable contexts of the per-particle loops (cpu-budget X-38: one context object with five closures and two triples per
   * particle per frame was most of the fx stage's garbage). `#fill` writes exactly what `#context` would capture, so an
   * expression sees the same values; each slot is refilled only where `#context` would have built a new one, and the two
   * slots never overlap: `main` serves step/rate/appearance and the parent's context inside `#die`, `birth` serves `#birth`
   * (which a `#die` reaches through `#emit` while the parent's context is still in use). A value an expression returns may be
   * the context's own `velocity` triple (`$v`); every caller copies it out before the slot is refilled, as with the triple
   * `#context` used to build.
   */
  readonly #main = this.#makeContext();
  readonly #birthCtx = this.#makeContext();
  /** the acceleration sum of the particle being stepped */
  readonly #acc: [number, number, number] = [0, 0, 0];

  #makeContext(): ReusableContext {
    const ctx: ReusableContext = {
      index: -1, pi: 0, inherited: undefined, pos: [0, 0, 0], vel: [0, 0, 0],
      age: 0, life: 1, size: 1, rand: 0, velocity: [0, 0, 0], position: [0, 0, 0], origin: [0, 0, 0], time: 0, dt: 0,
      random: () => this.#random(), gravity: [0, 0, 0], wind: [0, 0, 0], floorHeight: () => null,
      count: (name) => this.#previousCounts[this.#byName.get(name) ?? -1] ?? 0,
      attr: (name) => {
        const index = ctx.index;
        if (name === 'size') return index < 0 ? 1 : this.baseSizes[index]!;
        if (name === 'age') return index < 0 ? this.#time : this.ages[index]!;
        if (name === 'life') return index < 0 ? 1 : this.lives[index]!;
        if (name === 'rand') return index < 0 ? 0 : this.#rand[index]!;
        if (name === 'v') return ctx.velocity;
        const inherited = ctx.inherited;
        if (inherited?.[name] !== undefined) return inherited[name]!;
        const field = this.#custom.get(`${ctx.pi}:${name}`);
        if (field && index >= 0) {
          const k = index * 3;
          return field.width === 1 ? field.values[k]! : [field.values[k]!, field.values[k + 1]!, field.values[k + 2]!] as Vec3;
        }
        return 0;
      },
      roll: (slot) => ctx.index < 0 ? 0 : this.#rolls[ctx.index * this.#rollWidth + slot] ?? 0,
      smooth: (expr, value) => {
        const index = ctx.index;
        if (index < 0) return value;
        let values = this.#smooth.get(index);
        if (!values) this.#smooth.set(index, (values = new Map()));
        const previous = values.get(expr);
        const next = previous === undefined ? value : previous + (value - previous) * (1 - Math.exp(-ctx.dt / 0.25));
        values.set(expr, next);
        return next;
      },
    };
    return ctx;
  }

  #fill(ctx: ReusableContext, index: number, pi: number, now: number, dt: number, inherited?: Readonly<Record<string, FxValue>>): FxEvalContext {
    ctx.index = index;
    ctx.pi = pi;
    ctx.inherited = inherited;
    if (index < 0) {
      ctx.position = this.#origin;
      // a fresh zero triple, as before: `$v` of the effect context may be handed on
      ctx.velocity = [0, 0, 0];
    } else {
      const o = index * 3;
      const p = ctx.pos, v = ctx.vel;
      p[0] = this.positions[o]!; p[1] = this.positions[o + 1]!; p[2] = this.positions[o + 2]!;
      v[0] = this.velocities[o]!; v[1] = this.velocities[o + 1]!; v[2] = this.velocities[o + 2]!;
      ctx.position = p;
      ctx.velocity = v;
    }
    ctx.age = index < 0 ? this.#time : this.ages[index]!;
    ctx.life = index < 0 ? 1 : this.lives[index]!;
    ctx.size = index < 0 ? 1 : this.baseSizes[index]!;
    ctx.rand = index < 0 ? 0 : this.#rand[index]!;
    ctx.origin = this.#origin;
    ctx.time = Number.isFinite(now) ? now : this.#time;
    ctx.dt = dt;
    ctx.random = this.#random;
    ctx.gravity = this.#gravity;
    ctx.wind = this.#wind;
    ctx.floorHeight = this.#floorHeight;
    return ctx;
  }

  /**
   * `#fill` in two parts for the per-particle loops (cpu-budget CPU1 1.2): the fields that are the same for every particle of
   * one population in one pass, written once before its loop, and `#fillParticle` per particle. Together they write exactly
   * what `#fill(ctx, index, pi, now, dt)` writes for an index >= 0 without inherited values. Nothing inside a loop writes the
   * shared fields of the slot: expressions only read the context, and a death's births fill the `birth` slot.
   */
  #fillShared(ctx: ReusableContext, pi: number, now: number, dt: number): ReusableContext {
    ctx.pi = pi;
    ctx.inherited = undefined;
    ctx.origin = this.#origin;
    ctx.time = Number.isFinite(now) ? now : this.#time;
    ctx.dt = dt;
    ctx.random = this.#random;
    ctx.gravity = this.#gravity;
    ctx.wind = this.#wind;
    ctx.floorHeight = this.#floorHeight;
    return ctx;
  }

  #fillParticle(ctx: ReusableContext, index: number): FxEvalContext {
    ctx.index = index;
    const o = index * 3;
    const p = ctx.pos, v = ctx.vel;
    p[0] = this.positions[o]!; p[1] = this.positions[o + 1]!; p[2] = this.positions[o + 2]!;
    v[0] = this.velocities[o]!; v[1] = this.velocities[o + 1]!; v[2] = this.velocities[o + 2]!;
    ctx.position = p;
    ctx.velocity = v;
    ctx.age = this.ages[index]!;
    ctx.life = this.lives[index]!;
    ctx.size = this.baseSizes[index]!;
    ctx.rand = this.#rand[index]!;
    return ctx;
  }

  #context(index: number, pi: number, now: number, dt: number, inherited?: Readonly<Record<string, FxValue>>): FxEvalContext {
    const o = index < 0 ? 0 : index * 3;
    const position: Vec3 = index < 0 ? this.#origin : [this.positions[o]!, this.positions[o + 1]!, this.positions[o + 2]!];
    const velocity: Vec3 = index < 0 ? [0, 0, 0] : [this.velocities[o]!, this.velocities[o + 1]!, this.velocities[o + 2]!];
    const custom = this.#custom;
    return {
      age: index < 0 ? this.#time : this.ages[index]!,
      life: index < 0 ? 1 : this.lives[index]!,
      size: index < 0 ? 1 : this.baseSizes[index]!,
      rand: index < 0 ? 0 : this.#rand[index]!,
      velocity,
      position,
      origin: this.#origin,
      time: Number.isFinite(now) ? now : this.#time,
      dt,
      random: this.#random,
      gravity: this.#gravity,
      wind: this.#wind,
      floorHeight: this.#floorHeight,
      count: (name) => this.#previousCounts[this.#byName.get(name) ?? -1] ?? 0,
      attr: (name) => {
        if (name === 'size') return index < 0 ? 1 : this.baseSizes[index]!;
        if (name === 'age') return index < 0 ? this.#time : this.ages[index]!;
        if (name === 'life') return index < 0 ? 1 : this.lives[index]!;
        if (name === 'rand') return index < 0 ? 0 : this.#rand[index]!;
        if (name === 'v') return velocity;
        if (inherited?.[name] !== undefined) return inherited[name]!;
        const field = custom.get(`${pi}:${name}`);
        if (field && index >= 0) {
          const k = index * 3;
          return field.width === 1 ? field.values[k]! : [field.values[k]!, field.values[k + 1]!, field.values[k + 2]!] as Vec3;
        }
        return 0;
      },
      roll: (slot) => index < 0 ? 0 : this.#rolls[index * this.#rollWidth + slot] ?? 0,
      rangeRolls: this.#rangeRolls,
      smooth: (expr, value) => {
        if (index < 0) return value;
        let values = this.#smooth.get(index);
        if (!values) this.#smooth.set(index, (values = new Map()));
        const previous = values.get(expr);
        const next = previous === undefined ? value : previous + (value - previous) * (1 - Math.exp(-dt / 0.25));
        values.set(expr, next);
        return next;
      },
    };
  }

  #die(pop: Population, pi: number, i: number, ctx: FxEvalContext): void {
    const parent = pop.program;
    const pos: Vec3 = [this.positions[i * 3]!, this.positions[i * 3 + 1]!, this.positions[i * 3 + 2]!];
    for (const child of this.#populations) {
      const birth = child.program.birth;
      if (birth.kind !== 'parent' || birth.parent !== parent.name || this.#random() > birth.p) continue;
      const inherited: Record<string, FxValue> = {};
      for (const [name, expr] of Object.entries(birth.inherit.attrs)) inherited[name] = evaluate(expr, ctx);
      this.#emit(child, 1, birth.inherit.position ? pos : undefined, inherited);
    }
    const slot = this.#slots[i]!;
    const last = --pop.count;
    if (slot !== last) {
      const moved = pop.indices[last]!;
      pop.indices[slot] = moved;
      this.#slots[moved] = slot;
    }
    this.#slots[i] = -1;
    this.#next[i] = this.#free;
    this.#free = i;
    this.#active--;
    this.#smooth.delete(i);
  }

  #collideFloor(pop: Population, i: number): void {
    const floor = this.#floorHeight(this.positions[i * 3]!, this.positions[i * 3 + 2]!);
    if (floor === null || !Number.isFinite(floor) || this.positions[i * 3 + 1]! > floor || pop.program.floor === undefined) return;
    this.positions[i * 3 + 1] = floor;
    if (pop.program.floor === 'die') this.lives[i] = 0;
    else if (pop.program.floor === 'stick') { this.#stuck[i] = 1; this.velocities.fill(0, i * 3, i * 3 + 3); }
    else {
      this.velocities[i * 3 + 1] = Math.abs(this.velocities[i * 3 + 1]!) * pop.program.floor.bounce;
      this.velocities[i * 3] = this.velocities[i * 3]! * 0.55;
      this.velocities[i * 3 + 2] = this.velocities[i * 3 + 2]! * 0.55;
    }
  }

  #wrap(program: CompiledPop, i: number): void {
    const half = program.wrap;
    if (!half) return;
    for (let axis = 0; axis < 3; axis++) {
      const h = half[axis]!;
      if (!(h > 0)) continue;
      const low = this.#origin[axis]! - h;
      const span = 2 * h;
      const p = this.positions[i * 3 + axis]!;
      this.positions[i * 3 + axis] = low + (((p - low) % span) + span) % span;
    }
  }

  #updateAppearance(now = this.#time): void {
    for (let pi = 0; pi < this.#populations.length; pi++) {
      const pop = this.#populations[pi]!;
      const { sz, col, a: alphaFn, rot, spriteAlpha } = pop.fns;
      const main = this.#fillShared(this.#main, pi, now, 0);
      for (let slot = 0; slot < pop.count; slot++) {
        const i = pop.indices[slot]!;
        const c = this.#fillParticle(main, i);
        const size = sz(c);
        const tint = col(c);
        const alpha = asNumber(alphaFn(c), 1);
        this.sizes[i] = Math.max(0, asNumber(size, this.baseSizes[i]!));
        this.rotations[i] = rot === null ? 0 : asNumber(rot(c));
        const a = Math.max(0, Math.min(1, alpha));
        const o = i * 4;
        if (typeof tint === 'number') {
          this.rgba[o] = tint; this.rgba[o + 1] = tint; this.rgba[o + 2] = tint;
        } else {
          this.rgba[o] = tint[0]; this.rgba[o + 1] = tint[1]; this.rgba[o + 2] = tint[2];
        }
        this.rgba[o + 3] = spriteAlpha ? a : alpha;
      }
    }
  }
}

export function createFxSimulation(program: CompiledProgram, options: FxSimulationOptions = {}): FxSimulation {
  return new FxSimulation(program, options);
}

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
