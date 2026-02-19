/**
 * Internal helper for binding ObjC class constants with `instanceof` support.
 *
 * Separated from helpers.ts to avoid circular imports — framework index files
 * import this, and helpers.ts imports from Foundation's index.
 *
 * @internal
 */

import type { NobjcObject } from "objc-js";

/**
 * Cache of `isKindOfClass$` results: obj → (cls → result).
 *
 * After the first check for a given (obj, cls) pair crosses the JS↔ObjC
 * boundary, subsequent checks on the same object return the cached result
 * with zero native calls.  This matters for if/else chains that are hit
 * repeatedly (e.g. in event handlers or render loops).
 */
const _kindCache = new WeakMap<object, Map<object, boolean>>();

/**
 * Cached `isKindOfClass:` check — the single path used by both
 * `instanceof` (via `Symbol.hasInstance`) and the `isKindOfClass()` helper.
 */
function _isKindOfClass(obj: any, cls: any): boolean {
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

/**
 * Type guard that narrows an ObjC object to a specific class type using
 * the Objective-C runtime's `-[NSObject isKindOfClass:]` check.
 *
 * Results are cached per (object, class) pair so repeated checks skip
 * the native boundary crossing entirely.
 *
 * Returns `true` if `obj` is an instance of `cls` or any of its subclasses,
 * and narrows the TypeScript type accordingly.
 *
 * @param obj  - The object to check
 * @param cls  - The runtime class constant (e.g. `NSWindow`, `NSString`)
 * @returns `true` if `obj` is a kind of `cls`
 *
 * @example
 * ```ts
 * import {
 *   ASAuthorizationAppleIDCredential,
 *   type _ASAuthorizationAppleIDCredential,
 *   ASPasswordCredential,
 *   type _ASPasswordCredential,
 * } from "./AuthenticationServices";
 * import { isKindOfClass } from "./helpers";
 *
 * const cred = authorization.credential();
 *
 * if (isKindOfClass<_ASAuthorizationAppleIDCredential>(cred, ASAuthorizationAppleIDCredential)) {
 *   cred.user();   // narrowed to _ASAuthorizationAppleIDCredential
 *   cred.email();
 * } else if (isKindOfClass<_ASPasswordCredential>(cred, ASPasswordCredential)) {
 *   cred.user();
 *   cred.password();
 * }
 * ```
 */
export function isKindOfClass<T extends NobjcObject>(obj: NobjcObject, cls: any): obj is T {
  return _isKindOfClass(obj, cls);
}

/**
 * Load a class constant from a framework library and patch
 * `Symbol.hasInstance` so that `obj instanceof ClassName` works at runtime
 * by delegating to the ObjC runtime's `-[NSObject isKindOfClass:]`.
 *
 * Uses the same cached check as `isKindOfClass()`.
 *
 * @internal
 */
export function _bindClass<T>(lib: any, name: string): T {
  const cls = lib[name];
  Object.defineProperty(cls, Symbol.hasInstance, {
    value: (obj: any) => _isKindOfClass(obj, cls)
  });
  return cls as unknown as T;
}
