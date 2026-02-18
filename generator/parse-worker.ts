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

      // Fallback: retry without -fmodules using pre-includes if any expected
      // target type has missing results. Some headers contain both classes and
      // enums, where the class parses fine with -fmodules but the enum does not.
      // The old all-or-nothing check would skip the fallback if any target type
      // succeeded, causing enums (or other types) to be silently dropped.
      const missingClasses = classTargetSet.size > 0 && classes.size < classTargetSet.size;
      const missingProtocols = protocolTargetSet.size > 0 && protocols.size < protocolTargetSet.size;
      const missingIntEnums = integerTargetSet.size > 0 && integerEnums.size < integerTargetSet.size;
      const missingStrEnums = stringTargetSet.size > 0 && stringEnums.size < stringTargetSet.size;
      const hasMissing = missingClasses || missingProtocols || missingIntEnums || missingStrEnums;

      if (hasMissing && msg.fallbackPreIncludes) {
        const fallbackAst = await clangASTDumpWithPreIncludes(msg.headerPath, msg.fallbackPreIncludes);

        // Merge fallback results: only fill in targets that were missing from the
        // primary parse. Keep primary results where they succeeded to avoid
        // losing data that only -fmodules can provide.
        if (missingClasses) {
          const fallbackClasses = parseAST(fallbackAst, classTargetSet, headerLines);
          for (const [name, cls] of fallbackClasses) {
            if (!classes.has(name)) classes.set(name, cls);
          }
        }
        if (missingProtocols) {
          const fallbackProtocols = parseProtocols(fallbackAst, protocolTargetSet, headerLines);
          for (const [name, proto] of fallbackProtocols) {
            if (!protocols.has(name)) protocols.set(name, proto);
          }
        }
        if (missingIntEnums) {
          const fallbackIntEnums = parseIntegerEnums(fallbackAst, integerTargetSet);
          for (const [name, enumDef] of fallbackIntEnums) {
            if (!integerEnums.has(name)) integerEnums.set(name, enumDef);
          }
        }
        if (missingStrEnums) {
          const fallbackStrEnums = parseStringEnums(fallbackAst, stringTargetSet);
          for (const [name, enumDef] of fallbackStrEnums) {
            if (!stringEnums.has(name)) stringEnums.set(name, enumDef);
          }
        }
        // Re-parse structs from fallback AST and merge
        const fallbackStructResult = parseStructs(fallbackAst);
        for (const [name, structDef] of fallbackStructResult.structs) {
          if (!structResult.structs.has(name)) structResult.structs.set(name, structDef);
        }
        for (const alias of fallbackStructResult.aliases) {
          if (!structResult.aliases.some((a) => a.name === alias.name)) {
            structResult.aliases.push(alias);
          }
        }
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
