// Copied from purge-protocol-web ebab692 (src/app or src/platform, same file name; web-platform.ts is platform/web.ts).
// The deferred scene port (docs/architecture.md X-04, X-14, §3.1, §5.1 steps 7 and 11; core §14 step 2; WP X1).
//
// The kernel boots, loads the home place and runs behind the menu before the render engine exists (`game_ready` comes first,
// X-04). Its `ports.scene` is this object for the whole session: it records `buildPlace` / `activate` until the renderer
// attaches, replays the recording once against the renderer's own `SceneSyncPort`, and from then on forwards every call. The
// kernel keeps one port object, so nothing has to be swapped on `kernel.ports`.
//
//   buildPlace   recorded with its rows (copied: the caller's iterable may be a live view), bake and progress callback. The
//                promise stays pending until the replayed build settles, so `kernel.places.built(p)` and the LOADING gate
//                (X2) wait for the real build. A real build that throws or rejects rejects that promise only
//   activate     recorded in call order (`buildPlace(home)` then `activate(home)`)
//   disposePlace before the replay: the place's recorded build and activations are dropped and the build's promise settles
//                (resolved: the place manager's own build generation reports "unloaded during its render build"); the real
//                port never hears of a place it never built
//   bounds       undefined, `socket` null, until the renderer answers them
//   attach       the replay happens once. A later `attach` (another facade after a rebuild, X3) only changes the target
import type { PlaceBake, SceneSyncPort } from '../compat/core/ports.ts';
import type { PlaceId, RowId, RowRec, Vec3 } from '../compat/core/types.ts';

type Recorded =
  | { kind: 'build'; place: PlaceId; rows: RowRec[]; bake: PlaceBake; onProgress: (f: number) => void; resolve: () => void; reject: (e: unknown) => void }
  | { kind: 'activate'; place: PlaceId };

export class DeferredScenePort implements SceneSyncPort {
  #real: SceneSyncPort | null = null;
  #recorded: Recorded[] = [];

  /** the renderer's port once attached */
  get target(): SceneSyncPort | null {
    return this.#real;
  }

  get attached(): boolean {
    return this.#real !== null;
  }

  /** recorded builds not yet handed to a renderer */
  get pending(): number {
    let n = 0;
    for (const r of this.#recorded) if (r.kind === 'build') n++;
    return n;
  }

  buildPlace(place: PlaceId, rows: Iterable<RowRec>, bake: PlaceBake, onProgress: (f: number) => void): Promise<void> {
    if (this.#real !== null) return this.#real.buildPlace(place, rows, bake, onProgress);
    return new Promise<void>((resolve, reject) => {
      this.#recorded.push({ kind: 'build', place, rows: [...rows], bake, onProgress, resolve, reject });
    });
  }

  disposePlace(place: PlaceId): void {
    if (this.#real !== null) {
      this.#real.disposePlace(place);
      return;
    }
    const kept: Recorded[] = [];
    for (const r of this.#recorded) {
      if (r.place !== place) kept.push(r);
      else if (r.kind === 'build') r.resolve();
    }
    this.#recorded = kept;
  }

  activate(place: PlaceId): void {
    if (this.#real !== null) this.#real.activate(place);
    else this.#recorded.push({ kind: 'activate', place });
  }

  bounds(row: RowRec): { min: Vec3; max: Vec3 } | undefined {
    return this.#real?.bounds(row);
  }

  socket(rowId: RowId, name: string): { position: Vec3; direction: Vec3; confidence: number } | null {
    return this.#real?.socket(rowId, name) ?? null;
  }

  /** The renderer exists: replay the recording (first call only), then forward. */
  attach(real: SceneSyncPort): void {
    const first = this.#real === null;
    this.#real = real;
    if (!first) return;
    const recorded = this.#recorded;
    this.#recorded = [];
    for (const r of recorded) {
      if (r.kind === 'activate') {
        try {
          real.activate(r.place);
        } catch (e) {
          console.error(`[scene] activate(${r.place}) failed in the replay`, e);
        }
        continue;
      }
      let run: Promise<void>;
      try {
        run = Promise.resolve(real.buildPlace(r.place, r.rows, r.bake, r.onProgress));
      } catch (e) {
        run = Promise.reject(e);
      }
      run.then(r.resolve, r.reject);
    }
  }
}
