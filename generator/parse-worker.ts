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
import { parseAST, parseProtocols, parseIntegerEnums, parseStringEnums, parseStructs } from "./ast-parser.ts";

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
    if (msg.type === "parse-all") {
      // Unified task: parse classes, protocols, and enums from a single clang AST.
      // This avoids running clang multiple times on the same header file.
      const classTargetSet = new Set<string>(msg.classTargets ?? []);
      const protocolTargetSet = new Set<string>(msg.protocolTargets ?? []);
      const integerTargetSet = new Set<string>(msg.integerEnumTargets ?? []);
      const stringTargetSet = new Set<string>(msg.stringEnumTargets ?? []);

      const headerLines = await readHeaderLines(msg.headerPath);
      let ast = await clangASTDump(msg.headerPath);

      let classes = classTargetSet.size > 0 ? parseAST(ast, classTargetSet, headerLines) : new Map();
      let protocols = protocolTargetSet.size > 0 ? parseProtocols(ast, protocolTargetSet, headerLines) : new Map();
      let integerEnums = integerTargetSet.size > 0 ? parseIntegerEnums(ast, integerTargetSet) : new Map();
      let stringEnums = stringTargetSet.size > 0 ? parseStringEnums(ast, stringTargetSet) : new Map();
      let structResult = parseStructs(ast);

      // Fallback: retry without -fmodules using pre-includes if nothing was found.
      const foundNothing = classes.size === 0 && protocols.size === 0 &&
        integerEnums.size === 0 && stringEnums.size === 0;
      if (foundNothing && msg.fallbackPreIncludes) {
        ast = await clangASTDumpWithPreIncludes(msg.headerPath, msg.fallbackPreIncludes);
        classes = classTargetSet.size > 0 ? parseAST(ast, classTargetSet, headerLines) : new Map();
        protocols = protocolTargetSet.size > 0 ? parseProtocols(ast, protocolTargetSet, headerLines) : new Map();
        integerEnums = integerTargetSet.size > 0 ? parseIntegerEnums(ast, integerTargetSet) : new Map();
        stringEnums = stringTargetSet.size > 0 ? parseStringEnums(ast, stringTargetSet) : new Map();
        structResult = parseStructs(ast);
      }

      postMessage({
        id: msg.id,
        type: "all-result",
        classes: [...classes.entries()],
        protocols: [...protocols.entries()],
        integerEnums: [...integerEnums.entries()],
        stringEnums: [...stringEnums.entries()],
        structs: [...structResult.structs.entries()],
        structAliases: structResult.aliases,
      });
    } else if (msg.type === "parse-classes") {
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
    } else if (msg.type === "parse-enums") {
      const integerTargetSet = new Set<string>(msg.integerTargets ?? []);
      const stringTargetSet = new Set<string>(msg.stringTargets ?? []);
      let ast = await clangASTDump(msg.headerPath);
      let integerEnums = parseIntegerEnums(ast, integerTargetSet);
      let stringEnums = parseStringEnums(ast, stringTargetSet);

      // Fallback: retry without -fmodules using pre-includes
      if (integerEnums.size === 0 && stringEnums.size === 0 && msg.fallbackPreIncludes) {
        ast = await clangASTDumpWithPreIncludes(msg.headerPath, msg.fallbackPreIncludes);
        integerEnums = parseIntegerEnums(ast, integerTargetSet);
        stringEnums = parseStringEnums(ast, stringTargetSet);
      }

      postMessage({
        id: msg.id,
        type: "enums-result",
        integerEnums: [...integerEnums.entries()],
        stringEnums: [...stringEnums.entries()],
        integerTargets: msg.integerTargets ?? [],
        stringTargets: msg.stringTargets ?? [],
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
