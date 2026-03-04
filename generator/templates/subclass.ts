/**
 * Type-safe wrapper around NobjcClass.define() for creating Objective-C
 * subclasses at runtime with full TypeScript type inference.
 *
 * Provides autocomplete for protocol method names, types `self` as the
 * superclass instance type, and returns the new class typed as the
 * superclass so that alloc/init and inherited methods are available.
 */

import { NobjcClass } from "objc-js";
import type { NobjcObject } from "objc-js";
import { _isKindOfClass } from "./bind.js";
import type { ProtocolMap } from "./delegates.js";

/** Converts a union type to an intersection type. */
type UnionToIntersection<U> = (U extends any ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

/**
 * Extracts only explicitly declared (non-index-signature) string keys from a type.
 *
 * Generated ObjC classes extend `NobjcObject` which has `[key: string]: NobjcMethod`.
 * Plain `keyof T` includes `string` from that index signature, defeating autocomplete
 * and generic key constraints. This type filters it out, keeping only the known
 * literal method names like `"init"`, `"description"`, `"setTitle$"`, etc.
 */
type DeclaredKeys<T> = Extract<
  keyof { [K in keyof T as string extends K ? never : number extends K ? never : symbol extends K ? never : K]: T[K] },
  string
>;

/**
 * A method definition for a subclass.
 *
 * @param TSelf - The type of `self` (the instance) passed as the first argument
 */
export interface SubclassMethodDef<TSelf = NobjcObject> {
  /**
   * Objective-C type encoding string.
   *
   * Common encodings:
   * - `@` = id (object), `:` = SEL, `v` = void, `B` = BOOL
   * - `q` = NSInteger (64-bit), `Q` = NSUInteger, `d` = double
   * - `^@` = id* (pointer to object, e.g. NSError**)
   * - `@?` = block
   *
   * Format: `return self _cmd arg1 arg2 ...`
   *
   * @example "v@:" — void method with no args (self + _cmd only)
   * @example "@@:@" — returns object, takes one object arg
   */
  types: string;
  /** The implementation. First argument is always `self` (the instance). */
  implementation: (self: TSelf, ...args: any[]) => any;
}

/**
 * Extracts method keys from protocol types for autocomplete.
 * When multiple protocols are specified, collects keys from all of them.
 */
type ProtocolMethodKeys<TProtocols extends keyof ProtocolMap> = Extract<
  keyof UnionToIntersection<ProtocolMap[TProtocols]>,
  string
>;

/**
 * Methods record for a subclass definition.
 *
 * Provides autocomplete for method names from the superclass and any
 * specified protocols, while still allowing arbitrary method names for
 * custom methods via `(string & {})`.
 */
type SubclassMethods<TSelf, TProtocols extends keyof ProtocolMap> = {
  [K in ProtocolMethodKeys<TProtocols> | DeclaredKeys<TSelf> | (string & {})]?: SubclassMethodDef<TSelf>;
};

/**
 * Define a new Objective-C subclass at runtime with TypeScript type safety.
 *
 * The returned class object is typed as the superclass, so all inherited
 * static methods (`alloc`, `new`, etc.) and instance methods are available.
 * The new class also supports `instanceof` checks via `Symbol.hasInstance`.
 *
 * @param superclass - The superclass to extend (e.g. `NSObject`, `NSViewController`)
 * @param definition - The class definition: name, optional protocols, and method implementations
 * @returns The new ObjC class, typed as the superclass
 *
 * @example
 * ```ts
 * import { NSObject } from "objcjs-types/Foundation";
 * import { defineSubclass, callSuper } from "objcjs-types/subclass";
 *
 * const MyDelegate = defineSubclass(NSObject, {
 *   name: "MyDelegate",
 *   protocols: ["NSWindowDelegate"],
 *   methods: {
 *     windowDidResize$: {
 *       types: "v@:@",
 *       implementation(self, notification) {
 *         console.log("Resized!");
 *       },
 *     },
 *     init: {
 *       types: "@@:",
 *       implementation(self) {
 *         return callSuper(self, "init");
 *       },
 *     },
 *   },
 * });
 *
 * const instance = MyDelegate.alloc().init();
 * ```
 */
export function defineSubclass<
  TClass extends abstract new (...args: any) => any,
  TProtocols extends keyof ProtocolMap = never
>(
  superclass: TClass,
  definition: {
    /** Unique name for the new ObjC class (must not collide with existing runtime classes). */
    name: string;
    /** Protocol names to conform to (provides autocomplete for method names). */
    protocols?: TProtocols[];
    /** Instance method implementations. Keys are selector names using `$` for `:`. */
    methods?: SubclassMethods<InstanceType<TClass>, TProtocols>;
    /** Class (static) method implementations. */
    classMethods?: Record<string, SubclassMethodDef>;
  }
): TClass {
  type RawMethodDef = { types: string; implementation: (self: NobjcObject, ...args: any[]) => any };
  const methods: Record<string, RawMethodDef> = {};
  if (definition.methods) {
    for (const [key, def] of Object.entries(definition.methods)) {
      if (def) methods[key] = def as RawMethodDef;
    }
  }

  const classMethods: Record<string, RawMethodDef> = {};
  if (definition.classMethods) {
    for (const [key, def] of Object.entries(definition.classMethods)) {
      if (def) classMethods[key] = def as RawMethodDef;
    }
  }

  const cls = NobjcClass.define({
    name: definition.name,
    superclass: superclass as unknown as NobjcObject,
    protocols: definition.protocols as string[] | undefined,
    methods,
    classMethods: Object.keys(classMethods).length > 0 ? classMethods : undefined
  });

  // Patch Symbol.hasInstance so `instanceof` works with the new class,
  // using the same cached isKindOfClass$ check as _bindClass.
  Object.defineProperty(cls, Symbol.hasInstance, {
    value: (obj: any) => _isKindOfClass(obj, cls)
  });

  return cls as unknown as TClass;
}

/**
 * Call the superclass implementation of a method from within a subclass
 * method implementation.
 *
 * The selector is constrained to method names on the `self` type, giving
 * autocomplete and validating that a super implementation exists. Arguments
 * and return type are inferred from the superclass method signature.
 *
 * For dynamic selectors not known at compile time, use `NobjcClass.super()`
 * from `objc-js` directly.
 *
 * @param self - The instance (`self`, the first argument of your implementation)
 * @param selector - The method name to call on super (e.g. `"init"`, `"viewDidLoad"`)
 * @param args - Arguments matching the superclass method's parameter types
 * @returns The return type of the superclass method
 *
 * @example
 * ```ts
 * init: {
 *   types: "@@:",
 *   implementation(self) {
 *     return callSuper(self, "init"); // returns _NSObject
 *   },
 * }
 * ```
 */
export function callSuper<TSelf, K extends DeclaredKeys<TSelf>>(
  self: TSelf,
  selector: K,
  ...args: TSelf[K] extends (...a: infer A) => any ? A : any[]
): TSelf[K] extends (...a: any[]) => infer R ? R : any {
  return NobjcClass.super(self as any, selector as string, ...args);
}
