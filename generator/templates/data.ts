import { NSData, type _NSData } from "./Foundation";
import { NSStringFromString } from "./helpers";

/**
 * Create NSData from a JavaScript Buffer
 * @param buffer The Buffer object
 * @returns An NSData object
 */
export function NSDataFromBuffer(buffer: Buffer): _NSData {
  return NSData.dataWithBytes$length$(buffer, buffer.length);
}

/**
 * Convert NSData to a JavaScript Buffer using base64 encoding
 * This is the most reliable method for data conversion.
 * @param data The NSData object
 * @returns A Buffer containing the data
 */
export function bufferFromNSData(data: _NSData): Buffer {
  const nsData = data as unknown as typeof NSData.prototype;
  const length = nsData.length();

  if (length === 0) {
    return Buffer.alloc(0);
  }

  // Use base64 encoding as a reliable bridge between NSData and JS Buffer
  const base64String = nsData.base64EncodedStringWithOptions$(0);
  const base64Str = base64String.UTF8String();
  return Buffer.from(base64Str, "base64");
}

/**
 * Convert NSData to a JavaScript Buffer using direct memory copy
 * This method uses getBytes:length: for direct memory access.
 * May be more efficient for large data, but requires proper buffer allocation.
 * @param data The NSData object
 * @returns A Buffer containing the data
 */
export function bufferFromNSDataDirect(data: _NSData): Buffer {
  const nsData = data as unknown as typeof NSData.prototype;
  const length = nsData.length();

  if (length === 0) {
    return Buffer.alloc(0);
  }

  // Allocate a buffer and copy bytes directly
  const buffer = Buffer.alloc(length);
  nsData.getBytes$length$(buffer, length);
  return buffer;
}

/**
 * Convert NSData to a JavaScript Uint8Array
 * @param data The NSData object
 * @returns A Uint8Array containing the data
 */
export function uint8ArrayFromNSData(data: _NSData): Uint8Array {
  const buffer = bufferFromNSData(data);
  return new Uint8Array(buffer);
}

/**
 * Convert NSData to a base64 string
 * @param data The NSData object
 * @returns A base64-encoded string
 */
export function base64FromNSData(data: _NSData): string {
  const nsString = data.base64EncodedStringWithOptions$(0);
  return nsString.UTF8String();
}

/**
 * Create NSData from a base64 string
 * @param base64String The base64-encoded string
 * @returns An NSData object
 */
export function NSDataFromBase64(base64String: string): _NSData {
  const nsString = NSStringFromString(base64String);
  const nsDataAlloc = NSData.alloc();
  const nsData = nsDataAlloc.initWithBase64EncodedString$options$(nsString, 0);
  if (!nsData) {
    throw new Error(
      `Failed to create NSData from base64 string: ${base64String}`
    );
  }
  return nsData;
}

/**
 * Get the length of NSData
 * @param data The NSData object
 * @returns The length in bytes
 */
export function NSDataLength(data: _NSData): number {
  const nsData = data as unknown as typeof NSData.prototype;
  return nsData.length();
}
