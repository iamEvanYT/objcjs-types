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
