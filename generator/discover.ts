/**
 * Auto-discovers ObjC classes and protocols by scanning framework header files.
 * Eliminates the need for manually maintaining class/protocol lists and header mappings.
 */

import { readdir } from "fs/promises";
import { join } from "path";

export interface DiscoveryResult {
  /** Maps class name → header file name (without .h extension) */
  classes: Map<string, string>;
  /** Maps protocol name → header file name (without .h extension) */
  protocols: Map<string, string>;
  /** Maps integer enum name → header file name (without .h extension) */
  integerEnums: Map<string, string>;
  /** Maps string enum name → header file name (without .h extension) */
  stringEnums: Map<string, string>;
}

/** Matches `@interface ClassName` — captures class name */
const INTERFACE_RE = /@interface\s+(\w+)/;

/** Matches category or extension: `@interface ClassName (` or `@interface ClassName<Type> (` */
const CATEGORY_RE = /@interface\s+\w+(?:<[^>]*>)?\s*\(/;

/** Matches `@protocol ProtocolName` — captures protocol name */
const PROTOCOL_RE = /@protocol\s+(\w+)/;

/**
 * Matches NS_ENUM / NS_OPTIONS / NS_CLOSED_ENUM integer enum declarations.
 * e.g., `typedef NS_ENUM(NSInteger, NSWindowStyleMask) {`
 * e.g., `typedef NS_OPTIONS(NSUInteger, NSWindowStyleMask) {`
 * e.g., `typedef NS_CLOSED_ENUM(NSInteger, NSComparisonResult) {`
 */
const NS_ENUM_RE = /typedef\s+NS_(?:ENUM|OPTIONS|CLOSED_ENUM)\s*\(\s*\w+\s*,\s*(\w+)\s*\)/;

/**
 * Matches NS_TYPED_EXTENSIBLE_ENUM / NS_STRING_ENUM / NS_TYPED_ENUM string enum declarations.
 * These are NSString * typedefs whose values are extern constants.
 * e.g., `typedef NSString * ASAuthorizationPublicKeyCredentialUserVerificationPreference NS_TYPED_EXTENSIBLE_ENUM;`
 * Also matches the multi-line form where the macro is on the typedef.
 */
const NS_STRING_ENUM_RE = /typedef\s+NSString\s*\*\s*(\w+)\s+NS_(?:TYPED_EXTENSIBLE_ENUM|STRING_ENUM|TYPED_ENUM)/;

/**
 * Matches integer-typed NS_TYPED_EXTENSIBLE_ENUM / NS_TYPED_ENUM declarations.
 * These are NSInteger/NSUInteger typedefs with the macro trailing after the name.
 * e.g., `typedef NSInteger ASCOSEAlgorithmIdentifier NS_TYPED_EXTENSIBLE_ENUM;`
 * e.g., `typedef NSInteger NSModalResponse NS_TYPED_EXTENSIBLE_ENUM;`
 * Their values are declared as `static TypeName const ConstantName = value;`.
 */
const NS_INTEGER_TYPED_ENUM_RE = /typedef\s+NSU?Integer\s+(\w+)\s+NS_(?:TYPED_EXTENSIBLE_ENUM|TYPED_ENUM)/;

/**
 * Matches NS_ERROR_ENUM declarations.
 * e.g., `typedef NS_ERROR_ENUM(NSURLErrorDomain, NSURLError) {`
 * Captures the error type name (second parameter), not the domain.
 */
const NS_ERROR_ENUM_RE = /typedef\s+NS_ERROR_ENUM\s*\(\s*\w+\s*,\s*(\w+)\s*\)/;

/**
 * Scan all .h files in a framework's Headers directory and discover
 * every ObjC class and protocol declaration, mapping each to its header file.
 *
 * Class declarations: `@interface Foo : Bar` or `@interface Foo <Protocol>`
 * Protocol declarations: `@protocol Foo <Bar>` (not forward decls like `@protocol Foo;`)
 * Skipped: categories (`@interface Foo (Cat)`), extensions (`@interface Foo ()`)
 */
export async function discoverFramework(headersPath: string): Promise<DiscoveryResult> {
  const classes = new Map<string, string>();
  const protocols = new Map<string, string>();
  const integerEnums = new Map<string, string>();
  const stringEnums = new Map<string, string>();

  const entries = await readdir(headersPath);
  const headerFiles = entries.filter((f) => f.endsWith(".h")).sort();

  for (const file of headerFiles) {
    const headerName = file.slice(0, -2); // strip .h
    const content = await Bun.file(join(headersPath, file)).text();
    const lines = content.split("\n");

    for (const line of lines) {
      // --- Class declarations ---
      // Match @interface Foo : Bar, @interface Foo <Protocol>, etc.
      // Skip categories: @interface Foo (Category) or extensions: @interface Foo ()
      const ifaceMatch = INTERFACE_RE.exec(line);
      if (ifaceMatch && !CATEGORY_RE.test(line)) {
        const name = ifaceMatch[1]!;
        // Only record first occurrence — handles redeclarations in other headers
        if (!classes.has(name)) {
          classes.set(name, headerName);
        }
      }

      // --- Protocol declarations ---
      // Match @protocol Foo <Bar> or @protocol Foo (followed by newline/methods)
      // Skip forward declarations: @protocol Foo; or @protocol Foo, Bar;
      const protoMatch = PROTOCOL_RE.exec(line);
      if (protoMatch && !line.includes(";")) {
        const name = protoMatch[1]!;
        if (!protocols.has(name)) {
          protocols.set(name, headerName);
        }
      }

      // --- Integer enum declarations (NS_ENUM / NS_OPTIONS) ---
      const enumMatch = NS_ENUM_RE.exec(line);
      if (enumMatch) {
        const name = enumMatch[1]!;
        if (!integerEnums.has(name)) {
          integerEnums.set(name, headerName);
        }
      }

      // --- String enum declarations (NS_TYPED_EXTENSIBLE_ENUM etc.) ---
      const stringEnumMatch = NS_STRING_ENUM_RE.exec(line);
      if (stringEnumMatch) {
        const name = stringEnumMatch[1]!;
        if (!stringEnums.has(name)) {
          stringEnums.set(name, headerName);
        }
      }

      // --- Integer typed extensible enum declarations ---
      // e.g., `typedef NSInteger ASCOSEAlgorithmIdentifier NS_TYPED_EXTENSIBLE_ENUM;`
      const intTypedEnumMatch = NS_INTEGER_TYPED_ENUM_RE.exec(line);
      if (intTypedEnumMatch) {
        const name = intTypedEnumMatch[1]!;
        if (!integerEnums.has(name)) {
          integerEnums.set(name, headerName);
        }
      }

      // --- Error enum declarations (NS_ERROR_ENUM) ---
      // e.g., `typedef NS_ERROR_ENUM(WKWebExtensionErrorDomain, WKWebExtensionError) {`
      const errorEnumMatch = NS_ERROR_ENUM_RE.exec(line);
      if (errorEnumMatch) {
        const name = errorEnumMatch[1]!;
        if (!integerEnums.has(name)) {
          integerEnums.set(name, headerName);
        }
      }
    }
  }

  return { classes, protocols, integerEnums, stringEnums };
}
