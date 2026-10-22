// The nav port (docs/architecture.md §5.1 step 5 "physics/motion/nav ports"; WP NV2): what feeds `builtin/nav` in a running
// kernel. It holds no search state of its own; it knows which place has which bake and installs the binding (`bindNav`).
//
//   const nav = createNavPort();
//   const physics = nav.observe(createPhysicsPort());   // the place manager's buildPlace / disposePlace reach nav too
//   … ports: { physics } …
//   onKernel: nav.attachKernel(kernel)                  // the sim tick (per-tick guard) and the caller's machine (X-41)
//
// `observe` wraps the two place verbs of the physics port object in place (the place manager is the only caller of both and
// already hands the port the place's `PlaceBake`, with its nav grid and its pack), and takes from it, when it has them,
// `bodyRecords(place)` (the overlay's bodies: plain data, no Rapier, motion §14) and `isBuilt(place)`: while a place's
// physics build is still stored (Rapier not loaded, X-32) its queries answer null, and `findPath` answers no path with them.
// A caller that composes places by hand calls `buildPlace` / `disposePlace` here itself.
//
// The caller's machine is told by its session bag: every game ctx of a VM serves that VM's `session` object (core §10.3),
// so identity with `kernel.vms.client.session` is the client VM. The body records of a place are taken once per sim tick.
// The port made last holds the binding; `dispose()` gives it back.
import { bindNav, type NavBinding, type NavCtx } from '../builtin/nav.ts';
import type { NavGrid, PlaceBake } from '../core/ports.ts';
import type { PlaceId, VmId } from '../core/types.ts';
import { gridRowIds, type OverlayBody } from './overlay.ts';
import { navSearch } from './search.ts';

/** the kernel members the port reads (structural: nav never imports the kernel) */
export interface NavKernelLike {
  readonly clock: { readonly tick: number };
  readonly vms: Readonly<Record<VmId, { readonly session: object }>>;
}

/** the physics port members `observe` uses */
export interface NavPhysicsLike {
  buildPlace(place: PlaceId, bake: PlaceBake): void;
  disposePlace(place: PlaceId): void;
  bodyRecords?(place: PlaceId): readonly OverlayBody[];
  isBuilt?(place: PlaceId): boolean;
}

export interface NavPortOptions {
  /** build each grid's component graph at `buildPlace` (a place load) instead of at the first query that needs it; default true */
  prepare?: boolean;
  warn?(message: string): void;
}

interface PlaceNav {
  grid: NavGrid | null;
  inGrid: Set<string>;
}

let bound: NavPort | null = null;

export class NavPort {
  private readonly places = new Map<PlaceId, PlaceNav>();
  private readonly prepare: boolean;
  private readonly warnFn: ((message: string) => void) | undefined;
  private kernel: NavKernelLike | null = null;
  private physics: NavPhysicsLike | null = null;
  private restore: (() => void) | null = null;
  private disposed = false;
  // the body records of one place, as of one tick
  private cachePlace: PlaceId | null = null;
  private cacheTick = NaN;
  private cacheBodies: readonly OverlayBody[] = [];

  constructor(opts: NavPortOptions = {}) {
    this.prepare = opts.prepare !== false;
    this.warnFn = opts.warn;
    this.bind();
  }

  private bind(): void {
    const b: NavBinding = {
      grid: (place) => {
        const e = this.places.get(place);
        if (!e || (this.physics?.isBuilt && !this.physics.isBuilt(place))) return null;
        return e.grid;
      },
      bodies: (place) => this.bodies(place),
      inGrid: (place, rowId) => this.places.get(place)?.inGrid.has(rowId) === true,
      vm: (ctx) => this.vmOf(ctx),
    };
    if (this.kernel) {
      const k = this.kernel;
      b.tick = () => k.clock.tick;
    }
    if (this.warnFn) b.warn = this.warnFn;
    bindNav(b);
    bound = this;
  }

  private vmOf(ctx: NavCtx): VmId | undefined {
    const k = this.kernel;
    if (!k) return undefined;
    let session: unknown;
    try {
      session = ctx.session;
    } catch {
      return undefined;
    }
    return session === k.vms.client.session ? 'client' : session === k.vms.platform.session ? 'platform' : undefined;
  }

  private bodies(place: PlaceId): readonly OverlayBody[] {
    const read = this.physics?.bodyRecords;
    if (!read) return [];
    const tick = this.kernel ? this.kernel.clock.tick : NaN;
    if (this.cachePlace === place && this.cacheTick === tick) return this.cacheBodies;
    this.cacheBodies = read.call(this.physics, place);
    this.cachePlace = place;
    this.cacheTick = tick;
    return this.cacheBodies;
  }

  /** the kernel's sim tick and VM sessions; before it there is no per-tick guard and every caller is taken for the platform */
  attachKernel(k: NavKernelLike): void {
    this.kernel = k;
    if (bound === this) this.bind();
  }

  /**
   * Follows a physics port: its `buildPlace` and `disposePlace` reach this port first, its `bodyRecords` feed the overlay,
   * its `isBuilt` gates `findPath`. Returns the same object.
   */
  observe<T extends NavPhysicsLike>(physics: T): T {
    this.restore?.();
    const build = physics.buildPlace, dispose = physics.disposePlace;
    physics.buildPlace = (place, bake) => {
      this.buildPlace(place, bake);
      build.call(physics, place, bake);
    };
    physics.disposePlace = (place) => {
      this.disposePlace(place);
      dispose.call(physics, place);
    };
    this.physics = physics;
    this.restore = () => {
      physics.buildPlace = build;
      physics.disposePlace = dispose;
    };
    return physics;
  }

  /** the place's bake: its nav grid (null: none shipped, X-31) and which rows of its pack the grid holds */
  buildPlace(place: PlaceId, bake: PlaceBake): void {
    if (this.disposed) return;
    this.places.set(place, { grid: bake.navgrid, inGrid: gridRowIds(bake.colliders) });
    this.cachePlace = null;
    if (bake.navgrid && this.prepare) navSearch(bake.navgrid).prepare();
  }

  disposePlace(place: PlaceId): void {
    this.places.delete(place);
    if (this.cachePlace === place) this.cachePlace = null;
  }

  /** places with a bake */
  residentPlaces(): PlaceId[] {
    return [...this.places.keys()];
  }

  /** forgets every place, leaves the physics port as it was and gives the builtin binding back; the port is dead afterwards */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.places.clear();
    this.restore?.();
    this.restore = null;
    this.physics = null;
    if (bound === this) {
      bindNav(null);
      bound = null;
    }
  }
}

export function createNavPort(opts: NavPortOptions = {}): NavPort {
  return new NavPort(opts);
}
