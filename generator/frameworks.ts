/**
 * Framework configuration for the generator.
 * Defines which frameworks to generate typings for.
 * Classes and protocols are auto-discovered from header files at generation time.
 */

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
  /** Maps class name → header file name (without .h) */
  classHeaders: Map<string, string>;
  /** Maps protocol name → header file name (without .h) */
  protocolHeaders: Map<string, string>;
}

const SDK_PATH =
  "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk";

export const FRAMEWORK_BASES: FrameworkBase[] = [
  {
    name: "Foundation",
    libraryPath:
      "/System/Library/Frameworks/Foundation.framework/Foundation",
    headersPath: `${SDK_PATH}/System/Library/Frameworks/Foundation.framework/Headers`,
    extraHeaders: {
      // alloc, init, new, copy, isKindOfClass:, respondsToSelector:, etc.
      // are defined in the ObjC runtime header, not the Foundation NSObject.h
      NSObject: `${SDK_PATH}/usr/include/objc/NSObject.h`,
    },
  },
  {
    name: "AppKit",
    libraryPath: "/System/Library/Frameworks/AppKit.framework/AppKit",
    headersPath: `${SDK_PATH}/System/Library/Frameworks/AppKit.framework/Headers`,
  },
  {
    name: "WebKit",
    libraryPath: "/System/Library/Frameworks/WebKit.framework/WebKit",
    headersPath: `${SDK_PATH}/System/Library/Frameworks/WebKit.framework/Headers`,
    preIncludes: ["WebKit/WKFoundation.h"],
  },
];

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
