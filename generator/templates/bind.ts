/**
 * Internal helper for binding ObjC class constants with `instanceof` support.
 *
 * Separated from helpers.ts to avoid circular imports — framework index files
 * import this, and helpers.ts imports from Foundation's index.
 *
 * @internal
 */

/**
 * Cache of `isKindOfClass$` results: obj → (cls → result).
 *
 * After the first `instanceof` check for a given (obj, cls) pair crosses
 * the JS↔ObjC boundary, subsequent checks on the same object return the
 * cached result with zero native calls.  This matters for if/else chains
 * that are hit repeatedly (e.g. in event handlers or render loops).
 */
const _kindCache = new WeakMap<object, Map<object, boolean>>();

/**
 * Load a class constant from a framework library and patch
 * `Symbol.hasInstance` so that `obj instanceof ClassName` works at runtime
 * by delegating to the ObjC runtime's `-[NSObject isKindOfClass:]`.
 *
 * Results are cached per (object, class) pair in a shared `WeakMap` so
 * repeated checks skip the native boundary crossing entirely.
 *
 * @internal
 */
export function _bindClass<T>(lib: any, name: string): T {
  const cls = lib[name];
  Object.defineProperty(cls, Symbol.hasInstance, {
    value: (obj: any) => {
      if (typeof obj !== "object" || obj === null) return false;
      let m = _kindCache.get(obj);
      if (m) {
        const v = m.get(cls);
        if (v !== undefined) return v;
      }
      try {
        if (!m) {
          m = new Map();
          _kindCache.set(obj, m);
        }
        const r = obj.isKindOfClass$(cls);
        m.set(cls, r);
        return r;
      } catch {
        return false;
      }
    }
  });
  return cls as unknown as T;
}
