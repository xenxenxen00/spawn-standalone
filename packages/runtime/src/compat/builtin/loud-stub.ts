// Loud stubs for builtin exports the port does not run (docs/architecture.md §3.4: "loud stubs"). A stub is inert until it is
// used, so a carried module that merely imports it still evaluates; any call, construction or property read throws a
// BuiltinStubError that names the export and says where its behaviour lives instead.

export class BuiltinStubError extends Error {
  override name = 'BuiltinStubError';
}

function fail(id: string, why: string): never {
  throw new BuiltinStubError(`${id} is not available in the port: ${why}`);
}

/** A function export that throws when called or constructed. `id` is e.g. `builtin/tsl.vec3`. */
export function stubFunction(id: string, why: string): (...args: unknown[]) => never {
  return stubValue(id, why) as unknown as (...args: unknown[]) => never;
}

/**
 * A value export (a node constant such as `PI` or `time`) that throws on any use: property read, call, construction,
 * conversion. Symbol-keyed reads answer undefined so inspection tools can print it.
 */
export function stubValue(id: string, why: string): unknown {
  const target = function stub(): void {};
  return new Proxy(target, {
    get(_t, key) {
      if (typeof key === 'symbol') return undefined;
      return fail(`${id} (read of .${key})`, why);
    },
    set: () => fail(id, why),
    apply: () => fail(id, why),
    construct: () => fail(id, why),
  });
}

/** A class export whose constructor throws. */
export function stubClass(id: string, why: string): new (...args: unknown[]) => never {
  return class {
    constructor() {
      fail(id, why);
    }
  } as unknown as new (...args: unknown[]) => never;
}
