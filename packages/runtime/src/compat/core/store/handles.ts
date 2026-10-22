// Handles (docs/design/core-runtime.md §3.3, §3.5, §5.8, §7.4, §10.3; contract §3.4-3.5): the ObjectView game code gets from
// `ctx.self`, `getObject`, `query`, `world.players`. A class with prototype accessors for every engine field (no Proxy on the hot
// path): record fields read from the record and ignore writes; `state` and object-valued properties are write-through proxies
// (proxies.ts); transforms are fresh snapshots and whole writes (transform.ts); every other ObjectProperties field goes through
// its channel (channels.ts). Game modules are strict-mode code, so every field has a setter: a write to a read-only field is
// ignored (counted, dev warning) instead of throwing.
//
// - One handle per (row, VM) and one for the UI realm, cached on the record. A handle stays valid after its row dies: reads
//   return the last values, writes are ignored with a dev warning (`write to dead row <id>.<field>`).
// - The UI realm's handle is the same class, read-only: every setter and every proxy write is a no-op (core §3.3, §7.5).
// - An unknown field write (`h.foo = 1`) sets nothing in the engine: it lands on the instance as an own property. Dev builds wrap
//   the handle in a logging Proxy that reports it once per (script, field).
// - Per VM (core §10.3): `isLocal` is true read from the client VM (and the UI page, which reads through it); X-24: a platform-VM
//   read of `children` leaves out client-made `audience: 'local'` rows; a write through another VM's handle is counted.
import { objectIdOf } from '../ids.ts';
import type {
  BehaviorHookHealth,
  ObjectView,
  PlaceId,
  PlayerLookEntry,
  PlayerView,
  PositionSpec,
  RigView,
  RotationSpec,
  Rotation,
  RowId,
  RowRec,
  TemplateRef,
  Vec3,
} from '../types.ts';
import { cloneWire, deepEqualWire } from '../wire.ts';
import {
  BAG_FIELDS,
  commitWrite,
  equalWrite,
  fieldView,
  PROP_FIELDS,
  propValue,
  stateProxy,
  writeProp,
  type Realm,
  type StoreCore,
} from './proxies.ts';
import {
  copyVec3,
  reparent,
  rotationOf,
  scaleValue,
  worldPose,
  writeAngularVelocity,
  writeFeetPosition,
  writeRotation,
  writeScale,
  writeVelocity,
  writeYaw,
} from './transform.ts';

interface Core {
  readonly store: StoreCore;
  readonly row: RowRec;
  readonly realm: Realm;
}

/** handle (and its dev proxy) → record, for rowOf */
const ROWS = new WeakMap<object, { readonly row: RowRec; readonly store: StoreCore }>();

/** the record behind a handle (of `store` when given), else null */
export function rowOf(handle: unknown, store?: StoreCore): RowRec | null {
  const hit = typeof handle === 'object' && handle !== null ? ROWS.get(handle) : undefined;
  return hit !== undefined && (store === undefined || hit.store === store) ? hit.row : null;
}

/** a write is allowed: not through the UI realm, not to a dead row (both counted) */
function canWrite(c: Core, field: string): boolean {
  if (c.realm === 'ui') {
    c.store.readonlyWrite(c.row, field);
    return false;
  }
  if (c.row.phase !== 'alive') {
    c.store.deadWrite(c.row, field);
    return false;
  }
  return true;
}

function ignore(c: Core, field: string): void {
  c.store.ignoredWrite(c.row, field);
}

/** `spectating` (core §5.8): the body stops colliding and its devices are blocked; sendAction data channels still pass (X-15) */
function writeSpectating(c: Core, value: unknown): void {
  const on = Boolean(value);
  const row = c.row;
  if (row.spectating === on) {
    equalWrite(c.store, row, 'spectating', [], on, on);
    return;
  }
  c.store.channels.willWrite(row, 'spectating');
  row.spectating = on;
  c.store.ports.physics.setSpectating(row, on);
  if (row.player !== null) c.store.ports.input.setBlocked('body', on);
  commitWrite(c.store, row, 'spectating', [], on, !on, c.realm);
}

/** ext.rowSession: the per-row scratch bags, gone with the row */
const ROW_SESSIONS = new WeakMap<RowRec, Record<string, unknown>>();
function rowSessionOf(row: RowRec): Record<string, unknown> {
  let bag = ROW_SESSIONS.get(row);
  if (bag === undefined) ROW_SESSIONS.set(row, (bag = {}));
  return bag;
}

export class RowHandle implements ObjectView {
  [field: string]: unknown;
  readonly #c: Core;

  constructor(core: Core) {
    this.#c = core;
    // ext.rowSession: an own accessor, so a store without the extension keeps the handle shape (and unknown-field writes) of the base runtime
    if (core.store.rowSession === true) {
      const row = core.row;
      Object.defineProperty(this, 'session', {
        configurable: true,
        enumerable: false,
        get: () => rowSessionOf(row),
        set: (v: unknown) => {
          if (core.realm !== 'ui' && typeof v === 'object' && v !== null && !Array.isArray(v)) ROW_SESSIONS.set(row, v as Record<string, unknown>);
        },
      });
    }
  }

  /** @internal the store, record and realm behind a handle instance (not its dev proxy) */
  static coreOf(h: RowHandle): Core {
    return h.#c;
  }

  // ── record fields (read-only) ──────────────────────────────────────────────────────────────────────────────────────
  get id(): RowId {
    return this.#c.row.id;
  }
  set id(_v: unknown) {
    ignore(this.#c, 'id');
  }
  get tags(): readonly string[] {
    return this.#c.row.tags;
  }
  set tags(_v: unknown) {
    ignore(this.#c, 'tags');
  }
  get template(): TemplateRef | undefined {
    return this.#c.row.template ?? undefined;
  }
  set template(_v: unknown) {
    ignore(this.#c, 'template');
  }
  get name(): string | null {
    return this.#c.row.name;
  }
  set name(_v: unknown) {
    ignore(this.#c, 'name');
  }
  get audience(): 'near' | 'all' | 'local' {
    return this.#c.row.audience;
  }
  set audience(_v: unknown) {
    ignore(this.#c, 'audience');
  }
  get scope(): 'session' | 'world' {
    return this.#c.row.scope;
  }
  set scope(_v: unknown) {
    ignore(this.#c, 'scope');
  }
  get visibility(): 'owner' | 'platform' | null {
    return this.#c.row.visibility;
  }
  set visibility(_v: unknown) {
    ignore(this.#c, 'visibility');
  }
  get retention(): 'current' {
    return 'current';
  }
  set retention(_v: unknown) {
    ignore(this.#c, 'retention');
  }
  get objectId(): string {
    return objectIdOf(this.#c.row.id, this.#c.store.worldId ?? null);
  }
  set objectId(_v: unknown) {
    ignore(this.#c, 'objectId');
  }
  get simulatedBy(): 'platform' | null {
    return this.#c.row.simulatedBy;
  }
  set simulatedBy(_v: unknown) {
    ignore(this.#c, 'simulatedBy');
  }
  get lifetime(): number | undefined {
    return this.#c.row.lifetimeS ?? undefined;
  }
  set lifetime(_v: unknown) {
    ignore(this.#c, 'lifetime');
  }
  /** use ctx.cross to move a row between places */
  get place(): PlaceId | null {
    return this.#c.row.place;
  }
  set place(_v: unknown) {
    ignore(this.#c, 'place');
  }

  // ── state ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  get state(): Record<string, unknown> {
    const c = this.#c;
    return stateProxy(c.store, c.row, c.realm);
  }
  set state(v: Record<string, unknown>) {
    const c = this.#c;
    if (canWrite(c, 'state')) writeProp(c.store, c.row, 'state', [], v, c.realm);
  }

  // ── transforms (snapshots; whole writes) ───────────────────────────────────────────────────────────────────────────
  get feetPosition(): Vec3 {
    return copyVec3(this.#c.row.tf.pos);
  }
  set feetPosition(p: PositionSpec) {
    const c = this.#c;
    if (canWrite(c, 'feetPosition')) writeFeetPosition(c.store, c.row, p, c.realm);
  }
  get worldFeetPosition(): Vec3 {
    const c = this.#c;
    return copyVec3(worldPose(c.store, c.row).pos);
  }
  set worldFeetPosition(_v: unknown) {
    ignore(this.#c, 'worldFeetPosition');
  }
  get rotation(): Rotation {
    return rotationOf(this.#c.row.tf);
  }
  set rotation(r: RotationSpec) {
    const c = this.#c;
    if (canWrite(c, 'rotation')) writeRotation(c.store, c.row, r, c.realm);
  }
  get yaw(): number {
    return rotationOf(this.#c.row.tf).yaw;
  }
  set yaw(d: number) {
    const c = this.#c;
    if (canWrite(c, 'rotation')) writeYaw(c.store, c.row, d, c.realm);
  }
  get scale(): number | Vec3 {
    return scaleValue(this.#c.row.tf.scale);
  }
  set scale(s: number | Vec3) {
    const c = this.#c;
    if (canWrite(c, 'scale')) writeScale(c.store, c.row, s, c.realm);
  }
  /** world scale; undefined on a `simulatedBy: "platform"` row (LIVE authored module) */
  get effectiveScale(): Vec3 | undefined {
    const c = this.#c;
    return c.row.simulatedBy === 'platform' ? undefined : copyVec3(worldPose(c.store, c.row).scale);
  }
  set effectiveScale(_v: unknown) {
    ignore(this.#c, 'effectiveScale');
  }
  /** world AABB from the render port; undefined until the model is measured */
  get bounds(): { min: Vec3; max: Vec3 } | undefined {
    const c = this.#c;
    const b = c.store.ports.scene.bounds(c.row);
    return b ? { min: copyVec3(b.min), max: copyVec3(b.max) } : undefined;
  }
  set bounds(_v: unknown) {
    ignore(this.#c, 'bounds');
  }
  get velocity(): Vec3 {
    return copyVec3(this.#c.row.tf.vel);
  }
  set velocity(v: Vec3) {
    const c = this.#c;
    if (canWrite(c, 'velocity')) writeVelocity(c.store, c.row, v, c.realm);
  }
  get angularVelocity(): Vec3 {
    return copyVec3(this.#c.row.tf.angVel);
  }
  set angularVelocity(v: Vec3) {
    const c = this.#c;
    if (canWrite(c, 'angularVelocity')) writeAngularVelocity(c.store, c.row, v, c.realm);
  }
  get grounded(): boolean {
    return this.#c.row.tf.grounded;
  }
  set grounded(_v: unknown) {
    ignore(this.#c, 'grounded');
  }
  /** the physics port exposes no body sleep state (motion §5.1) and no live code reads it: null, as for a row without a body */
  get sleeping(): boolean | null {
    return null;
  }
  set sleeping(_v: unknown) {
    ignore(this.#c, 'sleeping');
  }
  get awake(): boolean | null {
    return null;
  }
  set awake(_v: unknown) {
    ignore(this.#c, 'awake');
  }
  /** a live map: `o.forces.surge = {force} | null` (scripts/gore/gore.js:530); each key goes to the physics port */
  get forces(): Record<string, unknown> {
    const c = this.#c;
    return fieldView(c.store, c.row, 'forces', c.realm);
  }
  set forces(v: Record<string, unknown>) {
    const c = this.#c;
    if (canWrite(c, 'forces')) writeProp(c.store, c.row, 'forces', [], v, c.realm);
  }
  get visible(): boolean {
    const v = this.#c.row.props.visible;
    return v === undefined ? true : (v as boolean);
  }
  set visible(v: boolean) {
    const c = this.#c;
    if (canWrite(c, 'visible')) writeProp(c.store, c.row, 'visible', [], v, c.realm);
  }

  // ── hierarchy ──────────────────────────────────────────────────────────────────────────────────────────────────────
  get parent(): ObjectView | null {
    const c = this.#c;
    const id = c.row.parentId;
    const p = id !== null ? c.store.get(id) : undefined;
    // a dead row's parent id may since name a newer row
    if (!p || (c.row.phase !== 'alive' && p.serial > c.row.serial)) return null;
    return handleFor(c.store, p, c.realm);
  }
  /** re-parents and keeps the world pose (no live writer) */
  set parent(p: RowId | ObjectView | null) {
    const c = this.#c;
    if (canWrite(c, 'parent')) reparent(c.store, c.row, p, c.realm);
  }
  /** direct children in serial order (incl. local child rows, AGENTS.md:162); X-24 on the platform VM */
  get children(): ObjectView[] {
    const c = this.#c;
    if (c.row.phase !== 'alive') return [];
    const out: ObjectView[] = [];
    for (const k of c.store.childrenOf(c.row.id)) {
      if (c.realm === 'platform' && k.vm === 'client' && k.audience === 'local') continue;
      out.push(handleFor(c.store, k, c.realm));
    }
    return out;
  }
  set children(_v: unknown) {
    ignore(this.#c, 'children');
  }

  // ── behaviors ──────────────────────────────────────────────────────────────────────────────────────────────────────
  get behavior(): string[] {
    return this.#c.row.behaviors.map((b) => b.path);
  }
  set behavior(_v: unknown) {
    ignore(this.#c, 'behavior');
  }
  get behaviorHealth(): { broken: BehaviorHookHealth[] } | undefined {
    const broken: BehaviorHookHealth[] = [];
    for (const b of this.#c.row.behaviors) for (const h of b.health.values()) broken.push({ ...h });
    return broken.length > 0 ? { broken } : undefined;
  }
  set behaviorHealth(_v: unknown) {
    ignore(this.#c, 'behaviorHealth');
  }

  // ── players and control ────────────────────────────────────────────────────────────────────────────────────────────
  get spectating(): boolean {
    return this.#c.row.spectating;
  }
  set spectating(on: boolean) {
    const c = this.#c;
    if (canWrite(c, 'spectating')) writeSpectating(c, on);
  }
  get controller(): string | null {
    return null;
  }
  set controller(_v: unknown) {
    ignore(this.#c, 'controller');
  }
  get controlling(): ObjectView | null {
    return null;
  }
  set controlling(_v: unknown) {
    ignore(this.#c, 'controlling');
  }
  /** player rows only; null on any other row (contract §1.4) */
  get userId(): string | null | undefined {
    const p = this.#c.row.player;
    return p !== null ? p.userId : null;
  }
  set userId(_v: unknown) {
    ignore(this.#c, 'userId');
  }
}

// every other ObjectProperties field: a channel view / write-through proxy on read, a channel write on assignment
for (const field of PROP_FIELDS) {
  Object.defineProperty(RowHandle.prototype, field, {
    configurable: true,
    enumerable: false,
    get(this: RowHandle): unknown {
      const c = RowHandle.coreOf(this);
      if (BAG_FIELDS.has(field) || c.store.channels.reader(field) !== undefined) return fieldView(c.store, c.row, field, c.realm);
      return propValue(c.store, c.row, field, c.realm);
    },
    set(this: RowHandle, v: unknown): void {
      const c = RowHandle.coreOf(this);
      if (canWrite(c, field)) writeProp(c.store, c.row, field, [], v, c.realm);
    },
  });
}

/** the human body (core §3.5, §5.8): its PlayerRec's identity, per-VM isLocal, the look stack */
export class PlayerHandle extends RowHandle implements PlayerView {
  override get userId(): string {
    return RowHandle.coreOf(this).row.player!.userId;
  }
  override set userId(_v: unknown) {
    ignore(RowHandle.coreOf(this), 'userId');
  }
  get displayName(): string {
    return RowHandle.coreOf(this).row.player!.displayName;
  }
  set displayName(_v: unknown) {
    ignore(RowHandle.coreOf(this), 'displayName');
  }
  /** true read from the client VM and the UI page; false from the platform VM (core §10.3) */
  get isLocal(): boolean {
    return RowHandle.coreOf(this).realm !== 'platform';
  }
  set isLocal(_v: unknown) {
    ignore(RowHandle.coreOf(this), 'isLocal');
  }
  override get controlling(): null {
    return null;
  }
  override set controlling(_v: unknown) {
    ignore(RowHandle.coreOf(this), 'controlling');
  }
  get portraitUrl(): null {
    return null;
  }
  get isEditor(): false {
    return false;
  }
  get isGodMode(): false {
    return false;
  }
  get party(): null {
    return null;
  }
  get guild(): null {
    return null;
  }
  get latencyMs(): 0 {
    return 0;
  }
  get inputHeld(): false {
    return false;
  }
  /** the player look stack (contract §19): `me.look.push(entry)`, `entry.intensity = v`, `me.look = [...]` */
  get look(): PlayerLookEntry[] {
    const c = RowHandle.coreOf(this);
    const p = c.row.player!;
    if (!Array.isArray(p.look)) p.look = [];
    return propValue(c.store, c.row, 'look', c.realm) as PlayerLookEntry[];
  }
  set look(v: PlayerLookEntry[]) {
    const c = RowHandle.coreOf(this);
    if (canWrite(c, 'look')) writeProp(c.store, c.row, 'look', [], v, c.realm);
  }
}
for (const k of ['portraitUrl', 'isEditor', 'isGodMode', 'party', 'guild', 'latencyMs', 'inputHeld'] as const) {
  const get = Object.getOwnPropertyDescriptor(PlayerHandle.prototype, k)!.get!;
  Object.defineProperty(PlayerHandle.prototype, k, {
    configurable: true,
    enumerable: false,
    get,
    set(this: RowHandle) {
      ignore(RowHandle.coreOf(this), k);
    },
  });
}

/** a rig layer field: a snapshot read (objects copied), a whole write into the rig's own layer */
function rigRead(h: RowHandle, field: string): unknown {
  const v = RowHandle.coreOf(h).row.rig!.layer.read()[field];
  return v !== null && typeof v === 'object' ? cloneWire(v) : v;
}
function rigWrite(h: RowHandle, field: string, value: unknown): void {
  const c = RowHandle.coreOf(h);
  if (!canWrite(c, field)) return;
  const layer = c.row.rig!.layer;
  const old = layer.read()[field];
  const v = cloneWire(value);
  if (deepEqualWire(old, v)) {
    equalWrite(c.store, c.row, field, [], v, old);
    return;
  }
  c.store.channels.willWrite(c.row, field);
  if (v === undefined) layer.delete([field]);
  else layer.set([field], v);
  commitWrite(c.store, c.row, field, [], v, cloneWire(old), c.realm);
}

/** the camera rig's ctx.self (core §7.4, contract §11.2): the layer fields over the camera def, the target body, the view */
export class RigHandle extends RowHandle implements RigView {
  /** the body the rig follows (its handle has effectiveScale) */
  get target(): (ObjectView & { readonly effectiveScale: Vec3 | undefined }) | null {
    const c = RowHandle.coreOf(this);
    const id = c.row.rig!.targetId;
    const t = id !== null ? c.store.get(id) : undefined;
    return t ? handleFor(c.store, t, c.realm) : null;
  }
  set target(_v: unknown) {
    ignore(RowHandle.coreOf(this), 'target');
  }
  /** `{yaw, pitch}` radians presented by the camera port; undefined before frame 1 */
  get view(): { yaw: number; pitch: number } | undefined {
    const v = RowHandle.coreOf(this).store.ports.camera.view();
    return v ? { yaw: v.yaw, pitch: v.pitch } : undefined;
  }
  set view(_v: unknown) {
    ignore(RowHandle.coreOf(this), 'view');
  }
  get fov(): number | undefined {
    return rigRead(this, 'fov') as number | undefined;
  }
  set fov(v: number | undefined) {
    rigWrite(this, 'fov', v);
  }
  /** per tick (the rig host clears it before each step) */
  get hideLocalPlayer(): boolean {
    return rigRead(this, 'hideLocalPlayer') === true;
  }
  set hideLocalPlayer(v: boolean) {
    rigWrite(this, 'hideLocalPlayer', v);
  }
  get clip(): { near?: number; far?: number } | null | undefined {
    return rigRead(this, 'clip') as { near?: number; far?: number } | null | undefined;
  }
  set clip(v: { near?: number; far?: number } | null | undefined) {
    rigWrite(this, 'clip', v);
  }
  get orientation(): { source: 'look' | 'script'; authoredAxes?: unknown } | undefined {
    return rigRead(this, 'orientation') as { source: 'look' | 'script'; authoredAxes?: unknown } | undefined;
  }
  set orientation(v: { source: 'look' | 'script'; authoredAxes?: unknown } | undefined) {
    rigWrite(this, 'orientation', v);
  }
  get pointerLock(): boolean | 'drag' | undefined {
    return rigRead(this, 'pointerLock') as boolean | 'drag' | undefined;
  }
  set pointerLock(v: boolean | 'drag' | undefined) {
    rigWrite(this, 'pointerLock', v);
  }
  get sensitivity(): number | undefined {
    return rigRead(this, 'sensitivity') as number | undefined;
  }
  set sensitivity(v: number | undefined) {
    rigWrite(this, 'sensitivity', v);
  }
  get pixelSnap(): unknown {
    return rigRead(this, 'pixelSnap');
  }
  set pixelSnap(v: unknown) {
    rigWrite(this, 'pixelSnap', v);
  }
}

/** dev builds: report unknown field writes (the engine fields are accessors on the prototype chain) */
function devHandle(inst: RowHandle, c: Core): RowHandle {
  const proto: object = Object.getPrototypeOf(inst);
  return new Proxy(inst, {
    get: (t, k) => Reflect.get(t, k, t),
    set: (t, k, v) => {
      if (typeof k === 'string' && !(k in proto)) c.store.unknownFieldWrite(c.row, k);
      return Reflect.set(t, k, v, t);
    },
  });
}

/** the cached handle of a row for a VM or the UI realm (core §3.3): a RigHandle for the rig row, a PlayerHandle for a body */
export function handleFor(store: StoreCore, row: RowRec, realm: Realm): ObjectView {
  const cached = row.handles[realm];
  if (cached) return cached;
  const core: Core = { store, row, realm };
  const inst = row.rig !== null ? new RigHandle(core) : row.player !== null ? new PlayerHandle(core) : new RowHandle(core);
  const h = store.dev ? devHandle(inst, core) : inst;
  ROWS.set(inst, { row, store });
  ROWS.set(h, { row, store });
  row.handles[realm] = h;
  return h;
}
