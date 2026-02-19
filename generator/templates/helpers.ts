import { NSString, type _NSError, type _NSString } from "./Foundation";

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
