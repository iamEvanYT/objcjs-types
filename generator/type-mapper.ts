/**
 * Maps Objective-C types (from clang AST qualType strings) to TypeScript types.
 */

/** Set of all class names we're generating types for (across all frameworks) */
let knownClasses: Set<string> = new Set();

/** Set of all known protocol names across all frameworks */
let knownProtocols: Set<string> = new Set();

/** Maps protocol name → set of known conforming class names */
let protocolConformers: Map<string, Set<string>> = new Map();

/** Set of all known integer enum names (NS_ENUM / NS_OPTIONS) across all frameworks */
let knownIntegerEnums: Set<string> = new Set();

/** Set of all known string enum names (NS_TYPED_EXTENSIBLE_ENUM etc.) across all frameworks */
let knownStringEnums: Set<string> = new Set();

/** General typedef resolution table: typedef name → underlying qualType string */
let knownTypedefs: Map<string, string> = new Map();

/** Read-only access to the known integer enum names set (for use by the emitter). */
export function getKnownIntegerEnums(): Set<string> {
  return knownIntegerEnums;
}

/** Read-only access to the known string enum names set (for use by the emitter). */
export function getKnownStringEnums(): Set<string> {
  return knownStringEnums;
}

export function setKnownClasses(classes: Set<string>): void {
  knownClasses = classes;
}

export function setKnownProtocols(protocols: Set<string>): void {
  knownProtocols = protocols;
}

export function setProtocolConformers(conformers: Map<string, Set<string>>): void {
  protocolConformers = conformers;
}

export function setKnownIntegerEnums(enums: Set<string>): void {
  knownIntegerEnums = enums;
}

export function setKnownStringEnums(enums: Set<string>): void {
  knownStringEnums = enums;
}

export function setKnownTypedefs(typedefs: Map<string, string>): void {
  knownTypedefs = typedefs;
}

/**
 * Numeric ObjC types that map to `number` in TypeScript.
 */
const NUMERIC_TYPES = new Set([
  "int",
  "unsigned int",
  "short",
  "unsigned short",
  "long",
  "unsigned long",
  "long long",
  "unsigned long long",
  "float",
  "double",
  "NSInteger",
  "NSUInteger",
  "CGFloat",
  "NSTimeInterval",
  "unichar",
  "size_t",
  "ssize_t",
  "uint8_t",
  "uint16_t",
  "uint32_t",
  "uint64_t",
  "int8_t",
  "int16_t",
  "int32_t",
  "int64_t",
  "CFIndex",
  "CFTimeInterval",
  "CGWindowLevel",
  "NSWindowLevel",
  "NSModalResponse",
  "NSComparisonResult",
  "NSStringEncoding"
]);

/**
 * ObjC types that map to specific TS types.
 */
const DIRECT_MAPPINGS: Record<string, string> = {
  void: "void",
  BOOL: "boolean",
  bool: "boolean",
  _Bool: "boolean",
  id: "NobjcObject",
  SEL: "string",
  Class: "NobjcObject",
  "char *": "string",
  "const char *": "string",
  "unsigned char *": "string",
  "const unsigned char *": "string",
  // Typedef'd NSString * aliases — clang resolves the typedef name, not the underlying type
  NSAttributedStringKey: "_NSString",
  NSStringTransform: "_NSString",
  NSNotificationName: "_NSString",
  NSRunLoopMode: "_NSString",
  NSPasteboardType: "_NSString",
  NSTouchBarItemIdentifier: "_NSString",
  NSToolbarIdentifier: "_NSString",
  NSToolbarItemIdentifier: "_NSString",
  NSAccessibilityRole: "_NSString",
  NSAccessibilitySubrole: "_NSString",
  NSAccessibilityNotificationName: "_NSString",
  NSUserInterfaceItemIdentifier: "_NSString",
  NSStoryboardName: "_NSString",
  NSStoryboardSceneIdentifier: "_NSString",
  NSNibName: "_NSString",
  NSBindingName: "_NSString",
  NSColorName: "_NSString",
  NSColorListName: "_NSString",
  NSImageName: "_NSString",
  NSSoundName: "_NSString",
  NSAppearanceName: "_NSString",
  NSPasteboardReadingOptionKey: "_NSString",
  // Pointer-to-struct typedefs — these are C pointer types, not value types
  NSRectArray: "NobjcObject",
  NSRectPointer: "NobjcObject",
  NSPointArray: "NobjcObject",
  NSPointPointer: "NobjcObject",
  NSSizeArray: "NobjcObject",
  NSSizePointer: "NobjcObject",
  NSRangePointer: "NobjcObject"
  // CoreFoundation opaque types — these are C struct pointers (type encoding `^{...}`),
  // NOT ObjC objects. Handled separately in mapParamType/mapReturnType.
};

/**
 * CoreFoundation opaque types — these are C struct pointers (type encoding
 * `^{CGContext=}` etc.), NOT ObjC objects. The objc-js bridge handles `^`
 * params with Buffer/TypedArray and pointer returns throw TypeError.
 */
const CF_OPAQUE_TYPES = new Set([
  "CGContextRef",
  "CGImageRef",
  "CGColorRef",
  "CGColorSpaceRef",
  "CGPathRef",
  "CGEventRef",
  "CGLayerRef",
  "CFRunLoopRef",
  "CFStringRef",
  "CFTypeRef",
  "SecTrustRef",
  "SecIdentityRef",
  "IOSurfaceRef"
]);

/**
 * ObjC generic type parameters that should map to NobjcObject.
 * These are erased at runtime; the bridge just sees "id".
 */
const GENERIC_TYPE_PARAMS = new Set(["ObjectType", "KeyType", "ValueType", "ElementType", "ResultType", "ContentType"]);

/**
 * Maps ObjC struct type names to their TypeScript interface names (defined in src/structs.ts).
 * Built dynamically from parsed struct data by setKnownStructs().
 * NS geometry aliases map to their CG counterparts (identical layout).
 */
let STRUCT_TYPE_MAP: Record<string, string> = {};

/** The set of all TS struct type names (for use by the emitter to generate imports). */
export let STRUCT_TS_TYPES = new Set<string>();

/**
 * Set the known struct types from parsed AST data.
 * Builds STRUCT_TYPE_MAP (ObjC name → TS name) and STRUCT_TS_TYPES (set of TS names).
 *
 * @param structNames - All struct definition names (e.g., "CGPoint", "NSRange")
 * @param aliases - Map of alias name → target name (e.g., "NSPoint" → "CGPoint")
 * @param internalNames - Map of public name → internal name (e.g., "NSRange" → "_NSRange")
 */
export function setKnownStructs(
  structNames: Set<string>,
  aliases: Map<string, string>,
  internalNames: Map<string, string>
): void {
  STRUCT_TYPE_MAP = {};

  // Add direct struct names — they map to themselves as TS types
  for (const name of structNames) {
    STRUCT_TYPE_MAP[name] = name;
  }

  // Add internal names mapping to the public typedef name
  // e.g., _NSRange → NSRange
  // But don't overwrite if the internal name is itself a known public struct name
  // (that case should have been handled as an alias in the parser).
  for (const [publicName, internalName] of internalNames) {
    if (!structNames.has(internalName)) {
      STRUCT_TYPE_MAP[internalName] = publicName;
    }
  }

  // Add aliases — they map to the target TS type
  // e.g., NSPoint → CGPoint (the TS type is CGPoint)
  for (const [aliasName, targetName] of aliases) {
    STRUCT_TYPE_MAP[aliasName] = targetName;
  }

  // Rebuild the TS types set
  STRUCT_TS_TYPES = new Set(Object.values(STRUCT_TYPE_MAP));
}

/**
 * Convert an ObjC selector string to the objc-js `$` convention.
 * e.g., "arrayByAddingObject:" -> "arrayByAddingObject$"
 * e.g., "initWithFrame:styleMask:" -> "initWithFrame$styleMask$"
 */
export function selectorToJS(selector: string): string {
  return selector.replace(/:/g, "$");
}

/**
 * Parse the nullable status from a qualType string.
 */
function isNullableType(qualType: string): boolean {
  return qualType.includes("_Nullable") || qualType.includes("nullable") || qualType.startsWith("nullable ");
}

/**
 * Clean up a qualType string by removing annotations.
 *
 * Clang qualType strings can contain attribute macros that are not part of the
 * actual type. These include nullability qualifiers, ownership qualifiers,
 * availability macros (API_AVAILABLE, API_DEPRECATED, etc.), CoreFoundation
 * ownership macros (CF_CONSUMED, CF_RETURNS_RETAINED, etc.), and Swift interop
 * macros (NS_REFINED_FOR_SWIFT, NS_SWIFT_UI_ACTOR, etc.).
 */
function cleanQualType(qualType: string): string {
  return (
    qualType
      .replace(/_Nonnull/g, "")
      .replace(/_Nullable/g, "")
      .replace(/_Null_unspecified/g, "")
      .replace(/\b__kindof\b/g, "")
      .replace(/\b__unsafe_unretained\b/g, "")
      .replace(/\b__strong\b/g, "")
      .replace(/\b__weak\b/g, "")
      .replace(/\b__autoreleasing\b/g, "")
      // Attribute macros: NS_*, API_*, CF_*, XPC_* (e.g. API_AVAILABLE, CF_RETURNS_RETAINED)
      .replace(/\b(?:NS|API|CF|XPC)_[A-Z_]+\b/g, "")
      // Legacy availability macros: AVAILABLE_MAC_OS_X_VERSION_*_AND_LATER etc.
      .replace(/\bAVAILABLE_MAC_OS_X_VERSION_[A-Z0-9_]+\b/g, "")
      .replace(/^struct\s+/, "")
      .trim()
  );
}

/**
 * Extract the base class name from a pointer type like "NSArray<ObjectType> *".
 */
function extractClassName(cleaned: string): string | null {
  // Match "ClassName *" or "ClassName<...> *" (with optional const prefix).
  // The generic parameter section may contain nested angle brackets
  // (e.g., "NSArray<id<NSAccessibilityRow>> *"), so we match from the
  // first '<' to the last '>' instead of using [^>]*.
  const match = cleaned.match(/^(?:const\s+)?(\w+)\s*(?:<.*>)?\s*\*$/);
  if (match) return match[1]!;

  return null;
}

/**
 * Map an Objective-C type string to a TypeScript type string.
 *
 * @param qualType The clang qualType string (e.g., "NSArray<ObjectType> * _Nonnull")
 * @param containingClass The class this type appears in (for resolving `instancetype`)
 * @param isReturnType Whether this type is used in a return position (enables conformer union expansion)
 * @returns The TypeScript type string
 */
export function mapType(
  qualType: string,
  containingClass: string,
  isReturnType = false,
  blockParamNames?: string[]
): string {
  const nullable = isNullableType(qualType);
  const cleaned = cleanQualType(qualType);

  let tsType = mapTypeInner(cleaned, containingClass, undefined, isReturnType, blockParamNames);

  if (nullable && tsType !== "void") {
    // Wrap function types in parentheses to avoid `() => void | null` being parsed as
    // "function returning (void | null)" instead of "(function returning void) | null"
    if (tsType.includes("=>")) {
      tsType = `(${tsType}) | null`;
    } else {
      tsType = `${tsType} | null`;
    }
  }

  return tsType;
}

function mapTypeInner(
  cleaned: string,
  containingClass: string,
  resolving?: Set<string>,
  isReturnType = false,
  blockParamNames?: string[]
): string {
  // Direct mappings
  if (cleaned in DIRECT_MAPPINGS) {
    return DIRECT_MAPPINGS[cleaned]!;
  }

  // Numeric types
  if (NUMERIC_TYPES.has(cleaned)) {
    return "number";
  }

  // ObjC generic type parameters (ObjectType, KeyType, etc.)
  if (GENERIC_TYPE_PARAMS.has(cleaned)) {
    return "NobjcObject";
  }

  // instancetype -> the containing class
  if (cleaned === "instancetype" || cleaned === "instancetype _Nonnull" || cleaned === "instancetype _Nullable") {
    return `_${containingClass}`;
  }

  // Struct types -> typed interfaces from src/structs.ts
  if (cleaned in STRUCT_TYPE_MAP) {
    return STRUCT_TYPE_MAP[cleaned]!;
  }

  // Block types: "void (^)(Type1, Type2)" or "ReturnType (^)(Type1, Type2)"
  // The objc-js bridge automatically converts JavaScript functions to ObjC blocks
  // when passed to a method expecting a block parameter.
  if (cleaned.includes("(^")) {
    return parseBlockType(cleaned, containingClass, blockParamNames);
  }

  // Named block reference types (rare internal types like Block_copy/Block_release)
  if (cleaned.includes("Block_")) {
    return "NobjcObject";
  }

  // Function pointer types — same runtime limitation as blocks
  if (cleaned.includes("(*)") || cleaned.includes("(*")) {
    return "NobjcObject";
  }

  // Pointer to pointer (e.g., "NSError **") - out parameters
  if (cleaned.match(/\w+\s*\*\s*\*/)) {
    return "NobjcObject";
  }

  // Void pointer
  if (cleaned === "void *" || cleaned === "const void *") {
    return "NobjcObject";
  }

  // ObjC object pointer (e.g., "NSString *", "NSArray<ObjectType> *")
  const className = extractClassName(cleaned);
  if (className) {
    // instancetype check again
    if (className === "instancetype") {
      return `_${containingClass}`;
    }

    // Known class -> use typed reference
    if (knownClasses.has(className)) {
      return `_${className}`;
    }

    // Unknown class -> NobjcObject
    return "NobjcObject";
  }

  // Enum / typedef types — use the enum type name directly for type safety.
  // First check if this is a known enum type — this is more precise than the
  // typedef resolution below and handles prefixes like AS that aren't in the list.
  if (knownIntegerEnums.has(cleaned)) {
    return cleaned;
  }
  if (knownStringEnums.has(cleaned)) {
    return cleaned;
  }

  // Resolve typedefs: look up the underlying type and recursively map it.
  // This handles cases like NSWindowPersistableFrameDescriptor → NSString *,
  // NSWindowFrameAutosaveName → NSString *, FourCharCode → unsigned int, etc.
  // without needing hardcoded heuristics or manual DIRECT_MAPPINGS entries.
  if (knownTypedefs.has(cleaned)) {
    // Guard against circular typedef chains (e.g., typedef struct X X → cleanQualType → X)
    const seen = resolving ?? new Set<string>();
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      const underlying = knownTypedefs.get(cleaned)!;
      return mapTypeInner(cleanQualType(underlying), containingClass, seen, isReturnType);
    }
  }

  // Protocol-qualified id: "id<ASAuthorizationCredential>" or "id<Proto1, Proto2>"
  //
  // For RETURN types: if the protocol has a small number of known conforming classes
  // (≤ MAX_CONFORMERS_FOR_UNION), expand to a union of those concrete classes.
  // This gives callers useful type information — e.g., credential() returns the
  // union of all ASAuthorizationCredential-conforming classes rather than an empty
  // protocol interface. The conformers set is deterministic (same for parent and
  // child classes), so override compatibility is preserved.
  //
  // For PARAMETER types: keep the protocol interface type. Expanding to a union
  // would incorrectly restrict which objects can be passed (any conforming object
  // should be accepted, not just known SDK conformers).
  const MAX_CONFORMERS_FOR_UNION = 30;
  const protoMatch = cleaned.match(/^id<(.+)>$/);
  if (protoMatch) {
    const protoNames = protoMatch[1]!.split(/,\s*/);

    // For return types with a single protocol, try conformer union expansion
    if (isReturnType && protoNames.length === 1) {
      const protoName = protoNames[0]!;
      const conformers = protocolConformers.get(protoName);
      if (conformers && conformers.size > 0 && conformers.size <= MAX_CONFORMERS_FOR_UNION) {
        const sorted = [...conformers].sort();
        return sorted.map((c) => `_${c}`).join(" | ");
      }
    }

    // Fallback: use the protocol interface type(s)
    const unionParts: string[] = [];

    for (const protoName of protoNames) {
      if (knownProtocols.has(protoName)) {
        unionParts.push(`_${protoName}`);
      } else if (knownClasses.has(protoName)) {
        // Sometimes a "protocol" name is actually a class name
        unionParts.push(`_${protoName}`);
      }
    }

    if (unionParts.length > 0) {
      // Deduplicate (a class conforming to multiple listed protocols)
      return [...new Set(unionParts)].join(" | ");
    }
    return "NobjcObject";
  }

  // Array type (C array parameters like "const ObjectType [_Nonnull]")
  if (cleaned.includes("[")) {
    return "NobjcObject";
  }

  // Fallback: unknown type -> NobjcObject
  return "NobjcObject";
}

/**
 * Map a return type, handling instancetype specially.
 *
 * CF opaque types (CGContextRef, etc.) are struct pointers at the ABI level.
 * The objc-js bridge throws TypeError for pointer return types, so we type
 * them as NobjcObject (the call will fail at runtime regardless).
 *
 * For protocol-qualified id types (e.g., id<ASAuthorizationCredential>),
 * returns a union of known conforming classes when the conformer set is small
 * enough, providing concrete type information to callers.
 */
export function mapReturnType(qualType: string, containingClass: string): string {
  const cleaned = cleanQualType(qualType);
  if (CF_OPAQUE_TYPES.has(cleaned)) {
    return "NobjcObject";
  }
  return mapType(qualType, containingClass, true);
}

/**
 * Map an ObjC qualType string to its ObjC type encoding character(s).
 *
 * Used by the function emitter to generate `{ returns: "..." }` and
 * `{ args: [...] }` options for `callFunction()`. The type encodings
 * follow the ObjC runtime convention:
 * - `v` = void, `B` = BOOL, `i` = int, `I` = unsigned int
 * - `s` = short, `S` = unsigned short, `l` = long, `L` = unsigned long
 * - `q` = long long, `Q` = unsigned long long
 * - `f` = float, `d` = double
 * - `@` = ObjC object pointer (id, NSString *, etc.)
 * - `:` = SEL, `#` = Class
 * - `*` = char *, `^v` = void *
 * - `^` = generic pointer (CF opaque types, etc.)
 *
 * @returns The type encoding string, or null if the type cannot be encoded
 *   (e.g., block types, function pointers, pointer-to-pointer).
 */
export function qualTypeToEncoding(qualType: string): string | null {
  const cleaned = cleanQualType(qualType);

  // Void
  if (cleaned === "void") return "v";

  // Boolean
  if (cleaned === "BOOL" || cleaned === "bool" || cleaned === "_Bool") return "B";

  // Integer types
  if (cleaned === "char" || cleaned === "signed char") return "c";
  if (cleaned === "unsigned char") return "C";
  if (cleaned === "short" || cleaned === "unsigned short") return cleaned.startsWith("unsigned") ? "S" : "s";
  if (cleaned === "int") return "i";
  if (cleaned === "unsigned int") return "I";
  if (cleaned === "long") return "l";
  if (cleaned === "unsigned long") return "L";
  if (cleaned === "long long") return "q";
  if (cleaned === "unsigned long long") return "Q";

  // Fixed-width integer types
  if (cleaned === "int8_t") return "c";
  if (cleaned === "uint8_t") return "C";
  if (cleaned === "int16_t") return "s";
  if (cleaned === "uint16_t") return "S";
  if (cleaned === "int32_t") return "i";
  if (cleaned === "uint32_t") return "I";
  if (cleaned === "int64_t") return "q";
  if (cleaned === "uint64_t") return "Q";

  // Platform-dependent integer types (arm64 macOS: NSInteger = long, NSUInteger = unsigned long)
  if (cleaned === "NSInteger" || cleaned === "CFIndex" || cleaned === "ssize_t") return "q";
  if (cleaned === "NSUInteger" || cleaned === "size_t") return "Q";

  // Floating point
  if (cleaned === "float") return "f";
  if (cleaned === "double" || cleaned === "CGFloat" || cleaned === "NSTimeInterval" || cleaned === "CFTimeInterval")
    return "d";

  // Unicode character
  if (cleaned === "unichar") return "S";

  // Selector
  if (cleaned === "SEL") return ":";

  // Class
  if (cleaned === "Class") return "#";

  // C string types
  if (
    cleaned === "char *" ||
    cleaned === "const char *" ||
    cleaned === "unsigned char *" ||
    cleaned === "const unsigned char *"
  )
    return "*";

  // Void pointer
  if (cleaned === "void *" || cleaned === "const void *") return "^v";

  // ObjC id (bare)
  if (cleaned === "id") return "@";

  // ObjC object pointers (NSString *, NSArray<...> *, id<Protocol>, etc.)
  if (cleaned.endsWith("*") || cleaned.startsWith("id<")) return "@";

  // Enum types that are known integers — map to their underlying integer encoding
  if (knownIntegerEnums.has(cleaned)) return "q"; // Most NS_ENUM/NS_OPTIONS use NSInteger/NSUInteger

  // String enum types (NSString * typedef aliases)
  if (knownStringEnums.has(cleaned)) return "@";

  // NSString typedef aliases from DIRECT_MAPPINGS
  if (cleaned in DIRECT_MAPPINGS) {
    const mapped = DIRECT_MAPPINGS[cleaned]!;
    if (mapped === "_NSString" || mapped === "string") return "@";
    if (mapped === "boolean") return "B";
    if (mapped === "number") return "q";
    if (mapped === "void") return "v";
    if (mapped === "NobjcObject") return "@";
  }

  // Struct types
  if (cleaned in STRUCT_TYPE_MAP) return "{" + cleaned + "}";

  // CF opaque types (struct pointers)
  if (CF_OPAQUE_TYPES.has(cleaned)) return "^";

  // Typedef resolution
  if (knownTypedefs.has(cleaned)) {
    const underlying = knownTypedefs.get(cleaned)!;
    return qualTypeToEncoding(underlying);
  }

  // Numeric types catch-all
  if (NUMERIC_TYPES.has(cleaned)) return "d";

  // Block types, function pointers, pointer-to-pointer — cannot encode simply
  if (cleaned.includes("(^") || cleaned.includes("Block_")) {
    return "@?";
  }
  if (cleaned.includes("(*)") || cleaned.match(/\w+\s*\*\s*\*/)) {
    return null;
  }

  // Unknown — default to object pointer
  return "@";
}

// --- Block type parsing ---

/**
 * Split a block's parameter list by commas, respecting nested angle brackets,
 * parentheses, and square brackets.
 *
 * e.g., "NSArray<NSString *> *, NSError *" → ["NSArray<NSString *> *", "NSError *"]
 */
function splitBlockParams(paramStr: string): string[] {
  const params: string[] = [];
  let depth = 0;
  let current = "";

  for (let i = 0; i < paramStr.length; i++) {
    const ch = paramStr[i]!;
    if (ch === "(" || ch === "<" || ch === "[") depth++;
    else if (ch === ")" || ch === ">" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      params.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) params.push(current);

  return params;
}

/**
 * Parse an ObjC block type string into a TypeScript function type.
 *
 * Handles block qualType strings like:
 * - `void (^)(id, NSUInteger, BOOL *)` → `(arg0: NobjcObject, arg1: number, arg2: NobjcObject) => void`
 * - `NSComparisonResult (^)(id, id)` → `(arg0: NobjcObject, arg1: NobjcObject) => NSComparisonResult`
 * - `void (^)(void)` → `() => void`
 * - `void (^)(NSArray<NSString *> *, NSError *)` → `(arg0: _NSArray, arg1: _NSError) => void`
 *
 * Nested blocks are handled recursively (the inner block triggers `mapTypeInner`
 * which calls `parseBlockType` again).
 *
 * @param cleaned The cleaned qualType string (nullability annotations already removed)
 * @param containingClass The class context for `instancetype` resolution
 */
function parseBlockType(cleaned: string, containingClass: string, blockParamNames?: string[]): string {
  // Find the (^ ...) separator between return type and parameter list
  const caretIdx = cleaned.indexOf("(^");
  if (caretIdx === -1) return "NobjcObject";

  // Return type is everything before (^
  let returnTypeStr = cleaned.slice(0, caretIdx).trim();
  if (!returnTypeStr) returnTypeStr = "void";

  // Find matching ) for the (^ ...) part
  let i = caretIdx + 1; // points to '^'
  let depth = 1;
  i++; // skip '^'
  while (i < cleaned.length && depth > 0) {
    if (cleaned[i] === "(") depth++;
    else if (cleaned[i] === ")") depth--;
    i++;
  }
  // i now points past the closing ) of (^...)

  // Skip whitespace to find the parameter list
  while (i < cleaned.length && cleaned[i] === " ") i++;

  // If no parameter list follows, treat as no-arg block
  if (i >= cleaned.length || cleaned[i] !== "(") {
    const tsReturn = mapTypeInner(cleanQualType(returnTypeStr), containingClass);
    return `() => ${tsReturn}`;
  }

  // Extract the parameter list
  const paramListStart = i + 1;
  depth = 1;
  i++;
  while (i < cleaned.length && depth > 0) {
    if (cleaned[i] === "(") depth++;
    else if (cleaned[i] === ")") depth--;
    i++;
  }
  const paramListEnd = i - 1;
  const paramStr = cleaned.slice(paramListStart, paramListEnd).trim();

  // Map return type
  const tsReturn = mapTypeInner(cleanQualType(returnTypeStr), containingClass);

  // Handle void/empty parameter list
  if (paramStr === "void" || paramStr === "") {
    return `() => ${tsReturn}`;
  }

  // Split and map parameter types, extracting names when present
  const paramTypes = splitBlockParams(paramStr);
  const tsParams = paramTypes.map((p, idx) => {
    const cleaned = cleanQualType(p.trim());
    const { type: typeStr, name: qualTypeName } = extractBlockParamName(cleaned);
    const tsType = mapTypeInner(typeStr, containingClass);
    // Prefer header-sourced names over qualType-embedded names (which clang usually strips)
    const headerName = blockParamNames?.[idx];
    const paramName = headerName
      ? sanitizeBlockParamName(headerName)
      : qualTypeName
        ? sanitizeBlockParamName(qualTypeName)
        : `arg${idx}`;
    return `${paramName}: ${tsType}`;
  });

  return `(${tsParams.join(", ")}) => ${tsReturn}`;
}

/**
 * C/ObjC type keywords that should NOT be treated as block parameter names.
 * When parsing a block param like "NSUInteger idx", the last word is the name —
 * but in "unsigned long", "long" is part of the type, not a name.
 */
const C_TYPE_WORDS = new Set([
  "int",
  "long",
  "short",
  "char",
  "float",
  "double",
  "unsigned",
  "signed",
  "void",
  "id",
  "bool",
  "BOOL",
  "const",
  "volatile",
  "restrict",
  "extern",
  "static",
  "inline",
  "struct",
  "union",
  "enum"
]);

/**
 * TS/JS reserved words that cannot be used as parameter names.
 * When a block parameter name collides, we append an underscore.
 */
const BLOCK_PARAM_RESERVED = new Set([
  "break",
  "case",
  "catch",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "finally",
  "for",
  "function",
  "if",
  "in",
  "instanceof",
  "new",
  "return",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "class",
  "const",
  "enum",
  "export",
  "extends",
  "import",
  "super",
  "implements",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
  "arguments",
  "eval"
]);

/**
 * Extract the parameter name from a block parameter string, if present.
 *
 * ObjC block qualType strings can include parameter names:
 * - `NSUInteger idx` → type: `NSUInteger`, name: `idx`
 * - `BOOL *stop` → type: `BOOL *`, name: `stop`
 * - `id obj` → type: `id`, name: `obj`
 * - `NSData *` → type: `NSData *`, name: null
 * - `id` → type: `id`, name: null
 *
 * For pointer types, the name follows the last `*`.
 * For non-pointer types, the name is the last word (if it's not a C type keyword).
 */
function extractBlockParamName(paramStr: string): { type: string; name: string | null } {
  const trimmed = paramStr.trim();

  // Nested block types — don't extract name from the inner signature
  if (trimmed.includes("(^")) return { type: trimmed, name: null };

  // Pointer types: check for an identifier after the last *
  const lastStar = trimmed.lastIndexOf("*");
  if (lastStar !== -1) {
    const afterStar = trimmed.slice(lastStar + 1).trim();
    if (afterStar && /^[a-zA-Z_]\w*$/.test(afterStar) && !C_TYPE_WORDS.has(afterStar)) {
      return { type: trimmed.slice(0, lastStar + 1).trim(), name: afterStar };
    }
    return { type: trimmed, name: null };
  }

  // Non-pointer types: check if the last word is a parameter name.
  // Match "TypePart(s) paramName" where paramName is a simple identifier
  // that is not a C type keyword.
  const match = trimmed.match(/^(.+?)\s+([a-zA-Z_]\w*)$/);
  if (match && !C_TYPE_WORDS.has(match[2]!)) {
    return { type: match[1]!, name: match[2]! };
  }

  return { type: trimmed, name: null };
}

/**
 * Sanitize a block parameter name for use in TypeScript function types.
 */
function sanitizeBlockParamName(name: string): string {
  if (BLOCK_PARAM_RESERVED.has(name)) return `${name}_`;
  if (!name || /^\d/.test(name)) return "arg";
  return name;
}

/**
 * Map a parameter type.
 *
 * For raw pointer parameters (`void *`, `const void *`) and CF opaque types
 * (CGContextRef, etc.), the objc-js bridge expects `Buffer` or `TypedArray`
 * at runtime (type encoding `^`). We type these as `Uint8Array` so callers
 * can pass `Buffer` or `Uint8Array` without casting.
 */
export function mapParamType(qualType: string, containingClass: string, blockParamNames?: string[]): string {
  const cleaned = cleanQualType(qualType);
  // Raw void pointers
  if (cleaned === "void *" || cleaned === "const void *") {
    const nullable = isNullableType(qualType);
    return nullable ? "Uint8Array | null" : "Uint8Array";
  }
  // CF opaque types (struct pointers with `^{...}` encoding)
  if (CF_OPAQUE_TYPES.has(cleaned)) {
    const nullable = isNullableType(qualType);
    return nullable ? "Uint8Array | null" : "Uint8Array";
  }
  return mapType(qualType, containingClass, false, blockParamNames);
}
