/**
 * Main generator CLI — orchestrates the full pipeline:
 * 1. Discover frameworks and scan headers for class/protocol names
 * 2. Parse headers in parallel via worker threads (clang AST dump + parsing)
 * 3. Collect results and build shared type-mapping state
 * 4. Emit .ts declaration files
 */

import { mkdir, writeFile, readdir, copyFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import {
  discoverAllFrameworks,
  getHeaderPath,
  getProtocolHeaderPath,
  getEnumHeaderPath,
  type FrameworkConfig
} from "./frameworks.ts";
import { discoverFramework } from "./discover.ts";
import type {
  ObjCClass,
  ObjCProtocol,
  ObjCIntegerEnum,
  ObjCStringEnum,
  ObjCStruct,
  ObjCStructAlias
} from "./ast-parser.ts";
import {
  setKnownClasses,
  setKnownProtocols,
  setProtocolConformers,
  setKnownIntegerEnums,
  setKnownStringEnums,
  setKnownStructs,
  setKnownTypedefs,
  mapReturnType,
  mapParamType,
  STRUCT_TS_TYPES
} from "./type-mapper.ts";
import { resolveStringConstants, cleanupResolver } from "./resolve-strings.ts";
import {
  emitClassFile,
  emitMergedClassFile,
  emitProtocolFile,
  emitFrameworkIndex,
  emitTopLevelIndex,
  emitDelegatesFile,
  emitStructFile,
  emitStructIndex,
  emitIntegerEnumFile,
  emitStringEnumFile,
  groupCaseCollisions
} from "./emitter.ts";
import type { StructDef, StructFieldDef } from "./emitter.ts";
import { parseKnownStructFields } from "./struct-fields.ts";
import { WorkerPool } from "./worker-pool.ts";
import type { UnifiedParseResult } from "./worker-pool.ts";

const SRC_DIR = join(import.meta.dir, "..", "src");

async function main(): Promise<void> {
  console.log("=== objcjs-types generator ===\n");
  const globalStart = performance.now();

  // --- Parse CLI args: optional framework name filter ---
  // Usage: bun run generate [Framework1 Framework2 ...]
  // If no names given, all frameworks are regenerated.
  const filterNames = process.argv
    .slice(2)
    .map((s) => s.trim())
    .filter(Boolean);
  const isFiltered = filterNames.length > 0;
  if (isFiltered) {
    console.log(`Regenerating frameworks: ${filterNames.join(", ")}\n`);
  }

  // ========================================
  // Phase 1: Discovery
  // ========================================

  // --- Framework discovery: find all ObjC frameworks in the SDK ---
  console.log("Discovering frameworks from SDK...");
  const allBases = await discoverAllFrameworks();
  console.log(`  Found ${allBases.length} frameworks with headers\n`);

  // --- Class/protocol discovery: scan headers for each framework ---
  console.log("Discovering classes and protocols from headers...");
  const frameworks: FrameworkConfig[] = [];

  // Discover all frameworks in parallel for faster scanning
  const discoveryResults = await Promise.all(
    allBases.map(async (base) => {
      const discovery = await discoverFramework(base.headersPath);
      return { base, discovery };
    })
  );

  for (const { base, discovery } of discoveryResults) {
    // Filter out protocols whose names clash with class names (e.g., NSObject)
    // to avoid generating both a class type and protocol interface with the same _Name.
    for (const protoName of discovery.protocols.keys()) {
      if (discovery.classes.has(protoName)) {
        discovery.protocols.delete(protoName);
      }
    }

    // Add extraHeaders classes to the discovered set. Some classes (e.g., NSObject)
    // are declared in runtime headers outside the framework's Headers/ directory,
    // so header scanning won't find them. They still need to be in the class list
    // for emission and for allKnownClasses (used by the emitter to resolve superclasses).
    if (base.extraHeaders) {
      for (const className of Object.keys(base.extraHeaders)) {
        if (!discovery.classes.has(className)) {
          discovery.classes.set(className, className);
        }
      }
    }

    // Skip frameworks with no ObjC classes, protocols, or enums
    if (
      discovery.classes.size === 0 &&
      discovery.protocols.size === 0 &&
      discovery.integerEnums.size === 0 &&
      discovery.stringEnums.size === 0
    )
      continue;

    const fw: FrameworkConfig = {
      ...base,
      classes: [...discovery.classes.keys()].sort(),
      protocols: [...discovery.protocols.keys()].sort(),
      integerEnums: [...discovery.integerEnums.keys()].sort(),
      stringEnums: [...discovery.stringEnums.keys()].sort(),
      classHeaders: discovery.classes,
      protocolHeaders: discovery.protocols,
      integerEnumHeaders: discovery.integerEnums,
      stringEnumHeaders: discovery.stringEnums
    };
    frameworks.push(fw);

    const enumCount = fw.integerEnums.length + fw.stringEnums.length;
    console.log(`  ${fw.name}: ${fw.classes.length} classes, ${fw.protocols.length} protocols, ${enumCount} enums`);
  }
  const discoveryTime = ((performance.now() - globalStart) / 1000).toFixed(1);
  console.log(`  Discovery completed in ${discoveryTime}s\n`);

  // Collect all known classes across all frameworks
  const allKnownClasses = new Set<string>();
  for (const fw of frameworks) {
    for (const cls of fw.classes) {
      allKnownClasses.add(cls);
    }
  }
  setKnownClasses(allKnownClasses);

  // Collect all known protocol names across all frameworks
  const allKnownProtocols = new Set<string>();
  for (const fw of frameworks) {
    for (const proto of fw.protocols) {
      allKnownProtocols.add(proto);
    }
  }
  setKnownProtocols(allKnownProtocols);

  // Collect all known enum names across all frameworks
  const allKnownIntegerEnums = new Set<string>();
  const allKnownStringEnums = new Set<string>();
  for (const fw of frameworks) {
    for (const name of fw.integerEnums) {
      allKnownIntegerEnums.add(name);
    }
    for (const name of fw.stringEnums) {
      allKnownStringEnums.add(name);
    }
  }
  setKnownIntegerEnums(allKnownIntegerEnums);
  setKnownStringEnums(allKnownStringEnums);

  // Validate filter names against discovered frameworks
  if (isFiltered) {
    const allNames = new Set(frameworks.map((fw) => fw.name));
    const invalid = filterNames.filter((n) => !allNames.has(n));
    if (invalid.length > 0) {
      console.error(`Unknown framework(s): ${invalid.join(", ")}`);
      console.error(`Available: ${[...allNames].sort().join(", ")}`);
      process.exit(1);
    }
  }

  // Determine which frameworks to process (parse + emit)
  const filterSet = new Set(filterNames);
  const frameworksToProcess = isFiltered ? frameworks.filter((fw) => filterSet.has(fw.name)) : frameworks;

  // ========================================
  // Phase 2: Build batched parse tasks (one per framework)
  // ========================================
  // Instead of spawning a separate clang process per header file, we batch
  // ALL headers within each framework into a single clang invocation. This
  // reduces ~3400 clang processes to ~100 (one per framework), dramatically
  // cutting startup overhead and parse time.

  /** Batched task: all parse targets for an entire framework */
  interface BatchTask {
    frameworkName: string;
    headerPaths: string[];
    classTargets: string[];
    protocolTargets: string[];
    integerEnumTargets: string[];
    stringEnumTargets: string[];
    preIncludes: string[];
  }

  /** Extra header tasks are still per-header (they're outside the framework) */
  interface ExtraHeaderTask {
    frameworkName: string;
    headerPath: string;
    classTargets: string[];
  }

  const batchTasks: BatchTask[] = [];
  const extraTasks: ExtraHeaderTask[] = [];

  for (const fw of frameworksToProcess) {
    const preIncludes = ["Foundation/Foundation.h", ...(fw.preIncludes ?? [])];

    // Include ALL .h files from the framework's Headers/ directory.
    // This is critical because ObjC categories extending a class (e.g., NSObject)
    // can be declared in headers that don't contain any class/protocol/enum
    // declarations themselves (e.g., NSKeyValueCoding.h). With -fmodules, clang
    // automatically pulls in all transitive module content, but without modules
    // we must explicitly include every header.
    const allFrameworkHeaders = (await readdir(fw.headersPath))
      .filter((f) => f.endsWith(".h"))
      .map((f) => join(fw.headersPath, f));

    const classTargets: string[] = [];
    const protocolTargets: string[] = [];
    const integerEnumTargets: string[] = [];
    const stringEnumTargets: string[] = [];

    // --- Class targets ---
    for (const className of fw.classes) {
      const headerPath = getHeaderPath(fw, className);
      if (!existsSync(headerPath)) {
        // Extra-header-only classes (e.g., NSObject from /usr/include/objc/NSObject.h)
        // may not have a framework header — that's fine, they'll be parsed from extraHeaders
        if (!(fw.extraHeaders && className in fw.extraHeaders)) {
          console.log(`  [SKIP] Header not found: ${headerPath}`);
        }
        continue;
      }
      classTargets.push(className);
    }

    // --- Protocol targets ---
    for (const protoName of fw.protocols) {
      const headerPath = getProtocolHeaderPath(fw, protoName);
      if (!existsSync(headerPath)) {
        console.log(`  [SKIP] Protocol header not found: ${headerPath}`);
        continue;
      }
      protocolTargets.push(protoName);
    }

    // --- Integer enum targets ---
    for (const enumName of fw.integerEnums) {
      const headerPath = getEnumHeaderPath(fw, enumName, "integer");
      if (!existsSync(headerPath)) {
        console.log(`  [SKIP] Enum header not found: ${headerPath}`);
        continue;
      }
      integerEnumTargets.push(enumName);
    }

    // --- String enum targets ---
    for (const enumName of fw.stringEnums) {
      const headerPath = getEnumHeaderPath(fw, enumName, "string");
      if (!existsSync(headerPath)) {
        console.log(`  [SKIP] Enum header not found: ${headerPath}`);
        continue;
      }
      stringEnumTargets.push(enumName);
    }

    // Only create a batch task if there are targets to parse
    if (
      allFrameworkHeaders.length > 0 &&
      (classTargets.length > 0 ||
        protocolTargets.length > 0 ||
        integerEnumTargets.length > 0 ||
        stringEnumTargets.length > 0)
    ) {
      batchTasks.push({
        frameworkName: fw.name,
        headerPaths: allFrameworkHeaders,
        classTargets,
        protocolTargets,
        integerEnumTargets,
        stringEnumTargets,
        preIncludes
      });
    }

    // --- Extra header tasks (e.g., runtime NSObject.h for alloc/init) ---
    if (fw.extraHeaders) {
      for (const [className, headerPath] of Object.entries(fw.extraHeaders)) {
        if (!existsSync(headerPath)) {
          console.log(`  [SKIP] Extra header not found: ${headerPath}`);
          continue;
        }
        extraTasks.push({
          frameworkName: fw.name,
          headerPath,
          classTargets: [className]
        });
      }
    }
  }

  // ========================================
  // Phase 3: Parallel parsing via worker pool
  // ========================================

  // Native JSON.parse is ~3x faster than any JS-based streaming parser, but
  // each clang batch materializes ~1-2GB of JS objects. With 8 workers the
  // peak memory is higher but parse time drops to ~30s (from ~55s with 4).
  // The actual per-task bottleneck is clang execution + JSON.parse (~95% of
  // task time), not the AST walk passes (~5%). Any Xcode-capable Mac with
  // 32+GB RAM handles 8 workers comfortably.
  const cpuCount = navigator.hardwareConcurrency ?? 4;
  const poolSize = Math.min(cpuCount, 8);
  const pool = new WorkerPool(poolSize);
  const totalBatchTasks = batchTasks.length;
  const totalExtraTasks = extraTasks.length;
  const totalTasks = totalBatchTasks + totalExtraTasks;
  let completedTasks = 0;

  const totalHeaders = batchTasks.reduce((sum, t) => sum + t.headerPaths.length, 0) + totalExtraTasks;

  // Sort batch tasks largest-first so expensive frameworks (AppKit, Foundation)
  // start immediately and don't create tail latency at the end.
  batchTasks.sort((a, b) => b.headerPaths.length - a.headerPaths.length);

  console.log(
    `Parsing ${totalHeaders} headers via ${totalBatchTasks} batched framework tasks + ${totalExtraTasks} extra tasks using ${pool.size} worker threads...`
  );

  const startTime = performance.now();

  /** Update the progress counter on the current console line. */
  const trackProgress = (label: string) => {
    completedTasks++;
    process.stdout.write(`\r  Progress: ${completedTasks}/${totalTasks} tasks (${label})`);
  };

  // Dispatch batched framework tasks
  const batchPromises = batchTasks.map((task) =>
    pool
      .parseBatch(
        task.headerPaths,
        task.classTargets,
        task.protocolTargets,
        task.integerEnumTargets,
        task.stringEnumTargets,
        task.preIncludes
      )
      .then((result) => {
        trackProgress(task.frameworkName);
        return { task, result, error: null as string | null, isExtra: false as const };
      })
      .catch((err) => {
        trackProgress(task.frameworkName);
        return { task, result: null as UnifiedParseResult | null, error: String(err), isExtra: false as const };
      })
  );

  // Dispatch extra header tasks (still per-header, using parseAll)
  const extraPromises = extraTasks.map((task) =>
    pool
      .parseAll(
        task.headerPath,
        task.classTargets,
        [], // no protocols
        [], // no integer enums
        [], // no string enums
        undefined // no fallback pre-includes for extra headers
      )
      .then((result) => {
        trackProgress(`extra:${task.classTargets[0]}`);
        return { task, result, error: null as string | null, isExtra: true as const };
      })
      .catch((err) => {
        trackProgress(`extra:${task.classTargets[0]}`);
        return { task, result: null as UnifiedParseResult | null, error: String(err), isExtra: true as const };
      })
  );

  // Wait for all parse tasks to complete
  const allResults = await Promise.all([...batchPromises, ...extraPromises]);

  pool.destroy();

  const parseTime = ((performance.now() - startTime) / 1000).toFixed(1);
  process.stdout.write(`\r  Parsed ${totalHeaders} headers in ${parseTime}s          \n\n`);

  // ========================================
  // Phase 4: Collect results and build shared state
  // ========================================

  // Organize parsed classes by framework
  const frameworkClasses = new Map<string, Map<string, ObjCClass>>();
  const allParsedClasses = new Map<string, ObjCClass>();

  // First pass: regular (non-extra) results
  for (const entry of allResults) {
    if (entry.isExtra) continue; // Handle in second pass
    if (entry.error) {
      console.log(`  [ERROR] ${entry.task.frameworkName}: ${entry.error}`);
      continue;
    }
    if (!entry.result) continue;

    // --- Classes ---
    if (entry.result.classes.size > 0) {
      if (!frameworkClasses.has(entry.task.frameworkName)) {
        frameworkClasses.set(entry.task.frameworkName, new Map());
      }
      const fwClasses = frameworkClasses.get(entry.task.frameworkName)!;
      for (const [name, cls] of entry.result.classes) {
        fwClasses.set(name, cls);
        allParsedClasses.set(name, cls);
      }
    }
  }

  // Second pass: extra header results (merge into existing classes)
  for (const entry of allResults) {
    if (!entry.isExtra) continue;
    if (entry.error) {
      console.log(`  [ERROR] Extra header ${entry.task.headerPath}: ${entry.error}`);
      continue;
    }
    if (!entry.result) continue;

    if (!frameworkClasses.has(entry.task.frameworkName)) {
      frameworkClasses.set(entry.task.frameworkName, new Map());
    }
    const fwClasses = frameworkClasses.get(entry.task.frameworkName)!;

    for (const [className, extraCls] of entry.result.classes) {
      const existing = fwClasses.get(className);
      if (existing) {
        // Merge: add methods/properties from extra header that don't already exist
        const existingInstanceSelectors = new Set(existing.instanceMethods.map((m) => m.selector));
        const existingClassSelectors = new Set(existing.classMethods.map((m) => m.selector));
        const existingPropertyNames = new Set(existing.properties.map((p) => p.name));

        for (const m of extraCls.instanceMethods) {
          if (!existingInstanceSelectors.has(m.selector)) {
            existing.instanceMethods.push(m);
          }
        }
        for (const m of extraCls.classMethods) {
          if (!existingClassSelectors.has(m.selector)) {
            existing.classMethods.push(m);
          }
        }
        for (const p of extraCls.properties) {
          if (!existingPropertyNames.has(p.name)) {
            existing.properties.push(p);
          }
        }

        console.log(
          `  [extra] Merged ${className}: +${extraCls.instanceMethods.length} instance, ` +
            `+${extraCls.classMethods.length} class methods, +${extraCls.properties.length} props`
        );
      } else {
        fwClasses.set(className, extraCls);
        allParsedClasses.set(className, extraCls);
        console.log(`  [extra] Added ${className}`);
      }
    }
  }

  // Organize parsed protocols by framework
  const frameworkProtocolsParsed = new Map<string, Map<string, ObjCProtocol>>();
  for (const entry of allResults) {
    if (entry.isExtra) continue;
    if (entry.error || !entry.result) continue;
    if (entry.result.protocols.size === 0) continue;

    if (!frameworkProtocolsParsed.has(entry.task.frameworkName)) {
      frameworkProtocolsParsed.set(entry.task.frameworkName, new Map());
    }
    const fwProtos = frameworkProtocolsParsed.get(entry.task.frameworkName)!;
    for (const [name, proto] of entry.result.protocols) {
      fwProtos.set(name, proto);
    }
  }

  // Organize parsed enums by framework
  const frameworkIntegerEnums = new Map<string, Map<string, ObjCIntegerEnum>>();
  const frameworkStringEnums = new Map<string, Map<string, ObjCStringEnum>>();
  for (const entry of allResults) {
    if (entry.isExtra) continue;
    if (entry.error || !entry.result) continue;
    if (entry.result.integerEnums.size === 0 && entry.result.stringEnums.size === 0) continue;

    if (!frameworkIntegerEnums.has(entry.task.frameworkName)) {
      frameworkIntegerEnums.set(entry.task.frameworkName, new Map());
    }
    if (!frameworkStringEnums.has(entry.task.frameworkName)) {
      frameworkStringEnums.set(entry.task.frameworkName, new Map());
    }

    const fwIntEnums = frameworkIntegerEnums.get(entry.task.frameworkName)!;
    const fwStrEnums = frameworkStringEnums.get(entry.task.frameworkName)!;

    for (const [name, enumDef] of entry.result.integerEnums) {
      fwIntEnums.set(name, enumDef);
    }
    for (const [name, enumDef] of entry.result.stringEnums) {
      fwStrEnums.set(name, enumDef);
    }
  }

  // Collect all parsed structs and struct aliases across all headers
  const allParsedStructs = new Map<string, ObjCStruct>();
  const allStructAliases: ObjCStructAlias[] = [];
  for (const entry of allResults) {
    if (entry.isExtra) continue;
    if (entry.error || !entry.result) continue;

    for (const [name, structDef] of entry.result.structs) {
      // Keep the first definition encountered (later duplicates are typically
      // forward declarations or re-declarations of the same struct)
      if (!allParsedStructs.has(name)) {
        allParsedStructs.set(name, structDef);
      }
    }
    for (const alias of entry.result.structAliases) {
      // Deduplicate aliases (same alias may appear in multiple headers)
      if (!allStructAliases.some((a) => a.name === alias.name)) {
        allStructAliases.push(alias);
      }
    }
  }

  // Collect all typedefs across all headers for general typedef resolution
  const allTypedefs = new Map<string, string>();
  for (const entry of allResults) {
    if (entry.isExtra) continue;
    if (entry.error || !entry.result) continue;
    for (const [name, qualType] of entry.result.typedefs) {
      if (!allTypedefs.has(name)) {
        allTypedefs.set(name, qualType);
      }
    }
  }
  setKnownTypedefs(allTypedefs);

  // Resolve actual string values for extern NSString * constants.
  // This compiles a small ObjC helper once, then invokes it per-framework
  // with the symbol names discovered during parsing.
  console.log("Resolving string enum values from framework binaries...");
  let totalResolved = 0;
  let totalStringSymbols = 0;

  // Build resolution tasks
  interface ResolveTask {
    fwName: string;
    libraryPath: string;
    symbols: string[];
  }

  const resolveTasks: ResolveTask[] = [];

  for (const fw of frameworksToProcess) {
    const fwStrEnums = frameworkStringEnums.get(fw.name);
    if (!fwStrEnums || fwStrEnums.size === 0) continue;

    // Collect all symbol names for this framework
    const allSymbols: string[] = [];
    for (const enumDef of fwStrEnums.values()) {
      for (const v of enumDef.values) {
        allSymbols.push(v.symbolName);
      }
    }
    if (allSymbols.length === 0) continue;

    resolveTasks.push({ fwName: fw.name, libraryPath: fw.libraryPath, symbols: allSymbols });
    totalStringSymbols += allSymbols.length;
  }

  // Process resolution tasks sequentially to avoid spawning too many
  // concurrent child processes. Each task is fast (~100ms) since dlopen/dlsym
  // are lightweight. The timeout in resolveStringConstants guards against
  // frameworks whose dlopen hangs.
  for (const task of resolveTasks) {
    try {
      const resolved = await resolveStringConstants(task.libraryPath, task.symbols);
      const fwStrEnums = frameworkStringEnums.get(task.fwName);
      if (fwStrEnums) {
        for (const enumDef of fwStrEnums.values()) {
          for (const v of enumDef.values) {
            const value = resolved.get(v.symbolName);
            if (value !== undefined) {
              v.value = value;
              totalResolved++;
            }
          }
        }
      }
    } catch (err) {
      console.log(`  [WARN] Failed to resolve string values for ${task.fwName}: ${err}`);
    }
  }

  console.log(`  Resolved ${totalResolved}/${totalStringSymbols} string enum values\n`);

  // Protocol conformer map is built later, after allParsedProtocols is available,
  // so we can expand conformances transitively through the protocol hierarchy.

  // Print parse summary per framework
  for (const fw of frameworksToProcess) {
    const fwClasses = frameworkClasses.get(fw.name);
    const fwProtos = frameworkProtocolsParsed.get(fw.name);
    const fwIntEnums = frameworkIntegerEnums.get(fw.name);
    const fwStrEnums = frameworkStringEnums.get(fw.name);
    const classCount = fwClasses?.size ?? 0;
    const protoCount = fwProtos?.size ?? 0;
    const intEnumCount = fwIntEnums?.size ?? 0;
    const strEnumCount = fwStrEnums?.size ?? 0;
    const totalEnums = intEnumCount + strEnumCount;
    const expectedEnums = fw.integerEnums.length + fw.stringEnums.length;
    console.log(
      `  ${fw.name}: parsed ${classCount}/${fw.classes.length} classes, ` +
        `${protoCount}/${fw.protocols.length} protocols, ` +
        `${totalEnums}/${expectedEnums} enums`
    );
  }
  console.log("");

  // Update knownClasses/knownProtocols to reflect only actually-parsed entities.
  // Some classes are discovered in headers but fail to parse (e.g., classes hidden
  // behind NS_REFINED_FOR_SWIFT that clang omits from the AST). If we leave
  // discovered-but-unparsed classes in the known set, the type-mapper will generate
  // _ClassName references to types that have no corresponding .ts file, causing
  // broken imports. By narrowing to parsed classes only, those types fall back to
  // NobjcObject instead.
  //
  // For filtered runs (only regenerating some frameworks), we keep discovered classes
  // from non-processed frameworks since their .ts files already exist on disk from
  // a previous full run.
  const parsedClassNames = new Set(allParsedClasses.keys());
  const allParsedProtocolNames = new Set<string>();
  const allParsedProtocols = new Map<string, ObjCProtocol>();
  for (const fwProtos of frameworkProtocolsParsed.values()) {
    for (const [name, proto] of fwProtos) {
      allParsedProtocolNames.add(name);
      allParsedProtocols.set(name, proto);
    }
  }

  // Add discovered classes/protocols from frameworks we're NOT processing
  // (their .ts files exist from a previous run)
  const processedFrameworkNames = new Set(frameworksToProcess.map((fw) => fw.name));
  for (const fw of frameworks) {
    if (processedFrameworkNames.has(fw.name)) continue;
    for (const cls of fw.classes) {
      parsedClassNames.add(cls);
    }
    for (const proto of fw.protocols) {
      allParsedProtocolNames.add(proto);
    }
  }

  setKnownClasses(parsedClassNames);
  setKnownProtocols(allParsedProtocolNames);

  // Build protocol -> conforming classes map from all parsed classes.
  // This must happen after ALL parsing completes so every conformance is known.
  // We also expand conformances transitively through the protocol hierarchy:
  // if class X conforms to protocol A, and A extends B, then X also conforms to B.
  // This ensures that return type union expansion (e.g., credential() returning a
  // union of all ASAuthorizationCredential-conforming classes) includes classes that
  // conform indirectly through protocol inheritance chains.
  const protocolConformers = new Map<string, Set<string>>();
  for (const [className, cls] of allParsedClasses) {
    if (!parsedClassNames.has(className)) continue;
    for (const protoName of cls.protocols) {
      if (!protocolConformers.has(protoName)) {
        protocolConformers.set(protoName, new Set());
      }
      protocolConformers.get(protoName)!.add(className);
    }
  }

  // Expand conformances transitively: walk each protocol's extendedProtocols chain
  // and propagate all conforming classes upward.
  function getTransitiveParentProtocols(protoName: string, visited: Set<string>): string[] {
    if (visited.has(protoName)) return [];
    visited.add(protoName);
    const proto = allParsedProtocols.get(protoName);
    if (!proto) return [];
    const parents: string[] = [];
    for (const parent of proto.extendedProtocols) {
      parents.push(parent);
      parents.push(...getTransitiveParentProtocols(parent, visited));
    }
    return parents;
  }

  // For each protocol that has direct conformers, propagate those conformers
  // to all ancestor protocols in the hierarchy.
  for (const [protoName, conformers] of [...protocolConformers]) {
    const ancestors = getTransitiveParentProtocols(protoName, new Set());
    for (const ancestor of ancestors) {
      if (!protocolConformers.has(ancestor)) {
        protocolConformers.set(ancestor, new Set());
      }
      for (const cls of conformers) {
        protocolConformers.get(ancestor)!.add(cls);
      }
    }
  }

  setProtocolConformers(protocolConformers);

  // ========================================
  // Phase 4b: Build struct definitions from parsed AST + KNOWN_STRUCT_FIELDS
  // ========================================

  // Parse the runtime's known struct field table to determine which structs
  // get named fields vs positional (field0, field1, ...) names at JS level.
  const knownStructFields = await parseKnownStructFields();
  console.log(`  Parsed ${knownStructFields.size} struct field mappings from objc-js runtime`);
  console.log(`  Found ${allParsedStructs.size} struct definitions, ${allStructAliases.length} aliases from AST\n`);

  // Only emit structs that are referenced by class methods/properties.
  // This is determined by STRUCT_TYPE_MAP — we build it from discovered structs,
  // but only include structs that are actually used.

  // Build the struct name sets for setKnownStructs()
  const structNames = new Set(allParsedStructs.keys());
  const aliasMap = new Map(allStructAliases.map((a) => [a.name, a.target]));
  const internalNameMap = new Map<string, string>();
  for (const [name, structDef] of allParsedStructs) {
    if (structDef.internalName) {
      internalNameMap.set(name, structDef.internalName);
    }
  }
  setKnownStructs(structNames, aliasMap, internalNameMap);

  // --- Scan all parsed classes & protocols to find which structs are actually referenced ---
  // We temporarily registered ALL structs in STRUCT_TYPE_MAP above so that mapReturnType/
  // mapParamType can resolve struct qualType strings. Now we scan every method/property
  // signature to see which struct TS types actually appear, then filter down to only those.
  const referencedStructTSNames = new Set<string>();

  function extractStructRefs(typeStr: string): void {
    for (const structName of STRUCT_TS_TYPES) {
      if (typeStr === structName || typeStr.startsWith(structName + " ")) {
        referencedStructTSNames.add(structName);
      }
    }
  }

  // Scan all classes
  for (const cls of allParsedClasses.values()) {
    for (const method of [...cls.instanceMethods, ...cls.classMethods]) {
      extractStructRefs(mapReturnType(method.returnType, cls.name));
      for (const param of method.parameters) {
        extractStructRefs(mapParamType(param.type, cls.name));
      }
    }
    for (const prop of cls.properties) {
      extractStructRefs(mapReturnType(prop.type, cls.name));
      extractStructRefs(mapParamType(prop.type, cls.name));
    }
  }

  // Scan all protocols
  for (const fwProtos of frameworkProtocolsParsed.values()) {
    for (const proto of fwProtos.values()) {
      for (const method of [...proto.instanceMethods, ...proto.classMethods]) {
        extractStructRefs(mapReturnType(method.returnType, proto.name));
        for (const param of method.parameters) {
          extractStructRefs(mapParamType(param.type, proto.name));
        }
      }
      for (const prop of proto.properties) {
        extractStructRefs(mapReturnType(prop.type, proto.name));
        extractStructRefs(mapParamType(prop.type, proto.name));
      }
    }
  }

  // Also include transitive struct dependencies (e.g., CGRect references CGPoint, CGSize)
  function addStructDeps(name: string): void {
    const structDef = allParsedStructs.get(name);
    if (!structDef) return;

    const runtimeFields =
      knownStructFields.get(name) ??
      (structDef.internalName ? knownStructFields.get(structDef.internalName) : undefined);

    if (runtimeFields && runtimeFields.length === structDef.fields.length) {
      for (const field of structDef.fields) {
        const fieldTypeCleaned = field.type.replace(/^(const\s+)?struct\s+/, "").trim();
        if (structNames.has(fieldTypeCleaned) && !referencedStructTSNames.has(fieldTypeCleaned)) {
          referencedStructTSNames.add(fieldTypeCleaned);
          addStructDeps(fieldTypeCleaned);
        }
        const aliasTarget = aliasMap.get(fieldTypeCleaned);
        if (aliasTarget && !referencedStructTSNames.has(aliasTarget)) {
          referencedStructTSNames.add(aliasTarget);
          addStructDeps(aliasTarget);
        }
      }
    }
  }

  for (const name of [...referencedStructTSNames]) {
    addStructDeps(name);
  }

  // Filter: only keep parsed structs that are referenced
  const filteredStructs = new Map<string, ObjCStruct>();
  for (const [name, structDef] of allParsedStructs) {
    if (referencedStructTSNames.has(name)) {
      filteredStructs.set(name, structDef);
    }
  }

  // Filter aliases: only keep those whose target is referenced
  const filteredAliases = allStructAliases.filter((a) => referencedStructTSNames.has(a.target));

  // Re-register with only the filtered structs so STRUCT_TYPE_MAP doesn't
  // contain random C structs like siginfo_t
  const filteredStructNames = new Set(filteredStructs.keys());
  const filteredAliasMap = new Map(filteredAliases.map((a) => [a.name, a.target]));
  const filteredInternalNameMap = new Map<string, string>();
  for (const [name, structDef] of filteredStructs) {
    if (structDef.internalName) {
      filteredInternalNameMap.set(name, structDef.internalName);
    }
  }
  setKnownStructs(filteredStructNames, filteredAliasMap, filteredInternalNameMap);

  console.log(`  Filtered to ${filteredStructs.size} referenced structs + ${filteredAliases.length} aliases\n`);

  /**
   * Map an ObjC field type string to a TS type.
   * Struct fields that are other structs get the struct interface name;
   * everything else maps to "number" (CGFloat, int, NSInteger, etc.).
   */
  function mapStructFieldType(cType: string): string {
    // Clean up the C type: remove "struct " prefix, const, etc.
    const cleaned = cType.replace(/^(const\s+)?struct\s+/, "").trim();
    // Check if this field references another known struct
    if (filteredStructNames.has(cleaned)) return cleaned;
    // Check aliases
    const aliasTarget = filteredAliasMap.get(cleaned);
    if (aliasTarget) return aliasTarget;
    // Everything else is numeric
    return "number";
  }

  /**
   * Build the StructDef array from parsed AST data cross-referenced with
   * the runtime's KNOWN_STRUCT_FIELDS table.
   *
   * For structs in KNOWN_STRUCT_FIELDS: use named fields from that table.
   * For structs NOT in the table: use positional field0, field1, ... names.
   * For nested struct fields: auto-generate flattened factory params and body.
   */
  function buildStructDefs(): StructDef[] {
    const defs: StructDef[] = [];
    const emittedStructs = new Set<string>();

    /**
     * Ensure a struct's dependencies are emitted before itself.
     * Returns true if the struct was successfully processed.
     */
    function emitStruct(name: string): boolean {
      if (emittedStructs.has(name)) return true;

      const structDef = filteredStructs.get(name);
      if (!structDef) return false;

      // Check KNOWN_STRUCT_FIELDS for this struct.
      // For NSRange, the internal struct name is _NSRange, but the runtime table
      // may use either "NSRange" or "_NSRange" as the key.
      const runtimeFields =
        knownStructFields.get(name) ??
        (structDef.internalName ? knownStructFields.get(structDef.internalName) : undefined);

      const astFields = structDef.fields;

      // Determine the TS fields for this struct
      const tsFields: StructFieldDef[] = [];
      const hasRuntimeNames = runtimeFields !== undefined;

      if (hasRuntimeNames && runtimeFields.length === astFields.length) {
        // Use runtime field names with AST-derived types
        for (let i = 0; i < runtimeFields.length; i++) {
          const fieldName = runtimeFields[i]!;
          const fieldType = mapStructFieldType(astFields[i]!.type);
          tsFields.push({ name: fieldName, type: fieldType });

          // Ensure nested struct dependencies are emitted first
          if (fieldType !== "number") {
            emitStruct(fieldType);
          }
        }
      } else {
        // Positional field names (field0, field1, ...)
        for (let i = 0; i < astFields.length; i++) {
          tsFields.push({ name: `field${i}`, type: "number" });
        }
      }

      // Check if any fields reference other structs (nested structs)
      const hasNestedStructs = tsFields.some((f) => f.type !== "number");

      emittedStructs.add(name);

      if (hasNestedStructs) {
        // Generate flattened factory params for nested structs.
        // e.g., CGRect with fields { origin: CGPoint, size: CGSize }
        // gets factory params (x, y, width, height) instead of (origin, size).
        const factoryParams: { name: string; type: string }[] = [];
        const bodyParts: string[] = [];

        for (const field of tsFields) {
          if (field.type === "number") {
            factoryParams.push({ name: field.name, type: "number" });
            bodyParts.push(field.name);
          } else {
            // Look up the nested struct's fields to flatten them
            const nestedDef = defs.find((d) => !("aliasOf" in d) && d.tsName === field.type);
            if (nestedDef && !("aliasOf" in nestedDef)) {
              const nestedParamNames: string[] = [];
              for (const nestedField of nestedDef.fields) {
                factoryParams.push({ name: nestedField.name, type: nestedField.type });
                nestedParamNames.push(nestedField.name);
              }
              bodyParts.push(`{ ${nestedParamNames.join(", ")} }`);
            } else {
              // Fallback: use the field name as-is
              factoryParams.push({ name: field.name, type: field.type });
              bodyParts.push(field.name);
            }
          }
        }

        // Build the factory body expression
        const fieldAssignments = tsFields.map((f, i) => `${f.name}: ${bodyParts[i]}`);
        const factoryBody = `{ ${fieldAssignments.join(", ")} }`;

        defs.push({
          tsName: name,
          fields: tsFields,
          factoryParams,
          factoryBody
        });
      } else {
        defs.push({
          tsName: name,
          fields: tsFields
        });
      }

      return true;
    }

    // Emit only filtered (referenced) structs — dependencies handled recursively
    // Sort for deterministic output order
    const sortedNames = [...filteredStructs.keys()].sort();
    for (const name of sortedNames) {
      emitStruct(name);
    }

    // Emit aliases at the end
    const sortedAliases = [...filteredAliases].sort((a, b) => a.name.localeCompare(b.name));
    for (const alias of sortedAliases) {
      // Only emit if the target struct was emitted
      if (emittedStructs.has(alias.target)) {
        defs.push({ tsName: alias.name, aliasOf: alias.target });
      }
    }

    return defs;
  }

  const structDefs = buildStructDefs();
  console.log(`  Built ${structDefs.length} struct definitions for emission\n`);

  const emitStart = performance.now();
  const generatedProtocolsByFramework = new Map<string, string[]>();

  // Build a global classToFile map across ALL frameworks for cross-framework
  // import resolution on case-sensitive filesystems.
  const globalClassToFile = new Map<string, string>();
  const collisionsByFramework = new Map<string, Map<string, string[]>>();

  for (const framework of frameworksToProcess) {
    const collisions = groupCaseCollisions(framework.classes);
    collisionsByFramework.set(framework.name, collisions);
    for (const [canonical, group] of collisions) {
      for (const name of group) {
        globalClassToFile.set(name, canonical);
      }
    }
  }

  for (const framework of frameworksToProcess) {
    const frameworkDir = join(SRC_DIR, framework.name);
    await mkdir(frameworkDir, { recursive: true });

    const fwClasses = frameworkClasses.get(framework.name) ?? new Map<string, ObjCClass>();
    const fwProtos = frameworkProtocolsParsed.get(framework.name) ?? new Map<string, ObjCProtocol>();
    const fwIntEnums = frameworkIntegerEnums.get(framework.name) ?? new Map<string, ObjCIntegerEnum>();
    const fwStrEnums = frameworkStringEnums.get(framework.name) ?? new Map<string, ObjCStringEnum>();

    // Detect case-insensitive filename collisions among this framework's classes
    const collisions = collisionsByFramework.get(framework.name)!;
    const collisionMembers = new Set<string>();
    for (const group of collisions.values()) {
      for (const name of group) {
        collisionMembers.add(name);
      }
    }

    if (collisions.size > 0) {
      console.log(`  ${framework.name}: ${collisions.size} case-collision group(s) — merging into shared files`);
    }

    // Emit class files
    const generatedClasses: string[] = [];
    const classWritePromises: Promise<void>[] = [];

    // First: emit merged files for collision groups
    for (const [canonical, group] of collisions) {
      // Delete stale files first — on case-insensitive filesystems (macOS APFS),
      // writing to a different-cased filename doesn't update the on-disk name.
      for (const name of group) {
        try {
          await unlink(join(frameworkDir, `${name}.ts`));
        } catch {}
      }
      const groupClasses: ObjCClass[] = [];
      for (const name of group) {
        const cls = fwClasses.get(name);
        if (cls) {
          groupClasses.push(cls);
          generatedClasses.push(name);
        }
      }
      if (groupClasses.length === 0) continue;

      const content = emitMergedClassFile(
        groupClasses,
        framework,
        frameworks,
        parsedClassNames,
        allParsedClasses,
        allParsedProtocolNames,
        globalClassToFile,
        allParsedProtocols
      );
      classWritePromises.push(writeFile(join(frameworkDir, `${canonical}.ts`), content));
    }

    // Then: emit single-class files for non-colliding classes
    for (const className of framework.classes) {
      if (collisionMembers.has(className)) continue;
      const cls = fwClasses.get(className);
      if (!cls) continue;

      const content = emitClassFile(
        cls,
        framework,
        frameworks,
        parsedClassNames,
        allParsedClasses,
        allParsedProtocolNames,
        globalClassToFile,
        allParsedProtocols
      );
      classWritePromises.push(writeFile(join(frameworkDir, `${className}.ts`), content));
      generatedClasses.push(className);
    }

    // Emit protocol files
    const generatedProtocols: string[] = [];
    const protoWritePromises: Promise<void>[] = [];

    for (const protoName of framework.protocols) {
      const proto = fwProtos.get(protoName);
      if (!proto) continue;

      const content = emitProtocolFile(
        proto,
        framework,
        frameworks,
        parsedClassNames,
        allParsedProtocolNames,
        globalClassToFile
      );
      protoWritePromises.push(writeFile(join(frameworkDir, `${protoName}.ts`), content));
      generatedProtocols.push(protoName);
    }

    // Emit integer enum files
    const generatedIntegerEnums: string[] = [];
    const enumWritePromises: Promise<void>[] = [];
    const enumContents = new Map<string, string>(); // enumName -> file content

    for (const enumName of framework.integerEnums) {
      const enumDef = fwIntEnums.get(enumName);
      if (!enumDef) continue;

      enumContents.set(enumName, emitIntegerEnumFile(enumDef));
      generatedIntegerEnums.push(enumName);
    }

    // Emit string enum files
    const generatedStringEnums: string[] = [];
    const generatedStringEnumsTypeOnly: string[] = [];

    for (const enumName of framework.stringEnums) {
      const enumDef = fwStrEnums.get(enumName);
      if (!enumDef) continue;

      enumContents.set(enumName, emitStringEnumFile(enumDef, framework.name));

      // Enums with resolved values export a const + type; unresolved ones are type-only
      const hasResolvedValues = enumDef.values.some((v) => v.value !== null);
      if (hasResolvedValues) {
        generatedStringEnums.push(enumName);
      } else {
        generatedStringEnumsTypeOnly.push(enumName);
      }
    }

    // Detect enum case collisions (names that produce the same filename on
    // case-insensitive filesystems like macOS HFS+/APFS)
    const allGenEnumNames = [...generatedIntegerEnums, ...generatedStringEnums, ...generatedStringEnumsTypeOnly];
    const enumCollisions = groupCaseCollisions(allGenEnumNames);
    const enumCollisionMembers = new Set<string>();
    const enumToFile = new Map<string, string>();
    for (const [canonical, group] of enumCollisions) {
      for (const name of group) {
        enumCollisionMembers.add(name);
        enumToFile.set(name, canonical);
      }
    }

    if (enumCollisions.size > 0) {
      console.log(
        `  ${framework.name}: ${enumCollisions.size} enum case-collision group(s) — merging into shared files`
      );
    }

    // Write merged files for enum collision groups
    for (const [canonical, group] of enumCollisions) {
      // Delete stale files first — on case-insensitive filesystems (macOS APFS),
      // writing to a different-cased filename doesn't update the on-disk name.
      for (const name of group) {
        try {
          await unlink(join(frameworkDir, `${name}.ts`));
        } catch {}
      }
      const parts: string[] = [];
      let isFirst = true;
      for (const name of group) {
        const content = enumContents.get(name);
        if (!content) continue;
        if (isFirst) {
          parts.push(content);
          isFirst = false;
        } else {
          // Strip the AUTO-GENERATED header from subsequent entries
          const withoutHeader = content.replace(/^\/\/ AUTO-GENERATED[^\n]*\n/, "");
          parts.push(withoutHeader);
        }
      }
      enumWritePromises.push(writeFile(join(frameworkDir, `${canonical}.ts`), parts.join("\n")));
    }

    // Write individual (non-colliding) enum files
    for (const [enumName, content] of enumContents) {
      if (enumCollisionMembers.has(enumName)) continue;
      enumWritePromises.push(writeFile(join(frameworkDir, `${enumName}.ts`), content));
    }

    // Wait for all file writes in this framework to complete
    await Promise.all([...classWritePromises, ...protoWritePromises, ...enumWritePromises]);

    // Emit framework index
    const indexContent = emitFrameworkIndex(
      framework,
      generatedClasses,
      generatedProtocols,
      collisions,
      generatedIntegerEnums,
      generatedStringEnums,
      generatedStringEnumsTypeOnly,
      enumToFile
    );
    await writeFile(join(frameworkDir, "index.ts"), indexContent);
    generatedProtocolsByFramework.set(framework.name, generatedProtocols);

    const totalEnumCount =
      generatedIntegerEnums.length + generatedStringEnums.length + generatedStringEnumsTypeOnly.length;
    console.log(
      `  ${framework.name}: ${generatedClasses.length} class files + ${generatedProtocols.length} protocol files + ${totalEnumCount} enum files + index.ts`
    );
  }

  // Emit shared files only during full regeneration (they depend on all frameworks)
  if (!isFiltered) {
    // Remove old monolithic structs.ts if it exists (replaced by src/structs/ directory)
    const oldStructsFile = join(SRC_DIR, "structs.ts");
    if (existsSync(oldStructsFile)) {
      await unlink(oldStructsFile);
    }

    // Emit individual struct files under src/structs/
    const structsDir = join(SRC_DIR, "structs");
    await mkdir(structsDir, { recursive: true });

    const structWritePromises: Promise<void>[] = [];
    for (const def of structDefs) {
      const content = emitStructFile(def, structDefs);
      structWritePromises.push(writeFile(join(structsDir, `${def.tsName}.ts`), content));
    }
    await Promise.all(structWritePromises);

    // Emit structs barrel index
    const structIndexContent = emitStructIndex(structDefs);
    await writeFile(join(structsDir, "index.ts"), structIndexContent);

    console.log(`  structs: ${structDefs.length} struct files + index.ts`);

    // Emit delegates file (ProtocolMap + createDelegate)
    const delegatesContent = emitDelegatesFile(frameworks, generatedProtocolsByFramework);
    await writeFile(join(SRC_DIR, "delegates.ts"), delegatesContent);

    // Emit top-level index
    const topIndex = emitTopLevelIndex(frameworks.map((f) => f.name));
    await writeFile(join(SRC_DIR, "index.ts"), topIndex);

    // Copy template files from generator/templates/ into src/
    const templatesDir = join(import.meta.dir, "templates");
    if (existsSync(templatesDir)) {
      const templateFiles = await readdir(templatesDir);
      await Promise.all(templateFiles.map((file) => copyFile(join(templatesDir, file), join(SRC_DIR, file))));
      if (templateFiles.length > 0) {
        console.log(`  Copied ${templateFiles.length} template file(s) to src/`);
      }
    }
  }

  const emitTime = ((performance.now() - emitStart) / 1000).toFixed(1);
  const totalTime = ((performance.now() - globalStart) / 1000).toFixed(1);
  console.log(`\n  Emitted files in ${emitTime}s`);
  console.log(
    `\n=== Generation complete${isFiltered ? " (partial)" : ""} (${totalTime}s total, ${discoveryTime}s discovery + ${parseTime}s parsing + ${emitTime}s emit) ===`
  );

  // Print summary
  let totalClasses = 0;
  let totalProtocols = 0;
  let totalEnums = 0;
  for (const fw of frameworksToProcess) {
    const dir = join(SRC_DIR, fw.name);
    const classCount = fw.classes.filter((c) => existsSync(join(dir, `${c}.ts`))).length;
    const protoCount = fw.protocols.filter((p) => existsSync(join(dir, `${p}.ts`))).length;
    const enumCount = [...fw.integerEnums, ...fw.stringEnums].filter((e) => existsSync(join(dir, `${e}.ts`))).length;
    console.log(`  ${fw.name}: ${classCount} classes, ${protoCount} protocols, ${enumCount} enums`);
    totalClasses += classCount;
    totalProtocols += protoCount;
    totalEnums += enumCount;
  }
  console.log(`  Total: ${totalClasses} classes, ${totalProtocols} protocols, ${totalEnums} enums`);

  // Clean up the compiled ObjC helper binary
  await cleanupResolver();
}

main().catch((err) => {
  console.error("Generator failed:", err);
  process.exit(1);
});
