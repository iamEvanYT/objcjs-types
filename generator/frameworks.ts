/**
 * Framework configuration and auto-discovery.
 * Scans the macOS SDK to find all ObjC frameworks with headers,
 * then builds configuration objects for each.
 */

import { readdir } from "fs/promises";
import { existsSync } from "fs";

/** Static framework configuration — just paths and optional overrides. */
export interface FrameworkBase {
  /** Framework name (e.g., "Foundation") */
  name: string;
  /** Path to the framework binary (for NobjcLibrary) */
  libraryPath: string;
  /** Path to the framework headers directory */
  headersPath: string;
  /** Optional pre-includes for fallback clang mode (without -fmodules) */
  preIncludes?: string[];
  /** Extra headers to parse for additional class members (class name → absolute path) */
  extraHeaders?: Record<string, string>;
}

/** Resolved framework config with discovered classes and protocols. */
export interface FrameworkConfig extends FrameworkBase {
  /** All discovered class names */
  classes: string[];
  /** All discovered protocol names */
  protocols: string[];
  /** All discovered integer enum names (NS_ENUM / NS_OPTIONS) */
  integerEnums: string[];
  /** All discovered string enum names (NS_TYPED_EXTENSIBLE_ENUM etc.) */
  stringEnums: string[];
  /** Maps class name → header file name (without .h) */
  classHeaders: Map<string, string>;
  /** Maps protocol name → header file name (without .h) */
  protocolHeaders: Map<string, string>;
  /** Maps integer enum name → header file name (without .h) */
  integerEnumHeaders: Map<string, string>;
  /** Maps string enum name → header file name (without .h) */
  stringEnumHeaders: Map<string, string>;
}

export const SDK_PATH =
  "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk";

const FRAMEWORKS_DIR = `${SDK_PATH}/System/Library/Frameworks`;

// --- Edge-case overrides for specific frameworks ---

/** Extra headers to parse for additional class members (class name → path). */
const EXTRA_HEADERS: Record<string, Record<string, string>> = {
  Foundation: {
    // alloc, init, new, copy, isKindOfClass:, respondsToSelector:, etc.
    // are defined in the ObjC runtime header, not the Foundation NSObject.h
    NSObject: `${SDK_PATH}/usr/include/objc/NSObject.h`,
  },
};

/** Additional pre-includes for fallback clang mode (without -fmodules). */
const PRE_INCLUDES: Record<string, string[]> = {
  WebKit: ["WebKit/WKFoundation.h"],
  AuthenticationServices: ["AuthenticationServices/ASFoundation.h"],
};

/**
 * Discover all ObjC frameworks in the macOS SDK.
 * Scans the Frameworks directory for .framework bundles that have
 * a Headers/ directory with .h files. Returns FrameworkBase configs
 * with paths derived from the standard bundle structure.
 *
 * Foundation is always sorted first (it's the universal base framework).
 */
export async function discoverAllFrameworks(): Promise<FrameworkBase[]> {
  const entries = await readdir(FRAMEWORKS_DIR);
  const frameworks: FrameworkBase[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".framework")) continue;
    // Skip private/internal frameworks (underscore-prefixed)
    if (entry.startsWith("_")) continue;

    const name = entry.slice(0, -".framework".length);
    const headersPath = `${FRAMEWORKS_DIR}/${entry}/Headers`;

    // Must have a Headers directory with .h files
    if (!existsSync(headersPath)) continue;
    const headers = await readdir(headersPath);
    if (!headers.some((h) => h.endsWith(".h"))) continue;

    const fw: FrameworkBase = {
      name,
      libraryPath: `/System/Library/Frameworks/${entry}/${name}`,
      headersPath,
      ...(EXTRA_HEADERS[name] ? { extraHeaders: EXTRA_HEADERS[name] } : {}),
      ...(PRE_INCLUDES[name] ? { preIncludes: PRE_INCLUDES[name] } : {}),
    };

    frameworks.push(fw);
  }

  // Foundation first (universal base), then alphabetical
  frameworks.sort((a, b) => {
    if (a.name === "Foundation") return -1;
    if (b.name === "Foundation") return 1;
    return a.name.localeCompare(b.name);
  });

  return frameworks;
}

/**
 * Get the header file path for a class using discovered header mapping.
 */
export function getHeaderPath(
  framework: FrameworkConfig,
  className: string
): string {
  const headerName = framework.classHeaders.get(className) ?? className;
  return `${framework.headersPath}/${headerName}.h`;
}

/**
 * Get the header file path for a protocol using discovered header mapping.
 */
export function getProtocolHeaderPath(
  framework: FrameworkConfig,
  protocolName: string
): string {
  const headerName = framework.protocolHeaders.get(protocolName) ?? protocolName;
  return `${framework.headersPath}/${headerName}.h`;
}

/**
 * Get the header file path for an enum using discovered header mapping.
 */
export function getEnumHeaderPath(
  framework: FrameworkConfig,
  enumName: string,
  kind: "integer" | "string"
): string {
  const headers = kind === "integer" ? framework.integerEnumHeaders : framework.stringEnumHeaders;
  const headerName = headers.get(enumName) ?? enumName;
  return `${framework.headersPath}/${headerName}.h`;
}
