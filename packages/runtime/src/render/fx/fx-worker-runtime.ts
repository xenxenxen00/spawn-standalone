// The fx Worker's facade on the main thread (DR-53/DR-54; .cache/claude-fxworker/DESIGN.md §3, §5-§7, §9): the runtime the
// game install hands on as `GameWorld.fx` by default. It keeps the calls that come into the fx system and the values they
// capture (where the in-process runtime reads them), sends them to the fx Worker (fx-worker.ts) at the loop's `fx` stage, and
// copies each finished result into the three buckets (fx-presenter.ts) at the next one; the light-table calls are replayed in
// the in-process runtime's order (fx-lights.ts).
//
//   latency      a frame's effects are drawn one frame later; at most one step is in flight, and the frames that arrive
//                meanwhile merge into one pending step (dt summed, the newest origins, camera and caps, the commands in call
//                order), so an overloaded worker lags two frames, never more (DR-54 2)
//   handles      `emit` / `bind` return a ticket at once; an effect the worker refuses (a compile error, the effect limit) is
//                reported with the next result, and `has()` turns false then (DESIGN §6: the accepted differences)
//   fallback     a Worker constructor that throws (CSP, no module workers), a worker error or a fatal message: one log line,
//                then a fresh in-process world; every live ticket's effect starts again there (`fx.mode = 'inline-fallback'`)
//   no SAB       buffers come back transferred, two sets in rotation, and are handed back with the next post (build §3.4)
import { Vector3, type Object3D } from 'three/webgpu';
import type { FxBinding } from '../bridge/bridge-types.ts';
import type { FrameInfo } from '../engine/render-loop.ts';
import { calibration } from '../calibration.ts';
import { tierConfig } from '../perf/budget.ts';
import type { Vec3 } from './dsl/compile.ts';
import { FX_MAX_PARTICLES } from './sim/simulator.ts';
import { FxPresenter } from './fx-presenter.ts';
import { fxLight, fxLightsDropUnlit, fxLightsRemoveAll, type FxLightOwner } from './fx-lights.ts';
import {
  FX_PROTOCOL_VERSION, FxBufferPool, returnedBuffers,
  type FromFxWorker, type FxCommand, type FxFrameIn, type FxFrameOut, type FxFrameStats, type FxSpawnCmd, type FxTarget, type FxWorldInit, type ToFxWorker,
} from './fx-protocol.ts';
import { FxWorld, type FxSpawn } from './world/fx-world.ts';
import { fxTier, heldScaleOf, resolveSpec, targetOf, type FxEffectId, type FxMode, type FxRuntimeApi, type FxRuntimeStats, type FxSystemOptions } from './fx-system.ts';
import type { FxSpriteBuckets } from './render/buckets.ts';
import type { FxStretchedBuckets } from './render/stretched-buckets.ts';

/** the part of a web `Worker` the facade uses (a Node `worker_threads` Worker adapted to it in the tests) */
export interface FxWorkerLike {
  postMessage(msg: unknown, transfer?: ArrayBuffer[]): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessageerror?: ((ev: unknown) => void) | null;
  terminate(): void;
}

export interface FxWorkerSeams {
  /** makes the worker; default: the `ss-fx` module worker of fx-worker.ts */
  readonly spawn?: () => FxWorkerLike;
  /** the clock of the watchdog, ms; default `performance.now` */
  readonly now?: () => number;
}

/**
 * A step in flight this long without an answer while fx stages keep running: the worker is taken as hung and the facade falls
 * back (a step takes milliseconds; a page that is hidden runs no fx stage, so it never trips this).
 */
export const FX_WORKER_STALL_MS = 15_000;

/** a handle the facade returned, and what the main thread keeps for it */
interface Ticket extends FxLightOwner {
  readonly ticket: number;
  readonly owner: string | null;
  readonly target: FxTarget;
  /** the spawn as sent: the fallback starts it again */
  readonly spawn: FxSpawnCmd;
  /** neither ended by the caller nor reported removed or refused */
  live: boolean;
}

interface Pending {
  frame: FxFrameIn;
  programs: Array<[number, string]>;
}

interface Arrived {
  readonly out: FxFrameOut;
  readonly camera: Float64Array | null;
  readonly ms: number;
}

const STEP_RING = 600;
const scratch = new Vector3();

function spawnFxWorker(): FxWorkerLike {
  // a local binding keeps this file free of DOM types in the Node projects; Vite bundles the worker from the literal
  // `new Worker(new URL(…), { type: 'module' })` form (as geometry-service.ts)
  const Worker = (globalThis as unknown as { Worker: new (url: URL, opts: { type: 'module'; name: string }) => FxWorkerLike }).Worker;
  return new Worker(new URL('./fx-worker.ts', import.meta.url), { type: 'module', name: 'ss-fx' });
}

const isDataCloneError = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'DataCloneError';

const cloneable = (value: unknown): boolean => {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
};

export class FxWorkerRuntime implements FxRuntimeApi {
  readonly #options: FxSystemOptions;
  readonly #presenter: FxPresenter;
  readonly #init: FxWorldInit;
  #mode: Exclude<FxMode, 'inline'> = 'worker';
  #fallbackReason: string | null = null;
  #worker: FxWorkerLike | null = null;
  /** the in-process world after a fallback */
  #world: FxWorld | null = null;
  readonly #pool = new FxBufferPool();
  readonly #tickets = new Map<number, Ticket>();
  #nextTicket = 1;
  /** commands since the last capture, in call order */
  #cmds: FxCommand[] = [];
  /** the interned program texts: text → ref, ref → text, and the refs not yet sent */
  readonly #refs = new Map<string, number>();
  readonly #texts = new Map<number, string>();
  #unsent: Array<[number, string]> = [];
  #inFlight = false;
  #pending: Pending | null = null;
  /** results that arrived and were not presented yet, oldest first */
  #arrived: Arrived[] = [];
  /** the buffers of presented results: they go back with the next post */
  #returnable: Array<[string, ArrayBuffer]> = [];
  #seq = 0;
  /** the camera each posted frame was captured with, by seq */
  readonly #cameras = new Map<number, Float64Array | null>();
  #last: FxFrameStats | null = null;
  #frames = 0;
  #presented = 0;
  #late = 0;
  #merged = 0;
  readonly #steps = new Float64Array(STEP_RING);
  #stepCount = 0;
  #stepMax = 0;
  #settle: Array<() => void> = [];
  #disposed = false;
  readonly #now: () => number;
  /** when the step in flight was posted */
  #postedAt = 0;

  constructor(options: FxSystemOptions, seams: FxWorkerSeams = {}) {
    this.#options = options;
    this.#now = seams.now ?? ((): number => performance.now());
    const cap = Math.max(1, options.budget.cap('particles', FX_MAX_PARTICLES));
    const distortEnabled = tierConfig(options.budget.tier).distort;
    this.#presenter = new FxPresenter({
      world: options.world,
      ...(options.camera === undefined ? {} : { camera: options.camera }),
      ...(options.distortScene === undefined ? {} : { distortScene: options.distortScene }),
      distortEnabled,
      atlas: options.atlas,
      capacity: cap,
      additiveFog: options.additiveFog ?? calibration.additiveFog,
      ...(options.alignedCards === undefined ? {} : { alignedCards: options.alignedCards }),
      ...(options.lightsOnly === undefined ? {} : { lightsOnly: options.lightsOnly }),
      ...(options.lighting === undefined ? {} : { lighting: options.lighting }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    this.#init = {
      capacity: cap,
      distortEnabled,
      hasCamera: options.camera !== undefined && options.camera !== null,
      maxEffects: options.maxEffects ?? 128,
      strict: options.strict ?? false,
      ...(options.heldFollow === undefined ? {} : { heldFollow: options.heldFollow }),
      ...(options.rangeRolls === undefined ? {} : { rangeRolls: options.rangeRolls }),
      ...(options.alignedCards === undefined ? {} : { alignedCards: options.alignedCards }),
      ...(options.lightsOnly === undefined ? {} : { lightsOnly: options.lightsOnly }),
      ...(options.gravity === undefined ? {} : { gravity: options.gravity }),
      ...(options.wind === undefined ? {} : { wind: options.wind }),
    };
    if (options.floorHeight !== undefined) {
      // a floor function cannot cross to the worker (and no shipped build passes one: DR-54 3)
      this.#fallBack('a floor function stays on the main thread');
      return;
    }
    try {
      const worker = (seams.spawn ?? spawnFxWorker)();
      this.#worker = worker;
      worker.onmessage = (ev) => this.#message(ev.data as FromFxWorker);
      worker.onerror = (ev) => this.#fallBack(`the fx worker failed: ${errorText(ev)}`);
      worker.onmessageerror = () => this.#fallBack('a message from the fx worker could not be read');
      const init: ToFxWorker = { t: 'init', v: FX_PROTOCOL_VERSION, init: this.#init };
      worker.postMessage(init);
    } catch (e) {
      this.#fallBack(`the fx worker could not start: ${errorText(e)}`);
    }
  }

  get sprites(): FxSpriteBuckets { return this.#presenter.sprites; }
  get stretched(): FxStretchedBuckets { return this.#presenter.stretched; }
  get mode(): Exclude<FxMode, 'inline'> { return this.#mode; }
  /** live tickets */
  get effectCount(): number {
    let n = 0;
    for (const t of this.#tickets.values()) if (t.live) n++;
    return n;
  }
  /** the particles of the last presented frame */
  get particleCount(): number { return this.#last?.particles ?? 0; }

  has(id: FxEffectId): boolean { return this.#tickets.get(id)?.live === true; }

  bind(rowId: string, spec: unknown, node: Object3D): FxBinding | null {
    if (this.#disposed) return null;
    let ticket = this.#spawn(spec, node, rowId);
    if (ticket === null) return null;
    return {
      restart: (next) => {
        if (ticket !== null) this.#end(ticket);
        ticket = this.#spawn(next, node, rowId);
      },
      end: () => {
        if (ticket !== null) this.#end(ticket);
        ticket = null;
      },
    };
  }

  emit(spec: unknown, origin: Vec3 = [0, 0, 0]): FxEffectId | null {
    return this.#spawn(spec, null, null, origin);
  }

  end(id: FxEffectId): void { this.#end(id); }

  warmObjects(): Object3D[] {
    if (this.#disposed) return [];
    return this.#presenter.warmObjects();
  }

  armDistortWarm(): { armed: boolean; done(): void } {
    const none = { armed: false, done: () => undefined };
    if (this.#disposed || !tierConfig(this.#options.budget.tier).distort) return none;
    const target = this.#options.distortScene;
    const scene = typeof target === 'function' ? target() : target ?? null;
    if (scene === null) return none;
    return this.#presenter.armDistortWarm(scene);
  }

  /**
   * The loop's `fx` stage: the results that arrived are presented (the newest drawn), then this frame is captured and posted,
   * or merged into the pending step while one is in flight. After a fallback: the in-process frame, drawn now.
   */
  update(frame: Pick<FrameInfo, 'dt' | 'now'>): void {
    if (this.#disposed) return;
    this.#frames++;
    if (this.#world !== null) {
      this.#inlineFrame(frame);
      return;
    }
    if (this.#arrived.length === 0 && this.#inFlight) {
      this.#late++;
      if (this.#now() - this.#postedAt > FX_WORKER_STALL_MS) {
        this.#fallBack(`the fx worker has not answered for ${Math.round((this.#now() - this.#postedAt) / 1000)} s`);
        this.#inlineFrame(frame);
        return;
      }
    }
    this.#present();
    const f = this.#capture(frame);
    const programs = this.#unsent;
    this.#unsent = [];
    if (this.#pending === null) this.#pending = { frame: f, programs };
    else {
      const p = this.#pending;
      this.#pending = { frame: { ...f, dt: p.frame.dt + f.dt, cmds: [...p.frame.cmds, ...f.cmds] }, programs: [...p.programs, ...programs] };
      this.#merged++;
    }
    if (!this.#inFlight) this.#post();
  }

  /** resolves once no step is in flight and none is pending (tests: the lock-step oracle) */
  settled(): Promise<void> {
    if (this.#disposed || this.#world !== null || (!this.#inFlight && this.#pending === null)) return Promise.resolve();
    return new Promise((resolve) => this.#settle.push(resolve));
  }

  stats(): FxRuntimeStats {
    const n = Math.min(this.#stepCount, STEP_RING);
    const sorted = Array.from(this.#steps.subarray(0, n)).sort((a, b) => a - b);
    const q = (p: number): number => (n === 0 ? 0 : sorted[Math.min(n - 1, Math.floor(p * n))]!);
    return {
      mode: this.#mode,
      effects: this.#last?.effects ?? 0,
      particles: this.#last?.particles ?? 0,
      meshParticles: this.#last?.meshParticles ?? 0,
      frames: this.#frames,
      presented: this.#presented,
      late: this.#late,
      merged: this.#merged,
      stepMs: { last: n === 0 ? 0 : this.#steps[(this.#stepCount - 1) % STEP_RING]!, p50: q(0.5), p95: q(0.95), max: this.#stepMax },
      fallback: this.#fallbackReason,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#dropWorker(true);
    this.#world?.clear();
    this.#world = null;
    const lights = this.#options.lights;
    for (const t of this.#tickets.values()) fxLightsRemoveAll(lights, t);
    this.#tickets.clear();
    this.#presenter.dispose();
    this.#resolveSettled();
  }

  // ── calls ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  #spawn(spec: unknown, node: Object3D | null, owner: string | null, initialOrigin?: Vec3): FxEffectId | null {
    if (this.#disposed) return null;
    const options = this.#options;
    const resolved = resolveSpec(spec, options, (m) => this.#log(m));
    if (resolved === null) return null;
    const camera = options.camera ?? null;
    const target = targetOf(resolved.source, node, camera);
    const object = target === 2 ? camera : target === 1 ? node : null;
    if (object) object.getWorldPosition(scratch);
    else scratch.set(...(initialOrigin ?? [0, 0, 0]));
    const ticket = this.#nextTicket++;
    const cmd: FxSpawnCmd = {
      k: 's',
      ticket,
      owner,
      ...(resolved.script === resolved.source ? {} : { path: resolved.script }),
      ref: this.#ref(resolved.source),
      params: resolved.params,
      ...(resolved.seed === undefined ? {} : { seed: resolved.seed }),
      origin: [scratch.x, scratch.y, scratch.z],
      manual: initialOrigin === undefined ? [0, 0, 0] : [initialOrigin[0], initialOrigin[1], initialOrigin[2]],
      target,
      tier: fxTier(options),
      heldFactor: tierConfig(options.budget.tier).fxHeldFactor * heldScaleOf(options.heldScale),
      cap: options.budget.cap('particles', FX_MAX_PARTICLES),
    };
    const t: Ticket = { ticket, owner, node, target, spawn: cmd, live: true, handles: new Map(), lit: new Set() };
    this.#tickets.set(ticket, t);
    if (this.#world !== null) {
      // the in-process fallback starts it now, as the in-process runtime does
      if (this.#world.spawn(this.#spawnOf(cmd)) === null) {
        this.#tickets.delete(ticket);
        return null;
      }
    } else this.#cmds.push(cmd);
    return ticket as FxEffectId;
  }

  #end(ticket: number): void {
    const t = this.#tickets.get(ticket);
    if (t === undefined || !t.live) return;
    t.live = false;
    if (this.#world !== null) {
      const effect = this.#world.byTicket(ticket);
      if (effect !== undefined) this.#world.remove(effect.id);
      else this.#drop(ticket);
      return;
    }
    this.#cmds.push({ k: 'e', ticket });
  }

  #ref(text: string): number {
    let ref = this.#refs.get(text);
    if (ref === undefined) {
      ref = this.#refs.size + 1;
      this.#refs.set(text, ref);
      this.#texts.set(ref, text);
      this.#unsent.push([ref, text]);
    }
    return ref;
  }

  #spawnOf(c: FxSpawnCmd): FxSpawn {
    const source = this.#texts.get(c.ref)!;
    return {
      ticket: c.ticket, owner: c.owner, script: c.path ?? source, source, params: c.params, seed: c.seed,
      origin: c.origin, manual: c.manual, target: c.target, tier: c.tier, heldFactor: c.heldFactor, cap: c.cap, floorY: c.floorY,
    };
  }

  // ── frames ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** this fx stage's input: the values `FxRuntime.update` reads, read now */
  #capture(frame: Pick<FrameInfo, 'dt' | 'now'>): FxFrameIn {
    const options = this.#options;
    const camera = options.camera ?? null;
    const tickets: number[] = [];
    const xyz: number[] = [];
    for (const t of this.#tickets.values()) {
      if (!t.live || t.target === 0) continue;
      const object = t.target === 2 ? camera : t.node;
      if (object === null) continue;
      object.getWorldPosition(scratch);
      tickets.push(t.ticket);
      xyz.push(scratch.x, scratch.y, scratch.z);
    }
    const cmds = this.#cmds;
    this.#cmds = [];
    return {
      dt: frame.dt,
      now: frame.now,
      cap: options.budget.cap('particles', FX_MAX_PARTICLES),
      lightsCap: options.budget.cap('fxLights', Number.POSITIVE_INFINITY),
      lightsOn: options.lights !== undefined && options.lights !== null,
      roughness: calibration.fxMeshRoughness,
      camera: this.#presenter.cameraMatrix(),
      originTickets: Int32Array.from(tickets),
      originXyz: Float64Array.from(xyz),
      cmds,
    };
  }

  #post(): void {
    const worker = this.#worker;
    const p = this.#pending;
    if (worker === null || p === null) return;
    const seq = ++this.#seq;
    for (let attempt = 0; ; attempt++) {
      const returned = this.#returnable;
      const msg: ToFxWorker = { t: 'frame', seq, frame: p.frame, programs: p.programs, returned };
      try {
        worker.postMessage(msg, returned.map((r) => r[1]));
        this.#returnable = [];
        break;
      } catch (e) {
        if (!isDataCloneError(e) || attempt > 0) {
          this.#fallBack(`a frame could not be posted to the fx worker: ${errorText(e)}`);
          return;
        }
        // an act payload that is not plain data (DESIGN §5): its spawn is dropped with a log, the frame posted again
        const kept: FxCommand[] = [];
        for (const c of p.frame.cmds) {
          if (c.k === 's' && !cloneable(c.params)) {
            this.#log(`fx spec params of ${c.owner ?? 'an act'} are not plain data; the effect is dropped`);
            this.#drop(c.ticket);
          } else kept.push(c);
        }
        p.frame = { ...p.frame, cmds: kept };
      }
    }
    this.#pending = null;
    this.#inFlight = true;
    this.#postedAt = this.#now();
    this.#cameras.set(seq, p.frame.camera);
  }

  #message(msg: FromFxWorker): void {
    if (this.#disposed || this.#worker === null) return;
    if (msg.t === 'ready') {
      if (msg.v !== FX_PROTOCOL_VERSION) this.#fallBack(`the fx worker speaks protocol ${String(msg.v)}, not ${FX_PROTOCOL_VERSION}`);
      return;
    }
    if (msg.t === 'fatal') {
      this.#fallBack(`the fx worker stopped: ${msg.message}`);
      return;
    }
    if (msg.t !== 'frame') return;
    this.#inFlight = false;
    const camera = this.#cameras.get(msg.seq) ?? null;
    this.#cameras.delete(msg.seq);
    this.#arrived.push({ out: msg.out, camera, ms: msg.ms });
    if (this.#pending !== null) this.#post();
    else this.#resolveSettled();
  }

  /** the results that arrived, oldest first: each one's removals, refusals, logs and lights; the newest one's buckets */
  #present(): void {
    const arrived = this.#arrived;
    if (arrived.length === 0) return;
    this.#arrived = [];
    for (let i = 0; i < arrived.length; i++) {
      const r = arrived[i]!;
      this.#events(r.out);
      if (i === arrived.length - 1) this.#presenter.apply(r.out, r.camera);
      for (const b of returnedBuffers(r.out)) this.#returnable.push(b);
      this.#presented++;
      this.#last = r.out.stats;
      this.#noteStep(r.out.stats.stepMs);
    }
  }

  #noteStep(ms: number): void {
    this.#steps[this.#stepCount % STEP_RING] = ms;
    this.#stepCount++;
    if (ms > this.#stepMax) this.#stepMax = ms;
  }

  /** a result's removals (their lights go, in removal order), refusals, logs, then the light replay (DESIGN §6 item 4) */
  #events(out: FxFrameOut): void {
    for (const line of out.logs) this.#logLine(line);
    for (const ticket of out.removed) this.#drop(ticket);
    for (const ticket of out.refused) this.#drop(ticket);
    const lights = this.#options.lights;
    const sel = out.lights;
    if (!lights || sel === null) return;
    for (const t of this.#tickets.values()) t.lit.clear();
    const { ints, values, flashKeys } = sel;
    const staticOwner = this.#options.staticOwner;
    for (let e = 0; e < flashKeys.length; e++) {
      const t = this.#tickets.get(ints[e * 4]!);
      if (t === undefined) continue;
      const v = e * 8;
      const key = `${ints[e * 4 + 1]!}:${ints[e * 4 + 2]!}`;
      fxLight(lights, t, key, ints[e * 4 + 3] === 1, () => flashKeys[e]!, [values[v]!, values[v + 1]!, values[v + 2]!], values[v + 3]!, values[v + 4]!, { x: values[v + 5]!, y: values[v + 6]!, z: values[v + 7]! }, staticOwner);
    }
    for (const t of this.#tickets.values()) fxLightsDropUnlit(lights, t);
  }

  /** a ticket the world no longer holds: its lights go, and so does the ticket */
  #drop(ticket: number): void {
    const t = this.#tickets.get(ticket);
    if (t === undefined) return;
    fxLightsRemoveAll(this.#options.lights, t);
    this.#tickets.delete(ticket);
  }

  /** after a fallback: the frame in-process, presented at once (the in-process runtime's timing) */
  #inlineFrame(frame: Pick<FrameInfo, 'dt' | 'now'>): void {
    const world = this.#world!;
    const f = this.#capture(frame);
    const out = world.frame(f, (ref) => this.#texts.get(ref), this.#pool);
    this.#events(out);
    this.#presenter.apply(out, f.camera, true);
    for (const [key, buf] of returnedBuffers(out)) this.#pool.give(key, buf);
    this.#presented++;
    this.#last = out.stats;
  }

  // ── the fallback ──────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The worker is gone or never came: log once, present what arrived, then run a fresh in-process world. Every live ticket's
   * effect starts again there in ticket order (bound effects continue at their rows; a one-shot plays again from its start);
   * an ended ticket's lights go.
   */
  #fallBack(reason: string): void {
    if (this.#world !== null || this.#disposed) return;
    this.#log(`${reason}; the effects run on the main thread from now on`);
    if (this.#worker !== null) this.#present();
    this.#dropWorker(false);
    this.#mode = 'inline-fallback';
    this.#fallbackReason = reason;
    const floorHeight = this.#options.floorHeight;
    const world = new FxWorld(this.#init, {
      ...(floorHeight === undefined ? {} : { floorHeight }),
      log: (line) => this.#logLine(line),
      onRemove: (effect) => this.#drop(effect.ticket),
    });
    this.#world = world;
    this.#cmds = [];
    for (const t of [...this.#tickets.values()]) {
      if (!t.live) {
        this.#drop(t.ticket);
        continue;
      }
      if (world.spawn(this.#spawnOf(t.spawn)) === null) this.#drop(t.ticket);
    }
    this.#resolveSettled();
  }

  #dropWorker(dispose: boolean): void {
    const worker = this.#worker;
    this.#worker = null;
    this.#inFlight = false;
    this.#pending = null;
    this.#arrived = [];
    this.#returnable = [];
    this.#cameras.clear();
    if (worker === null) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    try {
      if (dispose) worker.postMessage({ t: 'dispose' } satisfies ToFxWorker);
    } catch {
      // terminated anyway below
    }
    try {
      worker.terminate();
    } catch {
      // nothing more to do
    }
  }

  #resolveSettled(): void {
    const list = this.#settle;
    this.#settle = [];
    for (const r of list) r();
  }

  #log(message: string): void { this.#logLine(`[fx] ${message}`); }
  #logLine(line: string): void { (this.#options.log ?? console.warn)(line); }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
  return String(e);
}

/** The fx runtime on the fx Worker (render §13; DR-53), with the in-process runtime as its fallback. */
export function createFxWorkerSystem(options: FxSystemOptions, seams: FxWorkerSeams = {}): FxWorkerRuntime {
  return new FxWorkerRuntime(options, seams);
}
