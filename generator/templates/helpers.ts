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
 * Returns the key name for a given numeric value in a const enum-like object.
 *
 * @param enumObj - A const object mapping string keys to numeric values.
 * @param value - The numeric value to look up.
 * @returns The matching key name, or `undefined` if not found.
 *
 * @example
 * ```ts
 * const state = enumFromValue(
 *   ASAuthorizationWebBrowserPublicKeyCredentialManagerAuthorizationState,
 *   rawValue
 * ); // e.g. "Authorized" | "Denied" | "NotDetermined" | undefined
 * ```
 */
export function enumFromValue<T extends Record<string, number>>(enumObj: T, value: number): keyof T | undefined {
  return (Object.keys(enumObj) as (keyof T)[]).find((key) => enumObj[key] === value);
}

function PromiseWithResolvers<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void;
  let reject: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: resolve!, reject: reject! };
}
/**
 * Converts a callback-based function with a single result parameter into a Promise.
 *
 * @template TArgs - The argument types of the original function (excluding the callback)
 * @template TResult - The type of the result passed to the callback
 * @param func - A function that takes arguments and a callback with a single result parameter
 * @param args - The arguments to pass to the function (excluding the callback)
 * @returns A Promise that resolves with the result passed to the callback
 */
export function makePromise1Result<TArgs extends any[], TResult>(
  func: (...args: [...TArgs, (result: TResult) => void]) => void,
  ...args: TArgs
): Promise<TResult> {
  const { promise, resolve } = PromiseWithResolvers<TResult>();
  const callback = (result: TResult) => {
    resolve(result);
  };
  func(...args, callback);
  return promise;
}

export { isKindOfClass } from "./bind.js";
