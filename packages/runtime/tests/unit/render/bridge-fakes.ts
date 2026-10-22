// Stand-ins for the render bridge tests (WP R13): rows that behave like the store's records as the feed shows them, a feed, and
// a bridge wired to the real producers that run without a renderer (R1b's light table, R3's primitive buckets, R0's camera
// presenter).
//
// A `TestRow` keeps the store's two rules the bridge relies on (compat/core/store/transform.ts, store/rows.ts): a transform
// value is never mutated (every write stores a new object), and the tick start shares `prev = cur` for a row that moved.
import { Group, WebGLCoordinateSystem } from 'three/webgpu';
import type { RowFeed, RowSnapshot } from '../../../src/compat/core/ports.ts';
import { eulerYXZToQuat } from '../../../src/compat/core/store/transform.ts';
import type { ObjectSpec, Quat, Vec3 } from '../../../src/compat/core/types.ts';
import { createRenderBridge, type RenderBridgeControl, type RenderBridgeDeps } from '../../../src/render/bridge/render-bridge.ts';
import type { FrameInfo } from '../../../src/render/engine/render-loop.ts';
import { PrimitiveBuckets } from '../../../src/render/geometry/primitives.ts';
import { createLightTable, type LightTableControl } from '../../../src/render/lighting/light-table.ts';
import { createCameraPresenter, type CameraPresenterControl } from '../../../src/render/scene/camera-presenter.ts';
import type { LightingScript } from '../../../src/render/surface/script-types.ts';

export interface RowInit {
  place?: string | null;
  parent?: string | null;
  tags?: string[];
  behavior?: string[];
  pos?: [number, number, number];
  /** degrees */
  yaw?: number;
  pitch?: number;
  roll?: number;
  scale?: number | [number, number, number];
  /** every other field of the row (`light`, `primitive`, `visible`, …) */
  props?: Record<string, unknown>;
  /** spawn-time fields that are not properties (`lifetime`, `template`, `velocity`) */
  spec?: Record<string, unknown>;
}

const v3 = (p: readonly [number, number, number]): Vec3 => ({ x: p[0], y: p[1], z: p[2] });

/** one row as the feed's snapshot shows it */
export class TestRow implements RowSnapshot {
  readonly id: string;
  place: string | null;
  parentId: string | null;
  readonly tags: readonly string[];
  readonly behavior: readonly string[];
  spec: Readonly<ObjectSpec>;
  props: Record<string, unknown>;
  #prevPos: Vec3;
  #prevRot: Quat;
  #pos: Vec3;
  #rot: Quat;
  #scale: Vec3;
  /** `prev` / `cur` reads so far (the feed's view allocates one object per read) */
  reads = 0;

  constructor(id: string, init: RowInit = {}) {
    this.id = id;
    this.place = init.place === undefined ? 'p1' : init.place;
    this.parentId = init.parent ?? null;
    this.tags = init.tags ?? [];
    this.behavior = init.behavior ?? [];
    this.props = { ...(init.props ?? {}) };
    this.spec = { ...this.props, ...(init.spec ?? {}) };
    this.#pos = v3(init.pos ?? [0, 0, 0]);
    this.#rot = eulerYXZToQuat(init.yaw ?? 0, init.pitch ?? 0, init.roll ?? 0);
    const s = init.scale ?? 1;
    this.#scale = typeof s === 'number' ? { x: s, y: s, z: s } : v3(s);
    this.#prevPos = this.#pos;
    this.#prevRot = this.#rot;
  }

  get prev(): { pos: Vec3; rot: Quat } {
    this.reads++;
    return { pos: this.#prevPos, rot: this.#prevRot };
  }
  get cur(): { pos: Vec3; rot: Quat; scale: Vec3 } {
    this.reads++;
    return { pos: this.#pos, rot: this.#rot, scale: this.#scale };
  }

  /** tick step A: prev ← cur */
  roll(): this {
    this.#prevPos = this.#pos;
    this.#prevRot = this.#rot;
    return this;
  }
  /** a transform write of this tick */
  write(t: { pos?: [number, number, number]; yaw?: number; pitch?: number; roll?: number; scale?: number }): this {
    if (t.pos !== undefined) this.#pos = v3(t.pos);
    if (t.yaw !== undefined || t.pitch !== undefined || t.roll !== undefined) this.#rot = eulerYXZToQuat(t.yaw ?? 0, t.pitch ?? 0, t.roll ?? 0);
    if (t.scale !== undefined) this.#scale = { x: t.scale, y: t.scale, z: t.scale };
    return this;
  }
  /** one tick: the roll, then the write */
  tick(t: Parameters<TestRow['write']>[0]): this {
    return this.roll().write(t);
  }
  /** sets `prev` apart from `cur` without a tick (a row seen mid-move) */
  setPrev(pos: [number, number, number], yaw = 0): this {
    this.#prevPos = v3(pos);
    this.#prevRot = eulerYXZToQuat(yaw, 0, 0);
    return this;
  }
  /** a property write: the value is replaced, as the store does */
  set(field: string, value: unknown): this {
    this.props = { ...this.props, [field]: value };
    return this;
  }
}

type Event = { kind: 'added'; row: RowSnapshot } | { kind: 'changed'; row: RowSnapshot; fields: string[] } | { kind: 'removed'; id: string };

/** a feed that delivers what the test queued, in order */
export class TestFeed implements RowFeed {
  #events: Event[] = [];
  drains = 0;

  add(...rows: RowSnapshot[]): this {
    for (const row of rows) this.#events.push({ kind: 'added', row });
    return this;
  }
  change(row: RowSnapshot, ...fields: string[]): this {
    this.#events.push({ kind: 'changed', row, fields });
    return this;
  }
  remove(...ids: string[]): this {
    for (const id of ids) this.#events.push({ kind: 'removed', id });
    return this;
  }
  drain(sink: Parameters<RowFeed['drain']>[0]): void {
    this.drains++;
    const batch = this.#events;
    this.#events = [];
    for (const e of batch) {
      if (e.kind === 'added') sink.added(e.row);
      else if (e.kind === 'changed') sink.changed(e.row, e.fields);
      else sink.removed(e.id);
    }
  }
}

const script: LightingScript = { lighting: (_s, l) => l.ambient };

export interface Rig {
  bridge: RenderBridgeControl;
  feed: TestFeed;
  world: Group;
  camera: CameraPresenterControl;
  lights: LightTableControl;
  buckets: PrimitiveBuckets;
  logs: string[];
  /** one frame at `alpha` */
  frame(alpha?: number, over?: Partial<FrameInfo>): void;
  /** adds rows through the feed and presents them */
  spawn(...rows: TestRow[]): void;
  /** live instances over every bucket */
  instances(): number;
  /** the matrix of the only live instance of the bucket holding `geometryKey` */
  instanceMatrix(geometryKey: string, slot?: number): number[];
}

let frameIndex = 0;

export function frameAt(alpha: number, over: Partial<FrameInfo> = {}): FrameInfo {
  return { now: 1000 + frameIndex * 16, dt: 1 / 60, realDt: 1 / 60, alpha, frameIndex: frameIndex++, paused: false, ...over };
}

/** A bridge over the real light table, primitive buckets and camera presenter. */
export function rig(over: Partial<RenderBridgeDeps> = {}): Rig {
  const world = new Group();
  const camera = createCameraPresenter({ coordinateSystem: () => WebGLCoordinateSystem });
  camera.apply({ eye: { x: 0, y: 1.6, z: 5 }, yaw: 0, pitch: 0, roll: 0, vfovDeg: 58.72 });
  const lights = createLightTable();
  const logs: string[] = [];
  const buckets = new PrimitiveBuckets({ script, parent: world, capacity: 4, log: (m) => logs.push(m) });
  const feed = new TestFeed();
  const bridge = createRenderBridge({ world, camera, lights, primitives: buckets, log: (m) => logs.push(m), ...over });
  bridge.attach(feed);
  const r: Rig = {
    bridge,
    feed,
    world,
    camera,
    lights,
    buckets,
    logs,
    frame(alpha = 1, o = {}) {
      bridge.update(frameAt(alpha, o));
    },
    spawn(...rows) {
      feed.add(...rows);
      r.frame(1);
    },
    instances() {
      return buckets.buckets().reduce((n, b) => n + b.count, 0);
    },
    instanceMatrix(geometryKey, slot = 0) {
      const b = buckets.buckets().find((x) => x.key.startsWith(`${geometryKey}|`));
      if (b === undefined) throw new Error(`no bucket of ${geometryKey}: ${buckets.buckets().map((x) => x.key).join(' ; ')}`);
      return Array.from(b.matrices.subarray(slot * 16, slot * 16 + 16));
    },
  };
  return r;
}

/** asserts two column-major matrices are equal to `eps` */
export function matrixDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0;
  for (let i = 0; i < 16; i++) d = Math.max(d, Math.abs(a[i]! - b[i]!));
  return d;
}
