/**
 * Parses the KNOWN_STRUCT_FIELDS table from the objc-js native runtime.
 * This table defines the field names that the bridge assigns to struct properties
 * at the JS level. Structs not in this table get positional names (field0, field1, ...).
 */

import { join } from "path";

/** Path to the objc-js struct-utils.h header containing KNOWN_STRUCT_FIELDS. */
const STRUCT_UTILS_PATH = join(
  import.meta.dir,
  "..",
  "node_modules",
  "objc-js",
  "src",
  "native",
  "struct-utils.h"
);

/**
 * Parse the KNOWN_STRUCT_FIELDS C++ map from struct-utils.h.
 * Returns a map of struct name → field names array.
 *
 * The C++ source looks like:
 * ```cpp
 * {"CGPoint", {"x", "y"}},
 * {"NSRange", {"location", "length"}},
 * ```
 */
export async function parseKnownStructFields(): Promise<Map<string, string[]>> {
  const content = await Bun.file(STRUCT_UTILS_PATH).text();
  const result = new Map<string, string[]>();

  // Match each entry: {"StructName", {"field1", "field2", ...}},
  const entryRe = /\{"(\w+)",\s*\{([^}]+)\}\}/g;
  let match: RegExpExecArray | null;

  while ((match = entryRe.exec(content)) !== null) {
    const structName = match[1]!;
    const fieldsStr = match[2]!;
    // Extract individual field name strings
    const fields: string[] = [];
    const fieldRe = /"(\w+)"/g;
    let fieldMatch: RegExpExecArray | null;
    while ((fieldMatch = fieldRe.exec(fieldsStr)) !== null) {
      fields.push(fieldMatch[1]!);
    }
    if (fields.length > 0) {
      result.set(structName, fields);
    }
  }

  return result;
}
