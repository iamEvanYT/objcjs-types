import type { NobjcObject } from "objc-js";
import { NSString, type _NSError, type _NSString } from "./Foundation/index.js";

/**
 * Create NSString from a JavaScript string
 * @param str The string object
 * @returns An NSString object
 */
export function NSStringFromString(str: string): _NSString {
  const nsString = NSString.stringWithUTF8String$(str);
  if (!nsString) {
    throw new Error(`Failed to create NSString from string: ${str}`);
  }
  return nsString;
}

/**
 * Combine NS_OPTIONS values using bitwise OR.
 *
 * Accepts any number of option flag values and returns their bitwise
 * combination, preserving the NS_OPTIONS type for type safety.
 *
 * @example
 * ```ts
 * import { NSWindowStyleMask } from "./AppKit";
 * import { options } from "./helpers";
 *
 * const mask = options(
 *   NSWindowStyleMask.Titled,
 *   NSWindowStyleMask.Closable,
 *   NSWindowStyleMask.Resizable,
 * );
 * ```
 */
export function options<T extends number>(...values: T[]): T {
  let result = 0;
  for (const v of values) {
    result |= v;
  }
  return result as T;
}

/**
 * Type guard that narrows an ObjC object to a specific class type using
 * the Objective-C runtime's `-[NSObject isKindOfClass:]` check.
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
export function isKindOfClass<T extends NobjcObject>(obj: NobjcObject, cls: NobjcObject): obj is T {
  return (obj as any).isKindOfClass$(cls);
}
