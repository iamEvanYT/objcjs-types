/**
 * Main generator CLI — orchestrates the full pipeline:
 * 1. Discover frameworks and scan headers for class/protocol names
 * 2. Parse headers in parallel via worker threads (clang AST dump + parsing)
 * 3. Collect results and build shared type-mapping state
 * 4. Emit .ts declaration files
 */

import { mkdir, writeFile, readdir, copyFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { discoverAllFrameworks, getHeaderPath, getProtocolHeaderPath, getEnumHeaderPath, type FrameworkConfig } from "./frameworks.ts";
import { discoverFramework } from "./discover.ts";
import type { ObjCClass, ObjCProtocol, ObjCIntegerEnum, ObjCStringEnum } from "./ast-parser.ts";
import { setKnownClasses, setKnownProtocols, setProtocolConformers, setKnownIntegerEnums, setKnownStringEnums } from "./type-mapper.ts";
import { resolveStringConstants, cleanupResolver } from "./resolve-strings.ts";
import {
  emitClassFile,
  emitMergedClassFile,
  emitProtocolFile,
  emitFrameworkIndex,
  emitTopLevelIndex,
  emitDelegatesFile,
  emitStructsFile,
  emitIntegerEnumFile,
  emitStringEnumFile,
  groupCaseCollisions,
} from "./emitter.ts";
import { WorkerPool } from "./worker-pool.ts";
import type { UnifiedParseResult } from "./worker-pool.ts";

const SRC_DIR = join(import.meta.dir, "..", "src");

async function main(): Promise<void> {
  console.log("=== objcjs-types generator ===\n");
  const globalStart = performance.now();

  // --- Parse CLI args: optional framework name filter ---
  // Usage: bun run generate [Framework1 Framework2 ...]
  // If no names given, all frameworks are regenerated.
  const filterNames = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
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
    ) continue;

    const fw: FrameworkConfig = {
      ...base,
      classes: [...discovery.classes.keys()].sort(),
      protocols: [...discovery.protocols.keys()].sort(),
      integerEnums: [...discovery.integerEnums.keys()].sort(),
      stringEnums: [...discovery.stringEnums.keys()].sort(),
      classHeaders: discovery.classes,
      protocolHeaders: discovery.protocols,
      integerEnumHeaders: discovery.integerEnums,
      stringEnumHeaders: discovery.stringEnums,
    };
    frameworks.push(fw);

    const enumCount = fw.integerEnums.length + fw.stringEnums.length;
    console.log(
      `  ${fw.name}: ${fw.classes.length} classes, ${fw.protocols.length} protocols, ${enumCount} enums`
    );
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
  const frameworksToProcess = isFiltered
    ? frameworks.filter((fw) => filterSet.has(fw.name))
    : frameworks;

  // ========================================
  // Phase 2: Build unified parse tasks
  // ========================================
  // Instead of separate class/protocol/enum tasks that each invoke clang,
  // we merge all work for the same header file into a single unified task.
  // This eliminates redundant clang invocations when a header contains
  // classes, protocols, AND enums.

  /** Unified task: all parse targets for a single header file */
  interface UnifiedParseTask {
    frameworkName: string;
    headerPath: string;
    classTargets: string[];
    protocolTargets: string[];
    integerEnumTargets: string[];
    stringEnumTargets: string[];
    fallbackPreIncludes: string[];
    isExtra: boolean;
  }

  const unifiedTasks: UnifiedParseTask[] = [];
  // Track extra header tasks separately — they have different merge semantics
  const extraTasks: UnifiedParseTask[] = [];

  for (const fw of frameworksToProcess) {
    const fallbackPreIncludes = [
      "Foundation/Foundation.h",
      ...(fw.preIncludes ?? []),
    ];

    // Collect all targets grouped by header path for this framework
    const headerTargets = new Map<string, {
      classTargets: string[];
      protocolTargets: string[];
      integerEnumTargets: string[];
      stringEnumTargets: string[];
    }>();

    function getOrCreateHeaderTargets(headerPath: string) {
      let entry = headerTargets.get(headerPath);
      if (!entry) {
        entry = { classTargets: [], protocolTargets: [], integerEnumTargets: [], stringEnumTargets: [] };
        headerTargets.set(headerPath, entry);
      }
      return entry;
    }

    // --- Class targets ---
    for (const className of fw.classes) {
      const headerPath = getHeaderPath(fw, className);
      if (!existsSync(headerPath)) {
        console.log(`  [SKIP] Header not found: ${headerPath}`);
        continue;
      }
      getOrCreateHeaderTargets(headerPath).classTargets.push(className);
    }

    // --- Protocol targets ---
    for (const protoName of fw.protocols) {
      const headerPath = getProtocolHeaderPath(fw, protoName);
      if (!existsSync(headerPath)) {
        console.log(`  [SKIP] Protocol header not found: ${headerPath}`);
        continue;
      }
      getOrCreateHeaderTargets(headerPath).protocolTargets.push(protoName);
    }

    // --- Integer enum targets ---
    for (const enumName of fw.integerEnums) {
      const headerPath = getEnumHeaderPath(fw, enumName, "integer");
      if (!existsSync(headerPath)) {
        console.log(`  [SKIP] Enum header not found: ${headerPath}`);
        continue;
      }
      getOrCreateHeaderTargets(headerPath).integerEnumTargets.push(enumName);
    }

    // --- String enum targets ---
    for (const enumName of fw.stringEnums) {
      const headerPath = getEnumHeaderPath(fw, enumName, "string");
      if (!existsSync(headerPath)) {
        console.log(`  [SKIP] Enum header not found: ${headerPath}`);
        continue;
      }
      getOrCreateHeaderTargets(headerPath).stringEnumTargets.push(enumName);
    }

    // Build unified tasks from merged targets
    for (const [headerPath, targets] of headerTargets) {
      unifiedTasks.push({
        frameworkName: fw.name,
        headerPath,
        classTargets: targets.classTargets,
        protocolTargets: targets.protocolTargets,
        integerEnumTargets: targets.integerEnumTargets,
        stringEnumTargets: targets.stringEnumTargets,
        fallbackPreIncludes,
        isExtra: false,
      });
    }

    // --- Extra header tasks (e.g., runtime NSObject.h for alloc/init) ---
    // These are always separate since they have different merge semantics
    if (fw.extraHeaders) {
      for (const [className, headerPath] of Object.entries(fw.extraHeaders)) {
        if (!existsSync(headerPath)) {
          console.log(`  [SKIP] Extra header not found: ${headerPath}`);
          continue;
        }
        extraTasks.push({
          frameworkName: fw.name,
          headerPath,
          classTargets: [className],
          protocolTargets: [],
          integerEnumTargets: [],
          stringEnumTargets: [],
          fallbackPreIncludes: [], // Extra headers don't use fallback
          isExtra: true,
        });
      }
    }
  }

  const allTasks = [...unifiedTasks, ...extraTasks];

  // ========================================
  // Phase 3: Parallel parsing via worker pool
  // ========================================

  const poolSize = navigator.hardwareConcurrency ?? 4;
  const pool = new WorkerPool(poolSize);
  const totalTasks = allTasks.length;
  let completedTasks = 0;

  console.log(
    `Parsing ${totalTasks} headers (unified) using ${pool.size} worker threads...`
  );

  const startTime = performance.now();

  /** Update the progress counter on the current console line. */
  const trackProgress = () => {
    completedTasks++;
    process.stdout.write(`\r  Progress: ${completedTasks}/${totalTasks} headers parsed`);
  };

  // Dispatch all unified tasks concurrently.
  const taskPromises = allTasks.map((task) =>
    pool
      .parseAll(
        task.headerPath,
        task.classTargets,
        task.protocolTargets,
        task.integerEnumTargets,
        task.stringEnumTargets,
        task.fallbackPreIncludes.length > 0 ? task.fallbackPreIncludes : undefined
      )
      .then((result) => {
        trackProgress();
        return { task, result, error: null as string | null };
      })
      .catch((err) => {
        trackProgress();
        return { task, result: null as UnifiedParseResult | null, error: String(err) };
      })
  );

  // Wait for all parse tasks to complete
  const allResults = await Promise.all(taskPromises);

  pool.destroy();

  const parseTime = ((performance.now() - startTime) / 1000).toFixed(1);
  process.stdout.write(`\r  Parsed ${totalTasks} headers in ${parseTime}s          \n\n`);

  // ========================================
  // Phase 4: Collect results and build shared state
  // ========================================

  // Organize parsed classes by framework
  const frameworkClasses = new Map<string, Map<string, ObjCClass>>();
  const allParsedClasses = new Map<string, ObjCClass>();

  // First pass: regular (non-extra) results
  for (const { task, result, error } of allResults) {
    if (task.isExtra) continue; // Handle in second pass
    if (error) {
      console.log(`  [ERROR] ${task.headerPath}: ${error}`);
      continue;
    }
    if (!result) continue;

    // --- Classes ---
    if (result.classes.size > 0) {
      if (!frameworkClasses.has(task.frameworkName)) {
        frameworkClasses.set(task.frameworkName, new Map());
      }
      const fwClasses = frameworkClasses.get(task.frameworkName)!;
      for (const [name, cls] of result.classes) {
        fwClasses.set(name, cls);
        allParsedClasses.set(name, cls);
      }
    }
  }

  // Second pass: extra header results (merge into existing classes)
  for (const { task, result, error } of allResults) {
    if (!task.isExtra) continue;
    if (error) {
      console.log(`  [ERROR] Extra header ${task.headerPath}: ${error}`);
      continue;
    }
    if (!result) continue;

    if (!frameworkClasses.has(task.frameworkName)) {
      frameworkClasses.set(task.frameworkName, new Map());
    }
    const fwClasses = frameworkClasses.get(task.frameworkName)!;

    for (const [className, extraCls] of result.classes) {
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
  for (const { task, result, error } of allResults) {
    if (task.isExtra) continue;
    if (error || !result) continue;
    if (result.protocols.size === 0) continue;

    if (!frameworkProtocolsParsed.has(task.frameworkName)) {
      frameworkProtocolsParsed.set(task.frameworkName, new Map());
    }
    const fwProtos = frameworkProtocolsParsed.get(task.frameworkName)!;
    for (const [name, proto] of result.protocols) {
      fwProtos.set(name, proto);
    }
  }

  // Organize parsed enums by framework
  const frameworkIntegerEnums = new Map<string, Map<string, ObjCIntegerEnum>>();
  const frameworkStringEnums = new Map<string, Map<string, ObjCStringEnum>>();
  for (const { task, result, error } of allResults) {
    if (task.isExtra) continue;
    if (error || !result) continue;
    if (result.integerEnums.size === 0 && result.stringEnums.size === 0) continue;

    if (!frameworkIntegerEnums.has(task.frameworkName)) {
      frameworkIntegerEnums.set(task.frameworkName, new Map());
    }
    if (!frameworkStringEnums.has(task.frameworkName)) {
      frameworkStringEnums.set(task.frameworkName, new Map());
    }

    const fwIntEnums = frameworkIntegerEnums.get(task.frameworkName)!;
    const fwStrEnums = frameworkStringEnums.get(task.frameworkName)!;

    for (const [name, enumDef] of result.integerEnums) {
      fwIntEnums.set(name, enumDef);
    }
    for (const [name, enumDef] of result.stringEnums) {
      fwStrEnums.set(name, enumDef);
    }
  }

  // Resolve actual string values for extern NSString * constants.
  // This compiles a small ObjC helper once, then invokes it per-framework
  // with the symbol names discovered during parsing.
  console.log("Resolving string enum values from framework binaries...");
  let totalResolved = 0;
  let totalStringSymbols = 0;

  // Build resolution tasks, then run them all in parallel
  const resolvePromises: Promise<{
    fwName: string;
    resolved: Map<string, string>;
    symbolCount: number;
  } | null>[] = [];

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

    resolvePromises.push(
      resolveStringConstants(fw.libraryPath, allSymbols)
        .then((resolved) => ({
          fwName: fw.name,
          resolved,
          symbolCount: allSymbols.length,
        }))
        .catch((err) => {
          console.log(`  [WARN] Failed to resolve string values for ${fw.name}: ${err}`);
          return null;
        })
    );

    totalStringSymbols += allSymbols.length;
  }

  // Wait for all resolution tasks to complete
  const resolveResults = await Promise.all(resolvePromises);

  // Populate resolved values back into enum definitions
  for (const resolveResult of resolveResults) {
    if (!resolveResult) continue;
    const fwStrEnums = frameworkStringEnums.get(resolveResult.fwName);
    if (!fwStrEnums) continue;

    for (const enumDef of fwStrEnums.values()) {
      for (const v of enumDef.values) {
        const value = resolveResult.resolved.get(v.symbolName);
        if (value !== undefined) {
          v.value = value;
          totalResolved++;
        }
      }
    }
  }

  console.log(`  Resolved ${totalResolved}/${totalStringSymbols} string enum values\n`);

  // Build protocol -> conforming classes map from all parsed classes.
  // This must happen after ALL parsing completes so every conformance is known.
  const protocolConformers = new Map<string, Set<string>>();
  for (const [className, cls] of allParsedClasses) {
    if (!allKnownClasses.has(className)) continue;
    for (const protoName of cls.protocols) {
      if (!protocolConformers.has(protoName)) {
        protocolConformers.set(protoName, new Set());
      }
      protocolConformers.get(protoName)!.add(className);
    }
  }
  setProtocolConformers(protocolConformers);

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

  // ========================================
  // Phase 5: Emit files
  // ========================================

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
      console.log(
        `  ${framework.name}: ${collisions.size} case-collision group(s) — merging into shared files`
      );
    }

    // Emit class files
    const generatedClasses: string[] = [];
    const classWritePromises: Promise<void>[] = [];

    // First: emit merged files for collision groups
    for (const [canonical, group] of collisions) {
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
        allKnownClasses,
        allParsedClasses,
        allKnownProtocols,
        globalClassToFile
      );
      classWritePromises.push(
        writeFile(join(frameworkDir, `${canonical}.ts`), content)
      );
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
        allKnownClasses,
        allParsedClasses,
        allKnownProtocols,
        globalClassToFile
      );
      classWritePromises.push(
        writeFile(join(frameworkDir, `${className}.ts`), content)
      );
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
        allKnownClasses,
        allKnownProtocols,
        globalClassToFile
      );
      protoWritePromises.push(
        writeFile(join(frameworkDir, `${protoName}.ts`), content)
      );
      generatedProtocols.push(protoName);
    }

    // Emit integer enum files
    const generatedIntegerEnums: string[] = [];
    const enumWritePromises: Promise<void>[] = [];

    for (const enumName of framework.integerEnums) {
      const enumDef = fwIntEnums.get(enumName);
      if (!enumDef) continue;

      const content = emitIntegerEnumFile(enumDef);
      enumWritePromises.push(
        writeFile(join(frameworkDir, `${enumName}.ts`), content)
      );
      generatedIntegerEnums.push(enumName);
    }

    // Emit string enum files
    const generatedStringEnums: string[] = [];
    const generatedStringEnumsTypeOnly: string[] = [];

    for (const enumName of framework.stringEnums) {
      const enumDef = fwStrEnums.get(enumName);
      if (!enumDef) continue;

      const content = emitStringEnumFile(enumDef, framework.name);
      enumWritePromises.push(
        writeFile(join(frameworkDir, `${enumName}.ts`), content)
      );

      // Enums with resolved values export a const + type; unresolved ones are type-only
      const hasResolvedValues = enumDef.values.some((v) => v.value !== null);
      if (hasResolvedValues) {
        generatedStringEnums.push(enumName);
      } else {
        generatedStringEnumsTypeOnly.push(enumName);
      }
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
      generatedStringEnumsTypeOnly
    );
    await writeFile(join(frameworkDir, "index.ts"), indexContent);
    generatedProtocolsByFramework.set(framework.name, generatedProtocols);

    const totalEnumCount = generatedIntegerEnums.length + generatedStringEnums.length + generatedStringEnumsTypeOnly.length;
    console.log(
      `  ${framework.name}: ${generatedClasses.length} class files + ${generatedProtocols.length} protocol files + ${totalEnumCount} enum files + index.ts`
    );
  }

  // Emit shared files only during full regeneration (they depend on all frameworks)
  if (!isFiltered) {
    // Emit structs file
    const structsContent = emitStructsFile();
    await writeFile(join(SRC_DIR, "structs.ts"), structsContent);

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
      await Promise.all(
        templateFiles.map((file) =>
          copyFile(join(templatesDir, file), join(SRC_DIR, file))
        )
      );
      if (templateFiles.length > 0) {
        console.log(`  Copied ${templateFiles.length} template file(s) to src/`);
      }
    }
  }

  const emitTime = ((performance.now() - emitStart) / 1000).toFixed(1);
  const totalTime = ((performance.now() - globalStart) / 1000).toFixed(1);
  console.log(`\n  Emitted files in ${emitTime}s`);
  console.log(`\n=== Generation complete${isFiltered ? " (partial)" : ""} (${totalTime}s total, ${discoveryTime}s discovery + ${parseTime}s parsing + ${emitTime}s emit) ===`);

  // Print summary
  let totalClasses = 0;
  let totalProtocols = 0;
  let totalEnums = 0;
  for (const fw of frameworksToProcess) {
    const dir = join(SRC_DIR, fw.name);
    const classCount = fw.classes.filter((c) =>
      existsSync(join(dir, `${c}.ts`))
    ).length;
    const protoCount = fw.protocols.filter((p) =>
      existsSync(join(dir, `${p}.ts`))
    ).length;
    const enumCount = [...fw.integerEnums, ...fw.stringEnums].filter((e) =>
      existsSync(join(dir, `${e}.ts`))
    ).length;
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
