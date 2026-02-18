/**
 * Worker thread for parallel header parsing.
 * Receives parse tasks via postMessage, runs clang AST dump + parsing,
 * and returns parsed results to the main thread.
 *
 * Each worker handles one task at a time. The WorkerPool dispatches
 * tasks to idle workers for automatic load balancing.
 */

declare var self: Worker;

import { clangASTDump, clangASTDumpWithPreIncludes } from "./clang.ts";
import { parseAST, parseProtocols } from "./ast-parser.ts";

/**
 * Read a header file and split it into lines for deprecation scanning.
 */
async function readHeaderLines(headerPath: string): Promise<string[] | undefined> {
  try {
    const content = await Bun.file(headerPath).text();
    return content.split("\n");
  } catch {
    return undefined;
  }
}

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;

  try {
    if (msg.type === "parse-classes") {
      const targetSet = new Set<string>(msg.targets);
      const headerLines = await readHeaderLines(msg.headerPath);
      let ast = await clangASTDump(msg.headerPath);
      let parsed = parseAST(ast, targetSet, headerLines);

      // Fallback: retry without -fmodules using pre-includes.
      // Some headers (e.g., WebKit) need Foundation macros pre-loaded.
      if (parsed.size === 0 && msg.fallbackPreIncludes) {
        ast = await clangASTDumpWithPreIncludes(msg.headerPath, msg.fallbackPreIncludes);
        parsed = parseAST(ast, targetSet, headerLines);
      }

      postMessage({
        id: msg.id,
        type: "classes-result",
        // Convert Map to entries array for structured clone fast path
        classes: [...parsed.entries()],
        targets: msg.targets,
      });
    } else if (msg.type === "parse-protocols") {
      const targetSet = new Set<string>(msg.targets);
      const headerLines = await readHeaderLines(msg.headerPath);
      let ast = await clangASTDump(msg.headerPath);
      let parsed = parseProtocols(ast, targetSet, headerLines);

      // Fallback
      if (parsed.size === 0 && msg.fallbackPreIncludes) {
        ast = await clangASTDumpWithPreIncludes(msg.headerPath, msg.fallbackPreIncludes);
        parsed = parseProtocols(ast, targetSet, headerLines);
      }

      postMessage({
        id: msg.id,
        type: "protocols-result",
        protocols: [...parsed.entries()],
        targets: msg.targets,
      });
    }
  } catch (error) {
    postMessage({
      id: msg.id,
      type: "error",
      error: String(error),
    });
  }
};
