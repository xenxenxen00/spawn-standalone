// The capability manifest: which Spawn engine surfaces the runtime implements. It is plain JSON so the converter's
// `coverage` command can read it without loading the runtime. Entry ids:
//   ctx.self.anim.*        a ctx chain; `*` matches exactly one segment and a longer chain matches its longest prefix
//   builtin/physics.raycast  a named export of a builtin module (`builtin/physics` alone is the module)
//   act:squash             an engine act topic passed to ctx.emit
//   hook:onArrive          an export the engine calls or reads from a behavior, sim, template or realm module
//   config:camera.projection  a key path in world.config.yaml or places/<p>/config.yaml
//   spec:physics.collisionGroups  a key path in an object spec (a template export or a ctx.spawn argument)
// An id may end in `=value` to refine a surface by its literal value (`config:atmosphere.fog.kind=linear`).
import manifestJson from './capabilities.json' with { type: 'json' };

export type CapabilityKind = 'ctx' | 'builtin' | 'act' | 'hook' | 'config' | 'spec';

/** implemented: works. partial: works for a subset or with constants. absent: undefined or inert. loud: throws when used. */
export type CapabilityStatus = 'implemented' | 'partial' | 'absent' | 'loud';

export interface CapabilityEntry {
  id: string;
  kind: CapabilityKind;
  status: CapabilityStatus;
  note?: string;
  /** the plan work item that closes the gap, such as `K5` */
  plan?: string;
}

export interface CapabilityManifest {
  version: 1;
  runtime: string;
  description: string;
  entries: CapabilityEntry[];
}

export const CAPABILITY_KINDS: readonly CapabilityKind[] = ['ctx', 'builtin', 'act', 'hook', 'config', 'spec'];
export const CAPABILITY_STATUSES: readonly CapabilityStatus[] = ['implemented', 'partial', 'absent', 'loud'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks the shape of a parsed manifest and returns it typed; throws a message naming the first bad entry. */
export function parseManifest(raw: unknown): CapabilityManifest {
  if (!isObject(raw) || raw['version'] !== 1 || !Array.isArray(raw['entries'])) {
    throw new Error('capability manifest: expected { version: 1, entries: [...] }');
  }
  const seen = new Set<string>();
  const entries: CapabilityEntry[] = [];
  raw['entries'].forEach((e: unknown, i: number) => {
    if (!isObject(e)) throw new Error(`capability manifest: entry ${i} is not an object`);
    const { id, kind, status, note, plan } = e;
    if (typeof id !== 'string' || id === '') throw new Error(`capability manifest: entry ${i} has no id`);
    if (!CAPABILITY_KINDS.includes(kind as CapabilityKind)) throw new Error(`capability manifest: ${id} has bad kind ${String(kind)}`);
    if (!CAPABILITY_STATUSES.includes(status as CapabilityStatus)) throw new Error(`capability manifest: ${id} has bad status ${String(status)}`);
    if (seen.has(id)) throw new Error(`capability manifest: duplicate id ${id}`);
    seen.add(id);
    const entry: CapabilityEntry = { id, kind: kind as CapabilityKind, status: status as CapabilityStatus };
    if (typeof note === 'string') entry.note = note;
    if (typeof plan === 'string') entry.plan = plan;
    entries.push(entry);
  });
  return {
    version: 1,
    runtime: typeof raw['runtime'] === 'string' ? raw['runtime'] : '',
    description: typeof raw['description'] === 'string' ? raw['description'] : '',
    entries,
  };
}

/** The manifest shipped with the runtime package. */
export function loadManifest(): CapabilityManifest {
  return parseManifest(manifestJson);
}
