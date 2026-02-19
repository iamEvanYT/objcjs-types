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
