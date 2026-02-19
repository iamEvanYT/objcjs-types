/**
 * Resolves extern NSString * constant values at generation time.
 *
 * String enums (NS_TYPED_EXTENSIBLE_ENUM) declare their values as extern
 * NSString * constants in the framework binary. Since objc-js doesn't expose
 * dlsym, we can't read these at runtime — but we CAN read them during
 * generation using Bun's FFI to call dlopen/dlsym/objc_msgSend directly.
 *
 * This avoids compiling a helper binary (which fails on macOS Sequoia due to
 * Gatekeeper blocking unsigned locally-compiled executables).
 */

import { dlopen as bunDlopen, FFIType, read, CString } from "bun:ffi";
import type { Pointer } from "bun:ffi";

/** Lazily initialized FFI bindings for dlopen/dlsym and ObjC runtime. */
let ffi: {
  dlopen: (path: Buffer, flags: number) => Pointer;
  dlsym: (handle: Pointer, name: Buffer) => Pointer;
  dlclose: (handle: Pointer) => number;
  objc_msgSend: (obj: Pointer, sel: Pointer) => Pointer;
  utf8Sel: Pointer;
} | null = null;

/** Convert a JS string to a null-terminated C string buffer. */
function cstr(s: string): Buffer {
  const buf = Buffer.alloc(s.length + 1);
  buf.write(s, "utf-8");
  return buf;
}

/** Initialize the FFI bindings once. */
function ensureFFI() {
  if (ffi) return ffi;

  const libdl = bunDlopen("/usr/lib/libdl.dylib", {
    dlopen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
    dlsym: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    dlclose: { args: [FFIType.ptr], returns: FFIType.i32 }
  });

  const libobjc = bunDlopen("/usr/lib/libobjc.A.dylib", {
    sel_registerName: { args: [FFIType.ptr], returns: FFIType.ptr },
    objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr }
  });

  const utf8Sel = libobjc.symbols.sel_registerName(cstr("UTF8String")) as Pointer;

  ffi = {
    dlopen: (path, flags) => libdl.symbols.dlopen(path, flags) as Pointer,
    dlsym: (handle, name) => libdl.symbols.dlsym(handle, name) as Pointer,
    dlclose: (handle) => libdl.symbols.dlclose(handle) as number,
    objc_msgSend: (obj, sel) => libobjc.symbols.objc_msgSend(obj, sel) as Pointer,
    utf8Sel
  };

  return ffi;
}

/**
 * Resolve extern NSString * constant values from a framework binary.
 *
 * Uses Bun's FFI to call dlopen/dlsym directly within the Bun process,
 * avoiding the need to compile and execute a separate helper binary.
 *
 * @param frameworkBinaryPath - Path to the framework binary
 *   (e.g., "/System/Library/Frameworks/Foundation.framework/Foundation")
 * @param symbolNames - Array of extern symbol names to resolve
 * @returns Map from symbol name to its string value
 */
export async function resolveStringConstants(
  frameworkBinaryPath: string,
  symbolNames: string[]
): Promise<Map<string, string>> {
  if (symbolNames.length === 0) {
    return new Map();
  }

  const f = ensureFFI();

  // Open the framework binary via dlopen (RTLD_LAZY = 1)
  const handle = f.dlopen(cstr(frameworkBinaryPath), 1);
  if (Number(handle) === 0) {
    return new Map();
  }

  const result = new Map<string, string>();

  try {
    for (const symbolName of symbolNames) {
      // dlsym returns the address of the global variable (NSString **)
      const symAddr = f.dlsym(handle, cstr(symbolName));
      if (Number(symAddr) === 0) continue;

      // Dereference: read the NSString * pointer from the global variable
      // read.ptr returns number; cast to Pointer for objc_msgSend
      const nsStringPtr = read.ptr(symAddr, 0) as unknown as Pointer;
      if (Number(nsStringPtr) === 0) continue;

      // Call [nsString UTF8String] via objc_msgSend -> returns const char *
      const utf8Ptr = f.objc_msgSend(nsStringPtr, f.utf8Sel);
      if (Number(utf8Ptr) === 0) continue;

      // Read the C string value
      const value = new CString(utf8Ptr).toString();
      result.set(symbolName, value);
    }
  } finally {
    f.dlclose(handle);
  }

  return result;
}

/**
 * Clean up resources. No-op in the FFI implementation since we don't
 * compile a helper binary, but kept for API compatibility.
 */
export async function cleanupResolver(): Promise<void> {
  // No temp files to clean up in the FFI implementation
}
