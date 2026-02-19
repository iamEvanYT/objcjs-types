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
export function mapType(qualType: string, containingClass: string, isReturnType = false): string {
  const nullable = isNullableType(qualType);
  const cleaned = cleanQualType(qualType);

  let tsType = mapTypeInner(cleaned, containingClass, undefined, isReturnType);

  if (nullable && tsType !== "void") {
    tsType = `${tsType} | null`;
  }

  return tsType;
}

function mapTypeInner(cleaned: string, containingClass: string, resolving?: Set<string>, isReturnType = false): string {
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
  // At runtime, blocks have type encoding `@?` which the bridge handles via
  // the `@` (id) case — only NobjcObject is accepted/returned, not JS functions.
  if (cleaned.includes("(^") || cleaned.includes("Block_")) {
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
 * Map a parameter type.
 *
 * For raw pointer parameters (`void *`, `const void *`) and CF opaque types
 * (CGContextRef, etc.), the objc-js bridge expects `Buffer` or `TypedArray`
 * at runtime (type encoding `^`). We type these as `Uint8Array` so callers
 * can pass `Buffer` or `Uint8Array` without casting.
 */
export function mapParamType(qualType: string, containingClass: string): string {
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
  return mapType(qualType, containingClass);
}
