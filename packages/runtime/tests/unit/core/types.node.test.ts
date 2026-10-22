// The public types stay implementable the way the later packages implement them (checked by `tsc -b` on this file, run by
// vitest): the handle is a class with prototype accessors for every engine field (core §3.3, WP C1a), the clock a class
// (core §9.1, WP C2). Under exactOptionalPropertyTypes an optional member cannot be served by a getter that returns
// undefined, which is why ObjectView types such fields `T | undefined`.
import { describe, expect, it } from 'vitest';
import type {
  BehaviorHookHealth,
  ObjectView,
  PauseReason,
  PlayerView,
  PositionSpec,
  RigView,
  Rotation,
  RotationSpec,
  RowId,
  SimClock,
  UiCtx,
  Vec3,
} from '../../../src/compat/core/types.ts';

/** never called: `tsc -b` checks that the UI realm's handles reject writes (core §3.3: setters are no-ops there, §7.5) */
function uiHandlesAreReadOnly(ui: UiCtx): void {
  const self = ui.self;
  if (self) {
    // @ts-expect-error a UI handle is read-only
    self.visible = false;
    // @ts-expect-error a UI handle is read-only
    self.state = {};
  }
  const other = ui.getObject('gf-door-1');
  // @ts-expect-error a UI handle is read-only, ObjectProperties fields included
  if (other) other.light = { intensity: 0 };
}

class HandleSketch implements ObjectView {
  [field: string]: unknown;
  readonly id: RowId;
  readonly tags: readonly string[] = [];
  readonly name: string | null = null;
  readonly audience = 'near' as const;
  readonly scope = 'session' as const;
  readonly visibility: 'owner' | 'platform' | null = null;
  readonly retention = 'current' as const;
  readonly simulatedBy: 'platform' | null = null;
  readonly place: string | null = 'gallow-farm';
  readonly grounded = false;
  readonly sleeping: boolean | null = null;
  readonly awake: boolean | null = null;
  readonly forces: Record<string, unknown> = {};
  readonly controller: string | null = null;
  readonly controlling: ObjectView | null = null;
  spectating = false;
  #pos: Vec3 = { x: 0, y: 0, z: 0 };
  #yaw = 0;
  constructor(id: RowId) {
    this.id = id;
  }
  get objectId(): string {
    return `world:#${this.id}`;
  }
  get template(): string | undefined {
    return undefined;
  }
  get lifetime(): number | undefined {
    return undefined;
  }
  get userId(): string | null | undefined {
    return undefined;
  }
  get behaviorHealth(): { broken: BehaviorHookHealth[] } | undefined {
    return undefined;
  }
  get state(): Record<string, unknown> {
    return {};
  }
  set state(_v: Record<string, unknown>) {}
  get feetPosition(): Vec3 {
    return { ...this.#pos };
  }
  set feetPosition(p: PositionSpec) {
    if ('z' in p && typeof p.x === 'number') this.#pos = { x: p.x, y: typeof p.y === 'number' ? p.y : 0, z: p.z };
  }
  get worldFeetPosition(): Vec3 {
    return { ...this.#pos };
  }
  get rotation(): Rotation {
    return { yaw: this.#yaw, pitch: 0, roll: 0 };
  }
  set rotation(r: RotationSpec) {
    if (typeof r === 'number') this.#yaw = r;
  }
  get yaw(): number {
    return this.#yaw;
  }
  set yaw(d: number) {
    this.#yaw = d;
  }
  get scale(): number | Vec3 {
    return 1;
  }
  set scale(_s: number | Vec3) {}
  get effectiveScale(): Vec3 | undefined {
    return undefined;
  }
  get bounds(): { min: Vec3; max: Vec3 } | undefined {
    return undefined;
  }
  get velocity(): Vec3 {
    return { x: 0, y: 0, z: 0 };
  }
  set velocity(_v: Vec3) {}
  get angularVelocity(): Vec3 {
    return { x: 0, y: 0, z: 0 };
  }
  set angularVelocity(_v: Vec3) {}
  get visible(): boolean {
    return true;
  }
  set visible(_v: boolean) {}
  get parent(): ObjectView | null {
    return null;
  }
  set parent(_p: RowId | ObjectView | null) {}
  get children(): ObjectView[] {
    return [];
  }
  get behavior(): string[] {
    return [];
  }
}

class ClockSketch implements SimClock {
  tick = 0;
  readonly #reasons = new Set<PauseReason>(['boot']);
  now(): number {
    return 1_000_000 + (this.tick * 1000) / 30;
  }
  get running(): boolean {
    return this.#reasons.size === 0;
  }
  get reasons(): ReadonlySet<PauseReason> {
    return this.#reasons;
  }
  pause(r: PauseReason): void {
    this.#reasons.add(r);
  }
  resume(r: PauseReason): void {
    this.#reasons.delete(r);
  }
}

describe('core types are implementable as the later packages implement them', () => {
  it('a class with prototype accessors is an ObjectView; writes take the spec forms, reads give snapshots', () => {
    const h: ObjectView = new HandleSketch('gf-door-1');
    h.feetPosition = { x: 1, y: 2, z: 3 };
    h.feetPosition = { x: 4, z: 5, y: 'surface' };
    h.rotation = 90;
    h.rotation = { lookAt: { x: 0, y: 0, z: 0 } };
    expect(h.feetPosition).toEqual({ x: 4, y: 0, z: 5 });
    expect(h.rotation.yaw).toBe(90);
    expect(h.behaviorHealth).toBe(undefined);
    expect(h.objectId).toBe('world:#gf-door-1');
  });

  it('the UI realm types its handles read-only (checked at compile time)', () => {
    expect(typeof uiHandlesAreReadOnly).toBe('function');
  });

  it('player and rig views are object views', () => {
    const asView = (v: PlayerView | RigView): ObjectView => v;
    expect(typeof asView).toBe('function');
  });

  it('a class is a SimClock', () => {
    const c: SimClock = new ClockSketch();
    expect(c.running).toBe(false);
    c.resume('boot');
    expect(c.running).toBe(true);
    expect(c.now()).toBe(1_000_000);
  });
});
