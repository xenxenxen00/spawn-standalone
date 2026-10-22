import { cloneWire, deepEqualWire } from '../core/wire.ts';

export const PORT_FLAG_DEFAULTS: Readonly<Record<string, unknown>> = Object.freeze({});

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

export type PortFlagListener = (key: string, value: unknown) => void;

let base: Readonly<Record<string, unknown>> = PORT_FLAG_DEFAULTS;
let overrides: Record<string, unknown> = {};
let listeners: PortFlagListener[] = [];

/** the effective table: defaults ← installed table ← runtime overrides (frozen; replaced on every change) */
export let flags: Readonly<Record<string, unknown>> = PORT_FLAG_DEFAULTS;

const key = (kind: string, id: string): string => (id.startsWith(`${kind}.`) ? id : `${kind}.${id}`);
const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(flags, k);

/** `fidelity.<id>` is on (`true`, nothing else) */
export function fidelity(id: string): boolean {
  return flags[key('fidelity', String(id))] === true;
}

/** the flag `name` as given, else `port.<name>`, else `content.<name>`; undefined when none is set */
export function portFlag(name: string): unknown {
  const n = String(name);
  if (has(n)) return flags[n];
  const p = key('port', n);
  if (has(p)) return flags[p];
  const c = key('content', n);
  if (has(c)) return flags[c];
  return undefined;
}

function rebuild(): void {
  const prev = flags;
  const next = deepFreeze({ ...base, ...overrides });
  flags = next;
  const changed: string[] = [];
  for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (!deepEqualWire(prev[k], next[k])) changed.push(k);
  }
  for (const k of changed) {
    for (const fn of listeners) {
      try {
        fn(k, next[k]);
      } catch (err) {
        console.error(`[builtin/port] a ${k} subscriber threw`, err);
      }
    }
  }
}

/** boot: lays the host's flag table over the defaults, replacing any table installed before */
export function installPortFlags(table: Readonly<Record<string, unknown>>): void {
  const copy = cloneWire(table);
  if (typeof copy !== 'object' || copy === null || Array.isArray(copy)) throw new TypeError('installPortFlags: the table must be an object');
  base = deepFreeze({ ...PORT_FLAG_DEFAULTS, ...copy });
  rebuild();
}

/** a runtime override of one fully named flag (`port.simCaps`); `undefined` clears it */
export function setPortFlag(name: string, value: unknown): void {
  if (typeof name !== 'string' || name.length === 0) throw new TypeError('setPortFlag: the flag name must be a non-empty string');
  if (value === undefined) {
    if (!(name in overrides)) return;
    const { [name]: _gone, ...rest } = overrides;
    overrides = rest;
  } else {
    overrides = { ...overrides, [name]: cloneWire(value) };
  }
  rebuild();
}

/** subscribe to effective changes (key, new value); returns the unsubscribe */
export function onPortFlagChange(fn: PortFlagListener): () => void {
  listeners = [...listeners, fn];
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

/** tests: back to the defaults, no overrides, no subscribers */
export function resetPortFlags(): void {
  base = PORT_FLAG_DEFAULTS;
  overrides = {};
  listeners = [];
  flags = PORT_FLAG_DEFAULTS;
}

/** Host-provided services for carried modules. Nothing is bound by default. */
const services = new Map<string, unknown>();
export function bindService<T>(name: string, implementation: T | null): void {
  if (typeof name !== 'string' || name.length === 0) throw new TypeError('bindService: a service name is required');
  if (implementation === null) services.delete(name); else services.set(name, implementation);
}
export function service<T>(name: string): T | null { return (services.get(name) as T | undefined) ?? null; }

export default {
  bindService,
  service,
  fidelity,
  portFlag,
  get flags(): Readonly<Record<string, unknown>> {
    return flags;
  },
};
