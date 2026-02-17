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
}

export interface ObjCProperty {
  name: string;
  type: string;
  readonly: boolean;
  isClassProperty: boolean;
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

/**
 * Parse a clang AST root node and extract all ObjC class declarations.
 * Merges categories into their base class.
 */
export function parseAST(
  root: ClangASTNode,
  targetClasses: Set<string>
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
    const deprecated = isDeprecated(node);

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

    return { name, type, readonly, isClassProperty };
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
 */
export function parseProtocols(
  root: ClangASTNode,
  targetProtocols: Set<string>
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
    const deprecated = isDeprecated(node);

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
    };
  }

  function extractProperty(node: ClangASTNode): ObjCProperty | null {
    if (node.kind !== "ObjCPropertyDecl") return null;
    if (node.isImplicit) return null;

    const name = node.name ?? "";
    const type = node.type?.qualType ?? "id";
    const readonly = node.readonly === true;
    const isClassProperty = (node as any)["class"] === true;

    return { name, type, readonly, isClassProperty };
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
