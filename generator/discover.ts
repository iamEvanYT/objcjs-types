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
}

/** Matches `@interface ClassName` — captures class name */
const INTERFACE_RE = /@interface\s+(\w+)/;

/** Matches category or extension: `@interface ClassName (` or `@interface ClassName<Type> (` */
const CATEGORY_RE = /@interface\s+\w+(?:<[^>]*>)?\s*\(/;

/** Matches `@protocol ProtocolName` — captures protocol name */
const PROTOCOL_RE = /@protocol\s+(\w+)/;

/**
 * Scan all .h files in a framework's Headers directory and discover
 * every ObjC class and protocol declaration, mapping each to its header file.
 *
 * Class declarations: `@interface Foo : Bar` or `@interface Foo <Protocol>`
 * Protocol declarations: `@protocol Foo <Bar>` (not forward decls like `@protocol Foo;`)
 * Skipped: categories (`@interface Foo (Cat)`), extensions (`@interface Foo ()`)
 */
export async function discoverFramework(
  headersPath: string
): Promise<DiscoveryResult> {
  const classes = new Map<string, string>();
  const protocols = new Map<string, string>();

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
    }
  }

  return { classes, protocols };
}
