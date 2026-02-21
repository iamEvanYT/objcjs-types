/**
 * Type-level test: verifies that block (closure) parameters are typed as
 * TypeScript function types instead of NobjcObject.
 *
 * This file is NOT meant to be executed — it only needs to typecheck.
 * Run: bunx tsgo --noEmit tests/block-types.ts
 */

import type { _NSArray } from "../src/Foundation/NSArray.js";
import type { _NSDictionary } from "../src/Foundation/NSDictionary.js";
import type { _NSURLSession } from "../src/Foundation/NSURLSession.js";
import type { _NSData } from "../src/Foundation/NSData.js";
import type { _NSURLResponse } from "../src/Foundation/NSURLResponse.js";
import type { _NSError } from "../src/Foundation/NSError.js";
import type { _NSURL } from "../src/Foundation/NSURL.js";
import type { NobjcObject } from "objc-js";

// Simulate having instances
declare const array: _NSArray;
declare const dict: _NSDictionary;
declare const session: _NSURLSession;

// --- NSArray.enumerateObjectsUsingBlock$ ---
// Block signature: void (^)(id obj, NSUInteger idx, BOOL *stop)
// Should accept a function (obj, idx, stop) => void
array.enumerateObjectsUsingBlock$((obj: NobjcObject, idx: number, stop: NobjcObject) => {
  void obj;
  void idx;
  void stop;
});

// --- NSArray.sortedArrayUsingComparator$ ---
// NSComparator typedef: NSComparisonResult (^)(id, id)
// Should accept a function (a, b) => number and return _NSArray
const sorted: _NSArray = array.sortedArrayUsingComparator$((a: NobjcObject, b: NobjcObject): number => {
  return 0;
});
void sorted;

// --- NSDictionary.enumerateKeysAndObjectsUsingBlock$ ---
// Block signature: void (^)(id key, id obj, BOOL *stop)
dict.enumerateKeysAndObjectsUsingBlock$((key: NobjcObject, obj: NobjcObject, stop: NobjcObject) => {
  void key;
  void obj;
  void stop;
});

// --- NSURLSession.dataTaskWithRequest$completionHandler$ ---
// Block signature: void (^)(NSData *, NSURLResponse *, NSError *)
// The block parameter is nullable, so it should be ((args) => void) | null
declare const request: import("../src/Foundation/NSURLRequest.js")._NSURLRequest;
const task = session.dataTaskWithRequest$completionHandler$(
  request,
  (data: _NSData, response: _NSURLResponse, error: _NSError) => {
    void data;
    void response;
    void error;
  }
);
void task;

// Passing null should also work (nullable block)
session.dataTaskWithRequest$completionHandler$(request, null);

// --- Type assertion: block params are NOT NobjcObject ---
// If blocks were still typed as NobjcObject, this line would fail because
// NobjcObject is not callable. The fact that the above calls typecheck
// proves the block types are correctly emitted as function types.
