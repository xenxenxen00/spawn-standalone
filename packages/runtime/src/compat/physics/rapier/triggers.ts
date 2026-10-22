// Sensors and their enter list (motion §5.7). A `{body: 'static', trigger: true}` row (the range's portal,
// `authored module`) is a fixed collider with `setSensor(true)`, `ActiveEvents.COLLISION_EVENTS` and
// `ActiveCollisionTypes.DEFAULT | KINEMATIC_FIXED`: characters are kinematic bodies, and the default types do not pair a
// kinematic body with a fixed collider, so without the second flag nobody would ever enter.
//
// world.ts drains the event queue after every substep (and after a refresh step) into `onEvent`. `started` with a
// character or a dynamic body makes one `{trigger, other}` enter; the pair then counts as overlapping until Rapier reports
// its end (`started = false`, tracked for state only: `onTriggerExit` is exported by no live file) or one of the two rows
// leaves the world or stops colliding (spectating). So an overlap yields exactly one enter, however many substeps it lasts.
// Timing: an overlap created by a kinematic move is reported one step later; with two substeps per tick the enter lands in
// the same tick or the next one.
//
// Sensors are invisible to rays and to the controller (`QueryFilterFlags.EXCLUDE_SENSORS`, rapier/query.ts, defaults.ts).
import type { OwnerRecord } from './colliders.ts';
import type { PhysicsWorld } from './world.ts';

export interface TriggerEnter { trigger: string; other: string }

export class TriggerTracker {
  private readonly world: PhysicsWorld;
  /** `<trigger>\n<other>` → overlapping collider pairs of the two rows */
  private readonly overlaps = new Map<string, number>();
  private enters: TriggerEnter[] = [];
  /** enters seen in all (soak counter) */
  total = 0;

  constructor(world: PhysicsWorld) {
    this.world = world;
    world.onCollisionEvent = (a, b, started) => this.onEvent(a, b, started);
  }

  /** make a sensor collider report: collision events, and pairs with kinematic bodies (characters) */
  arm(rec: OwnerRecord): void {
    const R = this.world.R;
    rec.collider.setSensor(true);
    rec.collider.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
    rec.collider.setActiveCollisionTypes(R.ActiveCollisionTypes.DEFAULT | R.ActiveCollisionTypes.KINEMATIC_FIXED);
  }

  private onEvent(h1: number, h2: number, started: boolean): void {
    const set = this.world.colliders;
    const a = set.owner(h1), b = set.owner(h2);
    if (!a || !b || a.sensor === b.sensor) return;
    const trigger = a.sensor ? a : b, other = a.sensor ? b : a;
    if (trigger.rowId === null || other.rowId === null) return;
    if (other.kind !== 'character' && other.kind !== 'dynamic') return;
    const key = `${trigger.rowId}\n${other.rowId}`;
    const n = this.overlaps.get(key) ?? 0;
    if (started) {
      this.overlaps.set(key, n + 1);
      if (n === 0) {
        this.enters.push({ trigger: trigger.rowId, other: other.rowId });
        this.total++;
      }
    } else if (n > 1) this.overlaps.set(key, n - 1);
    else this.overlaps.delete(key);
  }

  /** true while `other` overlaps `trigger` */
  inside(trigger: string, other: string): boolean {
    return this.overlaps.has(`${trigger}\n${other}`);
  }

  /** a row left the world or stopped colliding: its overlaps end (a later overlap is a new enter) and its pending enters go */
  forget(rowId: string): void {
    for (const key of [...this.overlaps.keys()]) {
      const cut = key.indexOf('\n');
      if (key.slice(0, cut) === rowId || key.slice(cut + 1) === rowId) this.overlaps.delete(key);
    }
    if (this.enters.length > 0) this.enters = this.enters.filter((e) => e.trigger !== rowId && e.other !== rowId);
  }

  /** the enters since the last call, sorted by (trigger serial, other serial): the order of dispatch is deterministic */
  drain(serialOf: (rowId: string) => number): TriggerEnter[] {
    const out = this.enters;
    if (out.length === 0) return [];
    this.enters = [];
    return out.sort((x, y) => serialOf(x.trigger) - serialOf(y.trigger) || serialOf(x.other) - serialOf(y.other));
  }

  get pending(): number { return this.enters.length; }

  clear(): void {
    this.overlaps.clear();
    this.enters = [];
  }
}
