/**
 * Resolves extern NSString * constant values at generation time.
 *
 * String enums (NS_TYPED_EXTENSIBLE_ENUM) declare their values as extern
 * NSString * constants in the framework binary. Since objc-js doesn't expose
 * dlsym, we can't read these at runtime — but we CAN read them during
 * generation by compiling a small ObjC helper that uses dlopen/dlsym.
 *
 * The helper is compiled once and invoked per-framework with all symbol names.
 * It prints `SYMBOL=value` lines to stdout, which we parse into a Map.
 */

import { join } from "path";
import { existsSync } from "fs";
import { mkdir, unlink, rmdir } from "fs/promises";

const HELPER_SOURCE = `
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <stdio.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 3) {
      fprintf(stderr, "Usage: %s <framework_path> <symbol1> [symbol2 ...]\\n", argv[0]);
      return 1;
    }

    const char *frameworkPath = argv[1];
    void *handle = dlopen(frameworkPath, RTLD_LAZY);
    if (!handle) {
      fprintf(stderr, "dlopen failed: %s\\n", dlerror());
      return 1;
    }

    for (int i = 2; i < argc; i++) {
      const char *symbolName = argv[i];
      NSString **symPtr = (NSString **)dlsym(handle, symbolName);
      if (symPtr && *symPtr) {
        printf("%s=%s\\n", symbolName, [*symPtr UTF8String]);
      } else {
        fprintf(stderr, "dlsym failed for %s: %s\\n", symbolName, dlerror() ?: "null pointer");
      }
    }

    dlclose(handle);
  }
  return 0;
}
`;

let compiledBinaryPath: string | null = null;

/**
 * Compile the ObjC helper binary once. Returns the path to the compiled binary.
 * Subsequent calls return the cached path.
 */
async function ensureCompiled(): Promise<string> {
  if (compiledBinaryPath && existsSync(compiledBinaryPath)) {
    return compiledBinaryPath;
  }

  const tmpDir = join(import.meta.dir, "..", ".gen-tmp");
  await mkdir(tmpDir, { recursive: true });
  await Bun.write(join(tmpDir, "resolve_strings.m"), HELPER_SOURCE);

  const outputPath = join(tmpDir, "resolve_strings");

  const proc = Bun.spawn(["clang", "-framework", "Foundation", "-o", outputPath, join(tmpDir, "resolve_strings.m")], {
    stdout: "pipe",
    stderr: "pipe"
  });

  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`Failed to compile string resolver helper:\n${stderr}`);
  }

  compiledBinaryPath = outputPath;
  return outputPath;
}

/**
 * Resolve extern NSString * constant values from a framework binary.
 *
 * @param frameworkBinaryPath - Path to the framework binary
 *   (e.g., "/System/Library/Frameworks/AuthenticationServices.framework/AuthenticationServices")
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

  const binaryPath = await ensureCompiled();

  // Batch all symbols into a single invocation for efficiency.
  // macOS has a ~256KB arg limit, which supports thousands of symbol names.
  const proc = Bun.spawn([binaryPath, frameworkBinaryPath, ...symbolNames], { stdout: "pipe", stderr: "pipe" });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  // Log any dlsym failures (non-fatal — some symbols may not be in the binary)
  if (stderr.trim()) {
    for (const line of stderr.trim().split("\n")) {
      if (line.includes("dlsym failed")) {
        // Silently skip — these are expected for symbols not in this framework
      } else {
        console.log(`  [resolve-strings] ${line}`);
      }
    }
  }

  // Parse "SYMBOL=value" lines
  const result = new Map<string, string>();
  for (const line of stdout.trim().split("\n")) {
    if (!line) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) continue;
    const symbol = line.slice(0, eqIdx);
    const value = line.slice(eqIdx + 1);
    result.set(symbol, value);
  }

  return result;
}

/**
 * Clean up the compiled helper binary and temp directory.
 * Call this at the end of generation.
 */
export async function cleanupResolver(): Promise<void> {
  const tmpDir = join(import.meta.dir, "..", ".gen-tmp");
  try {
    await unlink(join(tmpDir, "resolve_strings.m"));
    await unlink(join(tmpDir, "resolve_strings"));
    await rmdir(tmpDir);
  } catch {
    // Ignore cleanup errors
  }
  compiledBinaryPath = null;
}
