// The fx world (render §13; DR-53/DR-54): every effect's simulation, its start (compile, the effect limit with its eviction and
// refusal, the seed, the shared particle ceiling), the step, the light-sink selection and the bucket fills. Three-free: the fx
// Worker runs it (fx-worker.ts, through `frame`), and so does the in-process runtime (fx-system.ts, through `spawn` / `step` /
// `lights` and the fills on three's own arrays), so the two produce the same floats. This is `FxRuntime`'s `#start`, `update`
// and `#updateLights` as they stood before the move (tests/unit/render/fx/legacy/fx-system.legacy.ts), operation for operation.
//
// What the main thread keeps: the calls coming in and the values they capture (origins, the camera, caps, tier flags, the held
// factor), the three objects the arrays are copied into, and the light-table calls (DESIGN §3).
import { compileProgram, type CompiledProgram, type FxTier, type Vec3 } from '../dsl/compile.ts';
import { createFxSimulation, type FxSimulation, type FxSimulationOptions } from '../sim/simulator.ts';
import {
  FxBufferPool, MESH_FLOATS, SPRITE_FLOATS, STRETCHED_FLOATS, meshPoolKey, spritePoolKey, stretchedPoolKey,
  type FxFrameIn, type FxFrameOut, type FxMeshOut, type FxSpace, type FxSpriteBlend, type FxSpriteOut, type FxTarget, type FxWorldInit,
} from '../fx-protocol.ts';
import { fillSprites, growSpriteSlot, makeSpriteSlot, packSprites, type FillFrame, type SpriteSlot, type SpriteSlots } from './fill-sprites.ts';
import { fillStretched, growStretchedSlot, makeStretchedSlot, packStretched, type StretchedSlot, type StretchedSlots } from './fill-stretched.ts';
import { fillMeshes, meshViews, type MeshArrays, type MeshFill } from './fill-mesh.ts';
import { invertInto } from './fx-math.ts';

/** an effect to start: the spec's values and every capture of the call (DESIGN §3) */
export interface FxSpawn {
  /** the caller's handle (the worker facade's ticket; 0 in-process, where the world's id is the handle) */
  readonly ticket: number;
  readonly owner: string | null;
  /** the spec's script as given (a path or the program text), for the logs */
  readonly script: string;
  /** the program text */
  readonly source: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly seed?: number | undefined;
  readonly origin: Vec3;
  readonly manual: Vec3;
  readonly target: FxTarget;
  readonly tier: FxTier;
  readonly heldFactor: number;
  readonly cap: number;
  readonly floorY?: number | undefined;
}

export interface FxWorldEffect {
  readonly id: number;
  readonly ticket: number;
  readonly sim: FxSimulation;
  readonly owner: string | null;
  readonly order: number;
  readonly target: FxTarget;
  readonly manual: Vec3;
  lastOrigin: Vec3;
}

export interface FxWorldSeams {
  /** a floor for every effect (the in-process runtime's `FxSystemOptions.floorHeight`; inert in the shipped build, DR-54 3) */
  readonly floorHeight?: FxSimulationOptions['floorHeight'];
  /** `[fx] …` lines (the prefix is the world's) */
  readonly log?: (line: string) => void;
  /** an effect leaves the world (end, eviction, finished, dispose), before its simulation is disposed */
  readonly onRemove?: (effect: FxWorldEffect) => void;
}

/** the selected light of a sink particle, as `lights` hands it on */
export type FxLightVisit = (effect: FxWorldEffect, pop: number, index: number, held: boolean, name: string, color: [number, number, number], intensity: number, radius: number, x: number, y: number, z: number) => void;

export function seedFor(id: number, owner: string | null, script: string): number {
  let h = (2166136261 ^ id) >>> 0;
  const text = `${owner ?? ''}\u0000${script}`;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h | 0;
}

function asLinear3(value: unknown): [number, number, number] {
  if (Array.isArray(value)) return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return [n, n, n];
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class FxWorld {
  readonly #init: FxWorldInit;
  readonly #seams: FxWorldSeams;
  readonly #effects = new Map<number, FxWorldEffect>();
  readonly #byTicket = new Map<number, number>();
  readonly #ordered: FxWorldEffect[] = [];
  readonly #sims: FxSimulation[] = [];
  #nextId = 1;
  #order = 1;
  /** refusals at the effect limit since its warning (F4) */
  #limitRefusals = 0;
  /** the frame being run by `frame`: where its removals and logs go */
  #frameRemoved: number[] | null = null;
  #frameLogs: string[] | null = null;
  // the worker's own buckets (`frame`): kept across frames, as the in-process buckets are
  readonly #spriteSlots = new Map<string, SpriteSlot>();
  readonly #stretchedSlots = new Map<string, StretchedSlot>();
  readonly #meshSpaces = new Set<FxSpace>();
  readonly #inverse = new Float64Array(16);
  readonly #origins = new Map<number, number>();

  constructor(init: FxWorldInit, seams: FxWorldSeams = {}) {
    this.#init = init;
    this.#seams = seams;
  }

  get init(): FxWorldInit { return this.#init; }
  get effectCount(): number { return this.#effects.size; }
  get particleCount(): number {
    let count = 0;
    for (const effect of this.#effects.values()) count += effect.sim.particleCount;
    return count;
  }

  /** the live effects, in start order */
  effects(): IterableIterator<FxWorldEffect> { return this.#effects.values(); }
  has(id: number): boolean { return this.#effects.has(id); }
  get(id: number): FxWorldEffect | undefined { return this.#effects.get(id); }

  /** the live effects' simulations, in start order (one array, reused) */
  sims(): readonly FxSimulation[] {
    const sims = this.#sims;
    sims.length = 0;
    for (const effect of this.#effects.values()) sims.push(effect.sim);
    return sims;
  }

  #log(message: string): void {
    const line = `[fx] ${message}`;
    if (this.#frameLogs !== null) this.#frameLogs.push(line);
    else (this.#seams.log ?? console.warn)(line);
  }

  /** `FxRuntime#start` after the spec's shape checks and script resolution: compile, the effect limit, the simulation */
  spawn(s: FxSpawn): FxWorldEffect | null {
    let program: CompiledProgram;
    try {
      program = compileProgram(s.source, s.params, s.tier, { strict: this.#init.strict });
    } catch (error) {
      this.#log(`fx script '${s.script}' failed to compile: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    const maxEffects = this.#init.maxEffects;
    if (this.#effects.size >= maxEffects) {
      let disposable: FxWorldEffect | undefined;
      for (const effect of this.#effects.values()) {
        if (effect.sim.finished) {
          disposable = effect;
          break;
        }
      }
      if (disposable) this.remove(disposable.id);
      else {
        // F4: one warning per saturation, not per refusal (a stress wave refused hundreds in a run); the count of the
        // refusals is logged once an effect starts again
        if (this.#limitRefusals++ === 0) this.#log(`fx effect limit (${maxEffects}) reached; further refusals are counted until an effect starts again`);
        return null;
      }
    }
    if (this.#limitRefusals > 0) {
      this.#log(`fx effect limit (${maxEffects}): ${this.#limitRefusals} effect${this.#limitRefusals === 1 ? '' : 's'} refused while full`);
      this.#limitRefusals = 0;
    }
    const id = this.#nextId++;
    const particleCap = Math.max(1, s.cap);
    const occupied = this.particleCount;
    const initialCapacity = Math.min(particleCap, Math.max(1, Math.min(64, particleCap - occupied || 1)));
    const floorY = s.floorY;
    const floorHeight = this.#seams.floorHeight ?? (floorY === undefined ? undefined : (): number => floorY);
    const sim = createFxSimulation(program, {
      seed: s.seed ?? seedFor(id, s.owner, s.source),
      capacity: particleCap,
      initialCapacity,
      birthBudget: Math.max(0, particleCap - occupied),
      heldFactor: s.heldFactor,
      origin: s.origin,
      ...(this.#init.gravity === undefined ? {} : { gravity: this.#init.gravity }),
      ...(this.#init.wind === undefined ? {} : { wind: this.#init.wind }),
      ...(floorHeight === undefined ? {} : { floorHeight }),
      ...(this.#init.rangeRolls === undefined ? {} : { rangeRolls: this.#init.rangeRolls }),
    });
    const effect: FxWorldEffect = { id, ticket: s.ticket, sim, owner: s.owner, order: this.#order++, target: s.target, manual: s.manual, lastOrigin: [s.origin[0], s.origin[1], s.origin[2]] };
    this.#effects.set(id, effect);
    if (s.ticket > 0) this.#byTicket.set(s.ticket, id);
    return effect;
  }

  /** `FxRuntime#remove`; false when no such effect */
  remove(id: number): boolean {
    const effect = this.#effects.get(id);
    if (!effect) return false;
    this.#seams.onRemove?.(effect);
    effect.sim.dispose();
    this.#effects.delete(id);
    if (effect.ticket > 0) this.#byTicket.delete(effect.ticket);
    this.#frameRemoved?.push(effect.ticket);
    return true;
  }

  /** the effect a ticket started, if it is live */
  byTicket(ticket: number): FxWorldEffect | undefined {
    const id = this.#byTicket.get(ticket);
    return id === undefined ? undefined : this.#effects.get(id);
  }

  /**
   * `FxRuntime.update`'s step: the effects in start order under the shared particle ceiling `cap`, each at the origin
   * `originOf` gives it; an effect that finished leaves.
   */
  step(dt: number, nowSeconds: number, cap: number, originOf: (effect: FxWorldEffect) => Vec3): void {
    const values = this.#ordered;
    values.length = 0;
    for (const effect of this.#effects.values()) values.push(effect);
    values.sort((a, b) => a.order - b.order);
    const particleCap = Math.max(0, cap);
    let occupied = 0;
    for (let k = 0; k < values.length; k++) occupied += values[k]!.sim.particleCount;
    for (let k = 0; k < values.length; k++) {
      const effect = values[k]!;
      const before = effect.sim.particleCount;
      const origin = originOf(effect);
      if (this.#init.heldFollow === true) this.#followHeld(effect, origin);
      effect.sim.step(dt, nowSeconds, origin, Math.max(0, particleCap - occupied));
      occupied += effect.sim.particleCount - before;
      if (effect.sim.finished) this.remove(effect.id);
    }
    values.length = 0;
  }

  /** Held at= populations move by their anchor's displacement before the shared step. */
  #followHeld(effect: FxWorldEffect, origin: Vec3): void {
    const last = effect.lastOrigin;
    const dx = origin[0] - last[0], dy = origin[1] - last[1], dz = origin[2] - last[2];
    effect.lastOrigin = [origin[0], origin[1], origin[2]];
    if (dx === 0 && dy === 0 && dz === 0) return;
    const positions = effect.sim.positions;
    for (const pop of effect.sim.populations) {
      const birth = pop.program.birth;
      if (birth.kind === 'parent' || birth.mode !== 'at') continue;
      for (let slot = 0; slot < pop.count; slot++) {
        const o = pop.indices[slot]! * 3;
        positions[o] = positions[o]! + dx;
        positions[o + 1] = positions[o + 1]! + dy;
        positions[o + 2] = positions[o + 2]! + dz;
      }
    }
  }

  /**
   * `FxRuntime#updateLights`' selection: every light-sink particle of the live effects, in effect → population → particle
   * order, up to `budget`; the colour, intensity and radius are evaluated (in the simulation's order: they may draw) only for
   * the selected ones. Returns how many were selected.
   */
  lights(nowSeconds: number, budget: number, visit: FxLightVisit): number {
    let used = 0;
    for (const effect of this.#effects.values()) {
      const sim = effect.sim;
      for (const pop of sim.populations) {
        const sink = pop.program.sink;
        if (sink?.kind !== 'light') continue;
        for (let slot = 0; slot < pop.count; slot++) {
          const index = pop.indices[slot]!;
          if (used >= budget) continue;
          const color = asLinear3(sim.value(pop.program.name, index, sink.color, nowSeconds));
          const intensityValue = sim.value(pop.program.name, index, sink.intensity, nowSeconds);
          const radiusValue = sim.value(pop.program.name, index, sink.radius, nowSeconds);
          const intensity = typeof intensityValue === 'number' ? Math.max(0, intensityValue) : 0;
          const radius = typeof radiusValue === 'number' ? Math.max(0, radiusValue) : 0;
          visit(effect, pop.program.index, index, pop.program.emit.kind === 'held', pop.program.name, color, intensity, radius, sim.positions[index * 3]!, sim.positions[index * 3 + 1]!, sim.positions[index * 3 + 2]!);
          used++;
        }
      }
    }
    return used;
  }

  /** every effect leaves (dispose) */
  clear(): void {
    for (const id of [...this.#effects.keys()]) this.remove(id);
  }

  // ── the worker's frame ────────────────────────────────────────────────────────────────────────────────────────────

  readonly #spriteSlotsView: SpriteSlots = {
    get: (key) => this.#spriteSlots.get(key),
    make: (key, blend, space) => {
      const slot = makeSpriteSlot(blend, space, 0);
      this.#spriteSlots.set(key, slot);
      return slot;
    },
    values: () => this.#spriteSlots.values(),
    ensure: (slot, count) => growSpriteSlot(slot, count, this.#init.capacity),
  };

  readonly #stretchedSlotsView: StretchedSlots = {
    get: (key) => this.#stretchedSlots.get(key),
    make: (key, blend, space) => {
      const slot = makeStretchedSlot(blend, space, 0);
      this.#stretchedSlots.set(key, slot);
      return slot;
    },
    values: () => this.#stretchedSlots.values(),
    ensure: (slot, count) => growStretchedSlot(slot, count, this.#init.capacity),
  };

  /**
   * One fx stage in the worker: the frame's commands in call order, the step, the fills and the lights, with every bucket's
   * live prefix in a buffer of `pool` (the caller transfers them). `text(ref)` is the interned program text of a spawn.
   */
  frame(f: FxFrameIn, text: (ref: number) => string | undefined, pool: FxBufferPool): FxFrameOut {
    const t0 = now();
    const removed: number[] = [];
    const refused: number[] = [];
    const logs: string[] = [];
    this.#frameRemoved = removed;
    this.#frameLogs = logs;
    try {
      for (const c of f.cmds) {
        if (c.k === 'e') {
          const id = this.#byTicket.get(c.ticket);
          if (id !== undefined) this.remove(id);
          continue;
        }
        const source = text(c.ref);
        if (source === undefined) {
          logs.push(`[fx] fx program ${c.ref} was never sent; the effect is refused`);
          refused.push(c.ticket);
          continue;
        }
        const started = this.spawn({
          ticket: c.ticket, owner: c.owner, script: c.path ?? source, source, params: c.params, seed: c.seed,
          origin: c.origin, manual: c.manual, target: c.target, tier: c.tier, heldFactor: c.heldFactor, cap: c.cap, floorY: c.floorY,
        });
        if (started === null) refused.push(c.ticket);
      }
      const origins = this.#origins;
      origins.clear();
      for (let i = 0; i < f.originTickets.length; i++) origins.set(f.originTickets[i]!, i);
      const xyz = f.originXyz;
      this.step(f.dt, f.now / 1000, f.cap, (effect) => {
        const at = effect.target === 0 ? undefined : origins.get(effect.ticket);
        return at === undefined ? [effect.manual[0], effect.manual[1], effect.manual[2]] : [xyz[at * 3]!, xyz[at * 3 + 1]!, xyz[at * 3 + 2]!];
      });
      const sims = this.#init.lightsOnly === true ? [] : this.sims();
      const inverse = f.camera === null ? null : invertInto(f.camera, this.#inverse);
      const fill: FillFrame = { hasCamera: this.#init.hasCamera, inverse, capacity: this.#init.capacity, distortEnabled: this.#init.distortEnabled, camera: f.camera, alignedCards: this.#init.alignedCards === true };
      fillSprites(sims, fill, this.#spriteSlotsView);
      const sprites: FxSpriteOut[] = [];
      let spriteCount = 0;
      for (const [key, slot] of this.#spriteSlots) {
        const buf = slot.count > 0 ? pool.take(spritePoolKey(key), slot.count * SPRITE_FLOATS) : null;
        if (buf !== null) packSprites(slot, buf);
        sprites.push({ key, space: slot.space, blend: slot.blend, count: slot.count, buf });
        spriteCount += slot.count;
      }
      fillStretched(sims, fill, this.#stretchedSlotsView);
      const stretched: FxSpriteOut[] = [];
      let stretchedCount = 0;
      for (const [key, slot] of this.#stretchedSlots) {
        const buf = slot.count > 0 ? pool.take(stretchedPoolKey(key), slot.count * STRETCHED_FLOATS) : null;
        if (buf !== null) packStretched(slot, buf);
        stretched.push({ key, space: slot.space, blend: slot.blend, count: slot.count, buf });
        stretchedCount += slot.count;
      }
      const meshBufs: Partial<Record<FxSpace, Float32Array>> = {};
      const fills: MeshFill = { world: 0, camera: 0, usedWorld: false, usedCamera: false };
      fillMeshes(sims, this.#init.hasCamera, inverse, f.roughness, {
        use: (space) => {
          this.#meshSpaces.add(space);
        },
        arrays: (space, count): MeshArrays | null => {
          if (count === 0) return null;
          const buf = pool.take(meshPoolKey(space), count * MESH_FLOATS);
          meshBufs[space] = buf;
          return meshViews(buf, count);
        },
      }, fills);
      // every space an effect was ever seen in, in the order it first was (the presenter makes the buckets in that order)
      const meshes: FxMeshOut[] = [];
      for (const space of this.#meshSpaces) {
        const count = space === 'world' ? fills.world : fills.camera;
        meshes.push({ space, touched: space === 'world' ? fills.usedWorld : fills.usedCamera, count, buf: count > 0 ? meshBufs[space] ?? null : null });
      }
      let lights: FxFrameOut['lights'] = null;
      let lightCount = 0;
      if (f.lightsOn) {
        const ints: number[] = [];
        const values: number[] = [];
        const flashKeys: string[] = [];
        lightCount = this.lights(f.now / 1000, f.lightsCap, (effect, pop, index, held, name, color, intensity, radius, x, y, z) => {
          ints.push(effect.ticket, pop, index, held ? 1 : 0);
          values.push(color[0], color[1], color[2], intensity, radius, x, y, z);
          flashKeys.push(`fx:${effect.owner ?? effect.id}:${name}`);
        });
        lights = { ints: Int32Array.from(ints), values: Float64Array.from(values), flashKeys };
      }
      return {
        sprites, stretched, meshes, lights, removed, refused, logs,
        stats: { effects: this.#effects.size, particles: this.particleCount, meshParticles: fills.world + fills.camera, sprites: spriteCount, stretched: stretchedCount, lights: lightCount, stepMs: now() - t0 },
      };
    } finally {
      this.#frameRemoved = null;
      this.#frameLogs = null;
    }
  }
}

/** the blend of a bucket key (`<space>:<blend>`) */
export const blendOf = (key: string): FxSpriteBlend => key.slice(key.indexOf(':') + 1) as FxSpriteBlend;
