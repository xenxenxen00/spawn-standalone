// Binding-less actions are data channels unless the host supplies an explicit list.
import type { InputsDef } from '../../compat/core/types.ts';

export interface InputMapOptions {
  dataChannels?: readonly string[] | 'binding-less';
  arrowAliases?: boolean;
  wheelNotch?: number;
}


export const DEFAULT_WHEEL_NOTCH = 0.5;

/** the actions of a map with no key and no mouse binding */
export function bindingLessActions(inputs: InputsDef): string[] {
  const out: string[] = [];
  for (const [id, a] of Object.entries(inputs.actions ?? {})) {
    const keys = Array.isArray(a?.keys) ? a.keys.filter((k) => typeof k === 'string' && k.length > 0) : [];
    if (keys.length === 0 && !a?.mouse) out.push(id);
  }
  return out;
}

export function resolveDataChannels(opts: InputMapOptions | undefined, live: InputsDef): ReadonlySet<string> {
  const v = opts?.dataChannels;
  if (v === undefined) return new Set(bindingLessActions(live));
  return new Set(v === 'binding-less' ? bindingLessActions(live) : v);
}
