// World bounds and out of bounds (docs/design/core-runtime.md §11.7; contract §10.3; motion §5.8; WP C4).
//
// Tick step E, after the physics steps and the lifecycle's own step-E work: every top-level row of a simulated place that has a
// physics body other than `static` and whose feet are below `bottom(place)` is out of bounds ("the engine answers a BODY below
// worldBounds.bottom", engine reference; a row without a body, such as an authored prop or a light under the map, is never
// touched, and a child follows its parent). Once per fall:
//   1. a row whose behaviours export `onOutOfBounds` gets `{bottom, position, placeId, respawnPoint}` while it is still at the
//      fall point, and decides (enemies destroy themselves, authored module); nothing else happens to it;
//   2. else a `dynamic` body (gibs, shards, dropped gear) is held at the bottom plane with no velocity and warned once
//      ("gib out of bounds", scripts/gore/gore.js:1001); it is held again whenever it sinks while it is still latched;
//   3. else the row goes to the place's spawn point with zero velocity.
// The row is latched until its feet are back above `bottom + 1 m`, so nothing repeats every tick.
//
// Rule 2 uses the frozen PhysicsPort writes and, when present, Rapier's optional body-hold extension for zero-gravity sleep.
// Ports without that extension retain the write-and-rehold fallback.
import type { CoreKernel } from '../kernel.ts';
import { ENGINE } from '../rules.ts';
import { copyVec3, isCameraAttached, writeAngularVelocity, writeFeetPosition, writeVelocity } from '../store/transform.ts';
import type { OutOfBoundsEvent, PlaceId, RowRec, Vec3 } from '../types.ts';

export type BoundsKernel = Pick<CoreKernel, 'store' | 'ports' | 'time' | 'on'>;

/** what the rule reads from the place manager */
export interface BoundsPlaces {
  readonly active: PlaceId | null;
  bottom(p: PlaceId): number;
  spawnPoint(p: PlaceId): Vec3;
}

const zero = (): Vec3 => ({ x: 0, y: 0, z: 0 });

/** the body kind of a row (`physics: 'dynamic'` or `{ body: 'dynamic', … }`), null for a row without a body */
export function bodyKind(row: RowRec): string | null {
  const p = row.props['physics'];
  const kind = typeof p === 'string' ? p : typeof p === 'object' && p !== null ? (p as { body?: unknown }).body : null;
  return typeof kind === 'string' && kind !== 'none' ? kind : null;
}

function hasHook(row: RowRec): boolean {
  for (const inst of row.behaviors) if (typeof inst.module?.onOutOfBounds === 'function') return true;
  return false;
}

export class WorldBounds {
  readonly #k: BoundsKernel;
  readonly #places: BoundsPlaces;
  readonly #warn: (message: string) => void;
  /** rows that fell and have not come back above bottom + 1 m */
  readonly #latched = new Set<RowRec>();
  readonly #off: () => void;

  constructor(k: BoundsKernel, places: BoundsPlaces, warn: (message: string) => void) {
    this.#k = k;
    this.#places = places;
    this.#warn = warn;
    this.#off = k.on('rowDestroyed', (row) => void this.#latched.delete(row));
  }

  /** rows latched now */
  get latched(): number {
    return this.#latched.size;
  }

  dispose(): void {
    this.#off();
    this.#latched.clear();
  }

  /** tick step E, after the physics writeback */
  run(): void {
    const place = this.#places.active;
    if (place === null) return;
    const bottom = this.#places.bottom(place);
    if (!Number.isFinite(bottom)) return;
    const rearm = bottom + ENGINE.OOB_RELATCH_M;
    const latched = this.#latched;
    // first pass over the live index: only reads (the hooks below may spawn, destroy and move rows)
    let below: RowRec[] | null = null;
    for (const row of this.#k.store.byPlace(place)) {
      if (row.parentId !== null) continue;
      const y = row.tf.pos.y;
      if (y < bottom) (below ??= []).push(row);
      else if (y > rearm && latched.size > 0) latched.delete(row);
    }
    if (below === null) return;
    let spawn: Vec3 | null = null;
    for (const row of below) {
      if (row.phase !== 'alive' || row.place !== place || row.pendingSpawnHooks || isCameraAttached(row)) continue;
      const kind = bodyKind(row);
      if (kind === null || kind === 'static') continue;
      if (latched.has(row)) {
        // still under the plane: a held body that sank again is held again (rule 2), everything else waits for the re-arm
        if (kind === 'dynamic' && !hasHook(row)) this.#hold(row, bottom);
        continue;
      }
      latched.add(row);
      spawn ??= this.#places.spawnPoint(place);
      if (hasHook(row)) this.#callHooks(row, place, bottom, spawn);
      else if (kind === 'dynamic') {
        this.#hold(row, bottom);
        this.#warn(`${row.id} out of bounds: held at bottom`);
      } else this.#respawn(row, spawn);
    }
  }

  /** rule 1: guarded like every carried hook (D-CORE-15) */
  #callHooks(row: RowRec, place: PlaceId, bottom: number, spawn: Vec3): void {
    const inv = this.#k.time.invoker;
    for (const inst of row.behaviors) {
      if (row.phase !== 'alive') break;
      const f = inst.module?.onOutOfBounds;
      if (typeof f !== 'function') continue;
      const ev: OutOfBoundsEvent = { bottom, position: copyVec3(row.tf.pos), placeId: place, respawnPoint: copyVec3(spawn) };
      inv.call({ kind: 'row', row, inst }, 'onOutOfBounds', f, [inst.ctx, ev], inst.module);
    }
  }

  /** rule 2: an engine writeback (no wake, no change record) plus the port's teleport */
  #hold(row: RowRec, bottom: number): void {
    const p = { x: row.tf.pos.x, y: bottom, z: row.tf.pos.z };
    this.#k.store.engineWriteTransform(row, p, zero(), row.tf.grounded, undefined, zero());
    const physics = this.#k.ports.physics;
    physics.setPosition(row, copyVec3(p));
    physics.setVelocity(row, zero());
    physics.setAngularVelocity(row, zero());
    (physics as typeof physics & { holdBody?: (row: RowRec, y: number) => void }).holdBody?.(row, bottom);
  }

  /** rule 3: a teleport (the writes reach the physics port and wake the row's sleepers) */
  #respawn(row: RowRec, spawn: Vec3): void {
    const store = this.#k.store;
    if (!writeFeetPosition(store, row, copyVec3(spawn), undefined)) this.#k.ports.physics.setPosition(row, copyVec3(row.tf.pos));
    store.restartInterpolation(row);
    writeVelocity(store, row, zero(), undefined);
    writeAngularVelocity(store, row, zero(), undefined);
  }
}
