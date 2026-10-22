// Page-global names (UiHostConfig.globals). No imports, so page-api.ts and ui-host-config.ts can both use it.

export const IDENT = /^[A-Za-z_$][\w$]*$/;


/** the names `globals: 'auto'` installs from a UI module: its function exports, minus lifecycle and the runtime's own */
const NOT_GLOBALS: ReadonlySet<string> = new Set(['default', 'onMount', 'onDestroy', 'sendAction', 'sendAxis', 'openLink', 'spawn']);

export function autoGlobalNames(mod: object): string[] {
  const out: string[] = [];
  for (const k of Object.keys(mod)) {
    if (NOT_GLOBALS.has(k) || !IDENT.test(k)) continue;
    if (typeof (mod as Record<string, unknown>)[k] === 'function') out.push(k);
  }
  return out;
}
