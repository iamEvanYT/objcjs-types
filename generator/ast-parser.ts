/**
 * Parses clang AST JSON to extract Objective-C class/protocol declarations.
 */

import type { ClangASTNode } from "./clang.ts";

export interface ObjCMethod {
  selector: string;
  returnType: string;
  parameters: { name: string; type: string }[];
  isClassMethod: boolean;
  isDeprecated: boolean;
  deprecationMessage?: string;
  description?: string;
}

export interface ObjCProperty {
  name: string;
  type: string;
  readonly: boolean;
  isClassProperty: boolean;
  isDeprecated: boolean;
  deprecationMessage?: string;
  description?: string;
}

export interface ObjCClass {
  name: string;
  superclass: string | null;
  protocols: string[];
  instanceMethods: ObjCMethod[];
  classMethods: ObjCMethod[];
  properties: ObjCProperty[];
}

export interface ObjCProtocol {
  name: string;
  extendedProtocols: string[];
  instanceMethods: ObjCMethod[];
  classMethods: ObjCMethod[];
  properties: ObjCProperty[];
}

// --- Struct types ---

export interface ObjCStructField {
  /** The C field name from the struct definition */
  name: string;
  /** The C type string (e.g., "CGFloat", "CGPoint") */
  type: string;
}

export interface ObjCStruct {
  /** The public typedef name (e.g., "CGPoint", "NSRange", "NSDecimal") */
  name: string;
  /** The internal struct name if different (e.g., "_NSRange" for NSRange) */
  internalName?: string;
  /** Fields from the struct definition */
  fields: ObjCStructField[];
}

/**
 * A typedef alias from one struct name to another (e.g., NSPoint → CGPoint).
 */
export interface ObjCStructAlias {
  /** The alias name (e.g., "NSPoint") */
  name: string;
  /** The target type name (e.g., "CGPoint") */
  target: string;
}

// --- Enum types ---

export interface ObjCEnumValue {
  /** The constant name (e.g., "ASAuthorizationPublicKeyCredentialLargeBlobSupportRequirementRequired") */
  name: string;
  /** The integer value as a string (from ConstantExpr.value), or null if implicit */
  value: string | null;
}

export interface ObjCIntegerEnum {
  kind: "integer";
  /** The enum type name (e.g., "ASAuthorizationPublicKeyCredentialLargeBlobSupportRequirement") */
  name: string;
  /** The underlying integer type (e.g., "NSInteger", "NSUInteger") */
  underlyingType: string;
  /** Whether this is an NS_OPTIONS (bitfield) vs NS_ENUM */
  isOptions: boolean;
  /** Ordered list of enum constants with their values */
  values: ObjCEnumValue[];
}

export interface ObjCStringEnumValue {
  /** The full extern symbol name (e.g., "ASAuthorizationPublicKeyCredentialUserVerificationPreferencePreferred") */
  symbolName: string;
  /** Short key after stripping the enum name prefix (e.g., "Preferred") */
  shortName: string;
  /** The resolved string value from the framework binary (e.g., "preferred"), or null if unresolved */
  value: string | null;
}

export interface ObjCStringEnum {
  kind: "string";
  /** The enum type name (e.g., "ASAuthorizationPublicKeyCredentialUserVerificationPreference") */
  name: string;
  /** Extern NSString * constants with their resolved values */
  values: ObjCStringEnumValue[];
}

// --- Helpers for extracting doc comments and deprecation info ---

/**
 * Recursively extract text from a FullComment AST node.
 * Joins all TextComment leaf nodes into a single string.
 */
function extractCommentText(node: ClangASTNode): string {
  const texts: string[] = [];

  function walk(n: ClangASTNode): void {
    if (n.kind === "TextComment") {
      const text = (n as any).text as string | undefined;
      if (text) texts.push(text);
    }
    if (n.inner) {
      for (const child of n.inner) {
        walk(child);
      }
    }
  }

  walk(node);

  // Join and clean up whitespace
  return texts
    .map((t) => t.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the description string from a declaration node's FullComment children.
 */
function extractDescription(node: ClangASTNode): string | undefined {
  if (!node.inner) return undefined;
  for (const child of node.inner) {
    if (child.kind === "FullComment") {
      const text = extractCommentText(child);
      if (text) return text;
    }
  }
  return undefined;
}

/** Regex patterns that indicate a deprecated API in Objective-C header source. */
const DEPRECATION_PATTERNS = [
  { regex: /API_DEPRECATED\s*\(\s*"([^"]*)"/, group: 1 },
  { regex: /API_DEPRECATED_WITH_REPLACEMENT\s*\(\s*"([^"]*)"/, group: 1 },
  { regex: /NS_DEPRECATED_MAC\s*\(/, group: -1 },
  { regex: /NS_DEPRECATED\s*\(/, group: -1 },
  { regex: /DEPRECATED_ATTRIBUTE/, group: -1 },
  { regex: /__deprecated_msg\s*\(\s*"([^"]*)"/, group: 1 },
] as const;

/**
 * Get the line number from a ClangASTNode's loc field.
 * Handles both direct locations and expansion locations.
 */
function getLocLine(node: ClangASTNode): number | undefined {
  const loc = node.loc as Record<string, any> | undefined;
  if (!loc) return undefined;
  if (typeof loc.line === "number") return loc.line;
  if (loc.expansionLoc && typeof loc.expansionLoc.line === "number") {
    return loc.expansionLoc.line;
  }
  return undefined;
}

/**
 * Scan the header source lines around a declaration's location for
 * deprecation macros. Returns { isDeprecated, message } if found.
 */
function scanForDeprecation(
  node: ClangASTNode,
  headerLines: string[] | undefined
): { isDeprecated: boolean; message?: string } {
  if (!headerLines) return { isDeprecated: false };

  const line = getLocLine(node);
  if (!line || line < 1 || line > headerLines.length) {
    return { isDeprecated: false };
  }

  // Scan the declaration line and a few lines after (macros can wrap to next lines)
  const startLine = Math.max(0, line - 1);
  const endLine = Math.min(headerLines.length, line + 5);
  const sourceChunk = headerLines.slice(startLine, endLine).join(" ");

  for (const pattern of DEPRECATION_PATTERNS) {
    const match = pattern.regex.exec(sourceChunk);
    if (match) {
      const message = pattern.group >= 0 ? match[pattern.group]?.trim() : undefined;
      return {
        isDeprecated: true,
        message: message || undefined,
      };
    }
  }

  return { isDeprecated: false };
}

/**
 * Parse a clang AST root node and extract all ObjC class declarations.
 * Merges categories into their base class.
 *
 * @param headerLines - Split lines of the header file for deprecation scanning.
 *   Pass undefined to skip header-based deprecation detection.
 */
export function parseAST(
  root: ClangASTNode,
  targetClasses: Set<string>,
  headerLines?: string[]
): Map<string, ObjCClass> {
  const classes = new Map<string, ObjCClass>();

  function getOrCreateClass(name: string): ObjCClass {
    let cls = classes.get(name);
    if (!cls) {
      cls = {
        name,
        superclass: null,
        protocols: [],
        instanceMethods: [],
        classMethods: [],
        properties: [],
      };
      classes.set(name, cls);
    }
    return cls;
  }

  function isDeprecated(node: ClangASTNode): boolean {
    if (!node.inner) return false;
    return node.inner.some(
      (child) => child.kind === "DeprecatedAttr"
    );
  }

  function isUnavailable(node: ClangASTNode): boolean {
    if (!node.inner) return false;
    return node.inner.some((child) => child.kind === "UnavailableAttr");
  }

  function extractMethod(node: ClangASTNode): ObjCMethod | null {
    if (node.kind !== "ObjCMethodDecl") return null;
    if (node.isImplicit) return null;
    if (isUnavailable(node)) return null;

    const selector = node.name ?? "";
    const returnType = node.returnType?.qualType ?? "void";
    const isClassMethod = node.instance === false;
    const attrDeprecated = isDeprecated(node);
    const sourceDeprecation = scanForDeprecation(node, headerLines);
    const deprecated = attrDeprecated || sourceDeprecation.isDeprecated;
    const description = extractDescription(node);

    const parameters: { name: string; type: string }[] = [];
    if (node.inner) {
      for (const child of node.inner) {
        if (child.kind === "ParmVarDecl") {
          parameters.push({
            name: child.name ?? "arg",
            type: child.type?.qualType ?? "id",
          });
        }
      }
    }

    return {
      selector,
      returnType,
      parameters,
      isClassMethod,
      isDeprecated: deprecated,
      deprecationMessage: sourceDeprecation.message,
      description,
    };
  }

  function extractProperty(node: ClangASTNode): ObjCProperty | null {
    if (node.kind !== "ObjCPropertyDecl") return null;
    if (node.isImplicit) return null;

    const name = node.name ?? "";
    const type = node.type?.qualType ?? "id";
    // ObjC properties are readwrite by default; only explicitly readonly ones are read-only
    const readonly = node.readonly === true;
    // Class properties have "class": true in the AST node
    const isClassProperty = (node as any)["class"] === true;
    const attrDeprecated = isDeprecated(node);
    const sourceDeprecation = scanForDeprecation(node, headerLines);
    const deprecated = attrDeprecated || sourceDeprecation.isDeprecated;
    const description = extractDescription(node);

    return {
      name,
      type,
      readonly,
      isClassProperty,
      isDeprecated: deprecated,
      deprecationMessage: sourceDeprecation.message,
      description,
    };
  }

  function processInterfaceOrCategory(
    node: ClangASTNode,
    className: string
  ): void {
    if (!targetClasses.has(className)) return;

    const cls = getOrCreateClass(className);

    // Set superclass from interface declarations
    if (node.kind === "ObjCInterfaceDecl" && node.super) {
      cls.superclass = node.super.name;
    }

    // Set protocols
    if (node.protocols) {
      for (const proto of node.protocols) {
        if (!cls.protocols.includes(proto.name)) {
          cls.protocols.push(proto.name);
        }
      }
    }

    if (!node.inner) return;

    // Track selectors we've already added (to handle categories extending the same class)
    const existingInstanceSelectors = new Set(
      cls.instanceMethods.map((m) => m.selector)
    );
    const existingClassSelectors = new Set(
      cls.classMethods.map((m) => m.selector)
    );
    const existingProperties = new Set(cls.properties.map((p) => p.name));

    for (const child of node.inner) {
      if (child.kind === "ObjCMethodDecl") {
        const method = extractMethod(child);
        if (!method) continue;

        if (method.isClassMethod) {
          if (!existingClassSelectors.has(method.selector)) {
            cls.classMethods.push(method);
            existingClassSelectors.add(method.selector);
          }
        } else {
          if (!existingInstanceSelectors.has(method.selector)) {
            cls.instanceMethods.push(method);
            existingInstanceSelectors.add(method.selector);
          }
        }
      } else if (child.kind === "ObjCPropertyDecl") {
        const prop = extractProperty(child);
        if (prop && !existingProperties.has(prop.name)) {
          cls.properties.push(prop);
          existingProperties.add(prop.name);
        }
      }
    }
  }

  function walk(node: ClangASTNode): void {
    if (node.kind === "ObjCInterfaceDecl" && node.name) {
      processInterfaceOrCategory(node, node.name);
    } else if (node.kind === "ObjCCategoryDecl" && node.interface?.name) {
      processInterfaceOrCategory(node, node.interface.name);
    } else if (node.kind === "ObjCProtocolDecl" && node.name) {
      // Merge protocol methods into matching class (e.g., NSObject protocol → NSObject class).
      // The NSObject class conforms to the NSObject protocol, which defines
      // isEqual:, isKindOfClass:, respondsToSelector:, performSelector:, etc.
      if (targetClasses.has(node.name)) {
        processInterfaceOrCategory(node, node.name);
      }
    }

    if (node.inner) {
      for (const child of node.inner) {
        walk(child);
      }
    }
  }

  walk(root);
  return classes;
}

/**
 * Parse a clang AST root node and extract ObjC protocol declarations.
 * Returns a map of protocol name → ObjCProtocol for protocols in the target set.
 *
 * @param headerLines - Split lines of the header file for deprecation scanning.
 */
export function parseProtocols(
  root: ClangASTNode,
  targetProtocols: Set<string>,
  headerLines?: string[]
): Map<string, ObjCProtocol> {
  const protocols = new Map<string, ObjCProtocol>();

  function isDeprecated(node: ClangASTNode): boolean {
    if (!node.inner) return false;
    return node.inner.some(
      (child) => child.kind === "DeprecatedAttr"
    );
  }

  function isUnavailable(node: ClangASTNode): boolean {
    if (!node.inner) return false;
    return node.inner.some((child) => child.kind === "UnavailableAttr");
  }

  function extractMethod(node: ClangASTNode): ObjCMethod | null {
    if (node.kind !== "ObjCMethodDecl") return null;
    if (node.isImplicit) return null;
    if (isUnavailable(node)) return null;

    const selector = node.name ?? "";
    const returnType = node.returnType?.qualType ?? "void";
    const isClassMethod = node.instance === false;
    const attrDeprecated = isDeprecated(node);
    const sourceDeprecation = scanForDeprecation(node, headerLines);
    const deprecated = attrDeprecated || sourceDeprecation.isDeprecated;
    const description = extractDescription(node);

    const parameters: { name: string; type: string }[] = [];
    if (node.inner) {
      for (const child of node.inner) {
        if (child.kind === "ParmVarDecl") {
          parameters.push({
            name: child.name ?? "arg",
            type: child.type?.qualType ?? "id",
          });
        }
      }
    }

    return {
      selector,
      returnType,
      parameters,
      isClassMethod,
      isDeprecated: deprecated,
      deprecationMessage: sourceDeprecation.message,
      description,
    };
  }

  function extractProperty(node: ClangASTNode): ObjCProperty | null {
    if (node.kind !== "ObjCPropertyDecl") return null;
    if (node.isImplicit) return null;

    const name = node.name ?? "";
    const type = node.type?.qualType ?? "id";
    const readonly = node.readonly === true;
    const isClassProperty = (node as any)["class"] === true;
    const attrDeprecated = isDeprecated(node);
    const sourceDeprecation = scanForDeprecation(node, headerLines);
    const deprecated = attrDeprecated || sourceDeprecation.isDeprecated;
    const description = extractDescription(node);

    return {
      name,
      type,
      readonly,
      isClassProperty,
      isDeprecated: deprecated,
      deprecationMessage: sourceDeprecation.message,
      description,
    };
  }

  function processProtocolDecl(node: ClangASTNode): void {
    const name = node.name ?? "";
    if (!targetProtocols.has(name)) return;

    const proto: ObjCProtocol = {
      name,
      extendedProtocols: [],
      instanceMethods: [],
      classMethods: [],
      properties: [],
    };

    // Collect extended protocols
    if (node.protocols) {
      for (const p of node.protocols) {
        proto.extendedProtocols.push(p.name);
      }
    }

    if (!node.inner) {
      protocols.set(name, proto);
      return;
    }

    const existingInstanceSelectors = new Set<string>();
    const existingClassSelectors = new Set<string>();
    const existingProperties = new Set<string>();

    for (const child of node.inner) {
      if (child.kind === "ObjCMethodDecl") {
        const method = extractMethod(child);
        if (!method) continue;

        if (method.isClassMethod) {
          if (!existingClassSelectors.has(method.selector)) {
            proto.classMethods.push(method);
            existingClassSelectors.add(method.selector);
          }
        } else {
          if (!existingInstanceSelectors.has(method.selector)) {
            proto.instanceMethods.push(method);
            existingInstanceSelectors.add(method.selector);
          }
        }
      } else if (child.kind === "ObjCPropertyDecl") {
        const prop = extractProperty(child);
        if (prop && !existingProperties.has(prop.name)) {
          proto.properties.push(prop);
          existingProperties.add(prop.name);
        }
      }
    }

    protocols.set(name, proto);
  }

  function walk(node: ClangASTNode): void {
    if (node.kind === "ObjCProtocolDecl" && node.name) {
      processProtocolDecl(node);
    }

    if (node.inner) {
      for (const child of node.inner) {
        walk(child);
      }
    }
  }

  walk(root);
  return protocols;
}

/**
 * Parse a clang AST root node and extract integer enums (NS_ENUM / NS_OPTIONS).
 *
 * Integer enums appear as EnumDecl nodes with a fixedUnderlyingType.
 * NS_OPTIONS enums additionally have a FlagEnumAttr child.
 * Each EnumConstantDecl child represents a constant; its value comes from
 * a nested ConstantExpr node (always the fully-computed integer as a string).
 *
 * @param targetEnums - Set of enum names to extract (from discovery)
 */
export function parseIntegerEnums(
  root: ClangASTNode,
  targetEnums: Set<string>
): Map<string, ObjCIntegerEnum> {
  const enums = new Map<string, ObjCIntegerEnum>();

  function walk(node: ClangASTNode): void {
    if (node.kind === "EnumDecl" && node.name && targetEnums.has(node.name)) {
      if (node.fixedUnderlyingType) {
        const hasConstants = node.inner?.some(
          (child) => child.kind === "EnumConstantDecl"
        ) ?? false;

        // Skip forward declarations (no EnumConstantDecl children).
        // The full definition with constants may appear later with previousDecl set.
        if (!hasConstants) {
          // Only record if we haven't seen a definition with values yet
          if (!enums.has(node.name)) {
            enums.set(node.name, {
              kind: "integer",
              name: node.name,
              underlyingType: node.fixedUnderlyingType.qualType,
              isOptions: false,
              values: [],
            });
          }
        } else {
          const isOptions = node.inner?.some(
            (child) => child.kind === "FlagEnumAttr"
          ) ?? false;

          const values: ObjCEnumValue[] = [];
          let implicitNextValue = 0;

          for (const child of node.inner!) {
            if (child.kind === "EnumConstantDecl" && child.name) {
              // Extract value from ConstantExpr if present
              let value: string | null = null;
              if (child.inner) {
                const constExpr = findConstantExpr(child);
                if (constExpr?.value !== undefined) {
                  value = constExpr.value;
                  implicitNextValue = parseInt(value, 10) + 1;
                }
              }
              if (value === null) {
                value = String(implicitNextValue);
                implicitNextValue++;
              }
              values.push({ name: child.name, value });
            }
          }

          // Always overwrite — the definition with constants is authoritative
          enums.set(node.name, {
            kind: "integer",
            name: node.name,
            underlyingType: node.fixedUnderlyingType.qualType,
            isOptions,
            values,
          });
        }
      }
    }

    if (node.inner) {
      for (const child of node.inner) {
        walk(child);
      }
    }
  }

  walk(root);
  return enums;
}

/**
 * Recursively find the first ConstantExpr node in a tree.
 * ConstantExpr may be nested under ImplicitCastExpr or other intermediate nodes.
 */
function findConstantExpr(node: ClangASTNode): ClangASTNode | null {
  if (node.kind === "ConstantExpr" && node.value !== undefined) {
    return node;
  }
  if (node.inner) {
    for (const child of node.inner) {
      const found = findConstantExpr(child);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Parse a clang AST root node and extract string enums (NS_TYPED_EXTENSIBLE_ENUM etc.).
 *
 * String enums appear as TypedefDecl nodes with a SwiftNewTypeAttr child
 * and a type.qualType of "NSString *". The individual values are VarDecl
 * nodes with storageClass "extern" whose type.typeAliasDeclId links back
 * to the TypedefDecl's id.
 *
 * @param targetEnums - Set of string enum names to extract (from discovery)
 */
export function parseStringEnums(
  root: ClangASTNode,
  targetEnums: Set<string>
): Map<string, ObjCStringEnum> {
  const enums = new Map<string, ObjCStringEnum>();
  // Map from TypedefDecl id → enum name, for linking VarDecls
  const typedefIdToName = new Map<string, string>();

  function walkForTypedefs(node: ClangASTNode): void {
    if (node.kind === "TypedefDecl" && node.name && targetEnums.has(node.name)) {
      // Check for SwiftNewTypeAttr in inner
      const hasSwiftNewType = node.inner?.some(
        (child) => child.kind === "SwiftNewTypeAttr"
      ) ?? false;

      // Check that the underlying type is NSString *
      const qualType = node.type?.qualType ?? "";
      const isStringType =
        qualType === "NSString *" ||
        qualType.includes("NSString") ||
        (node.type?.desugaredQualType ?? "").includes("NSString");

      if (hasSwiftNewType && isStringType) {
        typedefIdToName.set(node.id, node.name);
        if (!enums.has(node.name)) {
          enums.set(node.name, {
            kind: "string",
            name: node.name,
            values: [],
          });
        }
      }
    }

    if (node.inner) {
      for (const child of node.inner) {
        walkForTypedefs(child);
      }
    }
  }

  function walkForVarDecls(node: ClangASTNode): void {
    if (
      node.kind === "VarDecl" &&
      node.name &&
      node.storageClass === "extern" &&
      node.type?.typeAliasDeclId
    ) {
      const enumName = typedefIdToName.get(node.type.typeAliasDeclId);
      if (enumName) {
        const enumDef = enums.get(enumName);
        if (enumDef) {
          // Strip the enum name prefix to get the short name
          let shortName = node.name;
          if (shortName.startsWith(enumName)) {
            shortName = shortName.slice(enumName.length);
          }
          if (!shortName || /^\d/.test(shortName)) {
            shortName = node.name;
          }
          enumDef.values.push({
            symbolName: node.name,
            shortName,
            value: null, // Resolved later by resolve-strings.ts
          });
        }
      }
    }

    if (node.inner) {
      for (const child of node.inner) {
        walkForVarDecls(child);
      }
    }
  }

  // First pass: find TypedefDecl nodes
  walkForTypedefs(root);
  // Second pass: find VarDecl nodes that reference the typedefs
  walkForVarDecls(root);

  return enums;
}

// --- Struct parsing ---

/**
 * Parse a clang AST root node and extract struct definitions and struct typedef aliases.
 *
 * Structs appear as:
 * 1. Named RecordDecl with tagUsed:"struct", containing FieldDecl children
 *    e.g., `struct CGPoint { CGFloat x; CGFloat y; }`
 * 2. Anonymous RecordDecl wrapped by TypedefDecl
 *    e.g., `typedef struct { ... } NSDecimal;`
 * 3. TypedefDecl aliasing one struct to another
 *    e.g., `typedef CGPoint NSPoint;`
 *
 * Returns { structs, aliases } where:
 * - structs: Map<name, ObjCStruct> — all struct definitions (keyed by public name)
 * - aliases: ObjCStructAlias[] — typedef aliases between structs
 */
export function parseStructs(root: ClangASTNode): {
  structs: Map<string, ObjCStruct>;
  aliases: ObjCStructAlias[];
} {
  const structs = new Map<string, ObjCStruct>();
  const aliases: ObjCStructAlias[] = [];

  // Map from RecordDecl id → struct definition (for linking typedefs to anonymous structs)
  const recordById = new Map<string, { name: string; fields: ObjCStructField[] }>();
  // Set of all known struct names (for detecting typedef aliases between structs)
  const knownStructNames = new Set<string>();
  // Map of internal struct names to their RecordDecl data (for typedef linking)
  const recordByName = new Map<string, { fields: ObjCStructField[] }>();

  /** Extract fields from a RecordDecl's inner children. */
  function extractFields(node: ClangASTNode): ObjCStructField[] {
    const fields: ObjCStructField[] = [];
    if (!node.inner) return fields;
    for (const child of node.inner) {
      if (child.kind === "FieldDecl" && child.name) {
        fields.push({
          name: child.name,
          type: child.type?.qualType ?? "int",
        });
      }
    }
    return fields;
  }

  // First pass: collect all RecordDecl nodes (struct definitions)
  function walkForRecords(node: ClangASTNode): void {
    if (
      node.kind === "RecordDecl" &&
      (node as any).tagUsed === "struct"
    ) {
      const fields = extractFields(node);
      // Only record definitions with fields (skip forward declarations)
      if (fields.length > 0) {
        recordById.set(node.id, {
          name: node.name ?? "",
          fields,
        });
        if (node.name && node.name !== "(anonymous)") {
          knownStructNames.add(node.name);
          recordByName.set(node.name, { fields });

          // Named structs are directly usable (e.g., struct CGPoint), but
          // underscore-prefixed names (e.g., _NSRange) are internal C names
          // that will get a public typedef later — don't add them to structs
          // directly, only to recordByName for lookup.
          if (!node.name.startsWith("_")) {
            structs.set(node.name, {
              name: node.name,
              fields,
            });
          }
        }
      }
    }

    if (node.inner) {
      for (const child of node.inner) {
        walkForRecords(child);
      }
    }
  }

  // Second pass: find TypedefDecl nodes that reference structs
  function walkForTypedefs(node: ClangASTNode): void {
    if (node.kind === "TypedefDecl" && node.name) {
      const qualType = node.type?.qualType ?? "";

      // Case 1: Typedef wrapping an anonymous struct (inline definition)
      // The RecordDecl appears as a direct child of the TypedefDecl
      if (node.inner) {
        for (const child of node.inner) {
          if (child.kind === "RecordDecl" && (child as any).tagUsed === "struct") {
            const fields = extractFields(child);
            if (fields.length > 0) {
              structs.set(node.name, {
                name: node.name,
                fields,
              });
              knownStructNames.add(node.name);
              return; // Don't also check typedef alias case
            }
          }
        }
      }

      // Case 2: Typedef aliasing a named struct (e.g., typedef struct _NSRange NSRange)
      // The qualType will be "struct _NSRange" or just "_NSRange"
      const structMatch = qualType.match(/^(?:struct\s+)?(\w+)$/);
      if (structMatch) {
        const targetName = structMatch[1]!;

        // Self-referencing typedef (e.g., typedef struct CGRect CGRect, or
        // typedef struct NS_SWIFT_SENDABLE { ... } NSOperatingSystemVersion).
        // For the NS_SWIFT_SENDABLE pattern, the RecordDecl is anonymous but
        // referenced via ownedTagDecl in the inner ElaboratedType node.
        if (targetName === node.name) {
          // Check if there's an ownedTagDecl referencing an anonymous struct
          if (node.inner) {
            for (const child of node.inner) {
              const ownedId = (child as any).ownedTagDecl?.id;
              if (ownedId) {
                const record = recordById.get(ownedId);
                if (record && (!record.name || record.name === "(anonymous)") && record.fields.length > 0) {
                  structs.set(node.name, {
                    name: node.name,
                    fields: record.fields,
                  });
                  knownStructNames.add(node.name);
                  return;
                }
              }
            }
          }
          return; // Genuine self-reference, skip
        }

        // Check if target is a known record (C struct definition)
        const targetRecord = recordByName.get(targetName);
        if (targetRecord) {
          // If the target is a public struct name (not underscore-prefixed internal),
          // this typedef creates an alias. E.g., typedef CGRect NSRect means NSRect
          // is an alias of CGRect. But typedef struct _NSRange NSRange means NSRange
          // is the public name for the internal _NSRange struct.
          const isInternalName = targetName.startsWith("_");
          if (!isInternalName && structs.has(targetName)) {
            // Target is a public struct name — create an alias
            aliases.push({ name: node.name, target: targetName });
            knownStructNames.add(node.name);
            return;
          }

          // Otherwise, this is a typedef for a private internal struct name:
          // typedef struct _NSRange NSRange
          structs.set(node.name, {
            name: node.name,
            internalName: targetName,
            fields: targetRecord.fields,
          });
          knownStructNames.add(node.name);
          return;
        }

        // Check if target is another typedef'd struct name (e.g., NSPoint → CGPoint)
        if (knownStructNames.has(targetName)) {
          // Resolve through existing aliases to find the canonical struct name
          let resolvedTarget = targetName;
          for (const alias of aliases) {
            if (alias.name === targetName) {
              resolvedTarget = alias.target;
              break;
            }
          }
          aliases.push({ name: node.name, target: resolvedTarget });
          knownStructNames.add(node.name);
          return;
        }
      }
    }

    if (node.inner) {
      for (const child of node.inner) {
        walkForTypedefs(child);
      }
    }
  }

  walkForRecords(root);
  walkForTypedefs(root);

  return { structs, aliases };
}
