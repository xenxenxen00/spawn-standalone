import type { TierId } from '../../../../src/render/perf/budget.ts';

export interface Spec {
  readonly script: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly seed?: number;
}

export type Ev =
  | { readonly k: 'emit'; readonly act: number; readonly spec: Spec; readonly origin: [number, number, number] }
  | { readonly k: 'end'; readonly act: number }
  | { readonly k: 'bind'; readonly row: number; readonly spec: Spec }
  | { readonly k: 'restart'; readonly row: number; readonly spec: Spec }
  | { readonly k: 'unbind'; readonly row: number };

export interface Frame {
  readonly dt: number;
  readonly nowMs: number;
  readonly tier: TierId;
  readonly cam: { readonly x: number; readonly y: number; readonly z: number; readonly yaw: number; readonly pitch: number };
  /** node positions this frame (index = row) */
  readonly nodes: ReadonlyArray<readonly [number, number, number]>;
  readonly events: readonly Ev[];
}

export interface Scenario {
  readonly name: string;
  readonly frames: readonly Frame[];
  /** row nodes (the length of every frame's `nodes`) */
  readonly rows: number;
  /** runtime options the scenario needs */
  readonly options: { readonly mobile?: boolean; readonly maxEffects?: number; readonly distort?: boolean; readonly staticRows?: readonly number[] };
}
