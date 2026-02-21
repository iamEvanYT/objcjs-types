import type { NobjcObject } from "objc-js";
import {
  NSArray,
  NSDictionary,
  NSString,
  type _NSArray,
  type _NSDictionary,
  type _NSString
} from "./Foundation/index.js";

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

export function NSArrayFromObjects(objects: NobjcObject[]): _NSArray {
  if (objects.length === 0) {
    return NSArray.array();
  }
  let array = NSArray.arrayWithObject$(objects[0]!);
  for (let i = 1; i < objects.length; i++) {
    array = array.arrayByAddingObject$(objects[i]!);
  }
  return array;
}

export function NSDictionaryFromKeysAndValues(keys: NobjcObject[], values: NobjcObject[]): _NSDictionary {
  if (keys.length !== values.length) {
    throw new Error("Keys and values arrays must have the same length");
  }
  const keysArray = NSArrayFromObjects(keys);
  const valuesArray = NSArrayFromObjects(values);
  return NSDictionary.dictionaryWithObjects$forKeys$(valuesArray, keysArray);
}

/**
 * Wraps a function that accepts a single callback into a Promise.
 *
 * @param funcWithCallback - A function that accepts a completion callback and
 *   invokes it with the result. The function itself returns `void`.
 * @returns A Promise that resolves with the value passed to the callback.
 *
 * @example
 * ```ts
 * const authState = await makePromise(
 *   manager.requestAuthorizationForPublicKeyCredentials$.bind(manager)
 * );
 * ```
 */
export function makePromise<T>(funcWithCallback: (callback: (result: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve) => {
    funcWithCallback(resolve);
  });
}

export { isKindOfClass } from "./bind.js";
