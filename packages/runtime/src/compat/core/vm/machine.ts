// The two virtual machines of a single-player room (docs/design/core-runtime.md §10, D-CORE-01; mp §11.1).
//
// Live topology: Spawn's platform machine runs `sim.js`, the place sims and every `simulatedBy: "platform"` row; a human's client
// runs its body, the camera rig, the HUD and its `audience: "local"` rows. The port keeps that split as two VMs in one thread so
// that per-machine singletons stay per machine: `ctx.session` (one bag per VM: `__termShown` is one flag for the four terminals
// of a map, `ss` bags per body, `ssClk`, the bots' shared `ssBot`), `isLocal` (true only when read from the client VM), and the
// visibility of client-made `audience: 'local'` rows (X-24, query.ts / handles.ts).
//
// - `vmForSpawn` is the assignment rule of §10.2, the one function lifecycle.ts places every spawned row with.
// - Cross-VM writes (the Director writing `spectating` or `state.*` on the human's row) are allowed and counted per VM, with
//   the field name, on the WRITER's VM (the store reports them through its cross-VM hook): a worker build would turn them into
//   messages (§10.4). Cross-VM reads are counted where a ctx hands out a handle of a row of the other VM.
// - Each VM carries its own physics world handle from day one; both point at the same world in v1 (motion §5.1).
import type { KernelPorts } from '../ports.ts';
import type { PhysicsWorldHandle, VirtualMachine, VmId } from '../types.ts';

export const VM_IDS: readonly VmId[] = Object.freeze(['platform', 'client'] as const);

export class VirtualMachineImpl implements VirtualMachine {
  readonly id: VmId;
  /** `ctx.session` of every ctx of this VM: a plain object, page life, never persisted, never on the bus */
  readonly session: Record<string, any> = {};
  physicsWorld: PhysicsWorldHandle | null;
  readonly counters = { crossVmWrites: 0, crossVmReads: 0 };
  /** cross-VM writes made from this VM, by field name (`spectating`, `state`, …) */
  readonly crossVmWriteFields = new Map<string, number>();

  constructor(id: VmId, physicsWorld: PhysicsWorldHandle | null = null) {
    this.id = id;
    this.physicsWorld = physicsWorld;
  }

  /** a write this VM made to a row of the other VM (core §10.4 point 2) */
  noteCrossVmWrite(field: string): void {
    this.counters.crossVmWrites++;
    this.crossVmWriteFields.set(field, (this.crossVmWriteFields.get(field) ?? 0) + 1);
  }

  /** a handle of a row of the other VM handed to code of this VM */
  noteCrossVmRead(n = 1): void {
    this.counters.crossVmReads += n;
  }
}

/** the platform and the client VM of one kernel, each with its physics world handle (the port's, null when it names none) */
export function createVms(ports?: Pick<KernelPorts, 'physics'>): Readonly<Record<VmId, VirtualMachineImpl>> {
  const worlds = ports?.physics.vmWorlds;
  return Object.freeze({
    platform: new VirtualMachineImpl('platform', worlds?.platform ?? null),
    client: new VirtualMachineImpl('client', worlds?.client ?? null),
  });
}

export interface VmAssignment {
  /** the kernel's own choice (boot: the human body and the camera rig are `client`) */
  readonly forced?: VmId | undefined;
  /** the spec's `simulatedBy` */
  readonly simulatedBy?: 'platform' | null | undefined;
  /** the VM of the row whose behavior spawns, or of the parent for a row of a `children` list; null for a sim, a scene or the
   *  kernel */
  readonly spawnerVm?: VmId | null | undefined;
}

/**
 * core §10.2: the VM a new row runs in.
 *   kernel-forced (the human body, the camera rig)        that VM
 *   `simulatedBy: "platform"`                             platform
 *   spawned by a row's behavior / a child of a row        the spawner's (the parent's) VM
 *   spawned by a sim, a scene row, the kernel             platform
 */
export function vmForSpawn(a: VmAssignment): VmId {
  if (a.forced !== undefined) return a.forced;
  if (a.simulatedBy === 'platform') return 'platform';
  return a.spawnerVm ?? 'platform';
}
