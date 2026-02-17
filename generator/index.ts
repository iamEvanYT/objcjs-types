/**
 * Main generator CLI — orchestrates the full pipeline:
 * 1. Discover frameworks and scan headers for class/protocol names
 * 2. Parse headers in parallel via worker threads (clang AST dump + parsing)
 * 3. Collect results and build shared type-mapping state
 * 4. Emit .ts declaration files
 */

import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { discoverAllFrameworks, getHeaderPath, getProtocolHeaderPath, type FrameworkConfig } from "./frameworks.ts";
import { discoverFramework } from "./discover.ts";
import type { ObjCClass, ObjCProtocol } from "./ast-parser.ts";
import { setKnownClasses, setKnownProtocols, setProtocolConformers } from "./type-mapper.ts";
import {
  emitClassFile,
  emitProtocolFile,
  emitFrameworkIndex,
  emitTopLevelIndex,
  emitDelegatesFile,
  emitStructsFile,
} from "./emitter.ts";
import { WorkerPool } from "./worker-pool.ts";

const SRC_DIR = join(import.meta.dir, "..", "src");

/** Task descriptor for class header parsing */
interface ClassParseTask {
  frameworkName: string;
  headerPath: string;
  targets: string[];
  fallbackPreIncludes: string[];
  isExtra: boolean;
}

/** Task descriptor for protocol header parsing */
interface ProtocolParseTask {
  frameworkName: string;
  headerPath: string;
  targets: string[];
  fallbackPreIncludes: string[];
}

async function main(): Promise<void> {
  console.log("=== objcjs-types generator ===\n");

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
  for (const base of allBases) {
    const discovery = await discoverFramework(base.headersPath);

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

    // Skip frameworks with no ObjC classes or protocols
    if (discovery.classes.size === 0 && discovery.protocols.size === 0) continue;

    const fw: FrameworkConfig = {
      ...base,
      classes: [...discovery.classes.keys()].sort(),
      protocols: [...discovery.protocols.keys()].sort(),
      classHeaders: discovery.classes,
      protocolHeaders: discovery.protocols,
    };
    frameworks.push(fw);

    console.log(
      `  ${fw.name}: ${fw.classes.length} classes, ${fw.protocols.length} protocols`
    );
  }
  console.log("");

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
  // Phase 2: Build parse tasks
  // ========================================

  const classTasks: ClassParseTask[] = [];
  const protocolTasks: ProtocolParseTask[] = [];

  for (const fw of frameworksToProcess) {
    const fallbackPreIncludes = [
      "Foundation/Foundation.h",
      ...(fw.preIncludes ?? []),
    ];

    // --- Class header tasks ---
    // Group classes by their header file to avoid duplicate parsing
    const headerToClasses = new Map<string, string[]>();
    for (const className of fw.classes) {
      const headerPath = getHeaderPath(fw, className);
      if (!headerToClasses.has(headerPath)) {
        headerToClasses.set(headerPath, []);
      }
      headerToClasses.get(headerPath)!.push(className);
    }

    for (const [headerPath, classNames] of headerToClasses) {
      if (!existsSync(headerPath)) {
        console.log(`  [SKIP] Header not found: ${headerPath}`);
        continue;
      }
      classTasks.push({
        frameworkName: fw.name,
        headerPath,
        targets: classNames,
        fallbackPreIncludes,
        isExtra: false,
      });
    }

    // --- Extra header tasks (e.g., runtime NSObject.h for alloc/init) ---
    if (fw.extraHeaders) {
      for (const [className, headerPath] of Object.entries(fw.extraHeaders)) {
        if (!existsSync(headerPath)) {
          console.log(`  [SKIP] Extra header not found: ${headerPath}`);
          continue;
        }
        classTasks.push({
          frameworkName: fw.name,
          headerPath,
          targets: [className],
          fallbackPreIncludes: [], // Extra headers don't use fallback
          isExtra: true,
        });
      }
    }

    // --- Protocol header tasks ---
    const protoHeaderToProtocols = new Map<string, string[]>();
    for (const protoName of fw.protocols) {
      const headerPath = getProtocolHeaderPath(fw, protoName);
      if (!protoHeaderToProtocols.has(headerPath)) {
        protoHeaderToProtocols.set(headerPath, []);
      }
      protoHeaderToProtocols.get(headerPath)!.push(protoName);
    }

    for (const [headerPath, protoNames] of protoHeaderToProtocols) {
      if (!existsSync(headerPath)) {
        console.log(`  [SKIP] Protocol header not found: ${headerPath}`);
        continue;
      }
      protocolTasks.push({
        frameworkName: fw.name,
        headerPath,
        targets: protoNames,
        fallbackPreIncludes,
      });
    }
  }

  // ========================================
  // Phase 3: Parallel parsing via worker pool
  // ========================================

  const poolSize = navigator.hardwareConcurrency ?? 4;
  const pool = new WorkerPool(poolSize);
  const totalTasks = classTasks.length + protocolTasks.length;
  let completedTasks = 0;

  console.log(
    `Parsing ${classTasks.length} class headers + ${protocolTasks.length} protocol headers ` +
    `using ${pool.size} worker threads...`
  );

  const startTime = performance.now();

  /** Update the progress counter on the current console line. */
  const trackProgress = () => {
    completedTasks++;
    process.stdout.write(`\r  Progress: ${completedTasks}/${totalTasks} headers parsed`);
  };

  // Dispatch all class+extra tasks concurrently.
  // The pool handles load balancing — tasks go to idle workers or queue automatically.
  const classPromises = classTasks.map((task) =>
    pool
      .parseClasses(
        task.headerPath,
        task.targets,
        task.fallbackPreIncludes.length > 0 ? task.fallbackPreIncludes : undefined
      )
      .then((result) => {
        trackProgress();
        return { task, result, error: null as string | null };
      })
      .catch((err) => {
        trackProgress();
        return { task, result: null, error: String(err) };
      })
  );

  // Dispatch all protocol tasks concurrently
  const protocolPromises = protocolTasks.map((task) =>
    pool
      .parseProtocols(
        task.headerPath,
        task.targets,
        task.fallbackPreIncludes.length > 0 ? task.fallbackPreIncludes : undefined
      )
      .then((result) => {
        trackProgress();
        return { task, result, error: null as string | null };
      })
      .catch((err) => {
        trackProgress();
        return { task, result: null, error: String(err) };
      })
  );

  // Wait for all parse tasks to complete
  const classResults = await Promise.all(classPromises);
  const protocolResults = await Promise.all(protocolPromises);

  pool.destroy();

  const parseTime = ((performance.now() - startTime) / 1000).toFixed(1);
  process.stdout.write(`\r  Parsed ${totalTasks} headers in ${parseTime}s          \n\n`);

  // ========================================
  // Phase 4: Collect results and build shared state
  // ========================================

  // Organize parsed classes by framework
  const frameworkClasses = new Map<string, Map<string, ObjCClass>>();
  const allParsedClasses = new Map<string, ObjCClass>();

  // First pass: regular (non-extra) class results
  for (const { task, result, error } of classResults) {
    if (task.isExtra) continue; // Handle in second pass
    if (error) {
      console.log(`  [ERROR] ${task.headerPath}: ${error}`);
      continue;
    }
    if (!result) continue;

    if (!frameworkClasses.has(task.frameworkName)) {
      frameworkClasses.set(task.frameworkName, new Map());
    }
    const fwClasses = frameworkClasses.get(task.frameworkName)!;

    for (const [name, cls] of result.classes) {
      fwClasses.set(name, cls);
      allParsedClasses.set(name, cls);
    }
  }

  // Second pass: extra header results (merge into existing classes)
  for (const { task, result, error } of classResults) {
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
  for (const { task, result, error } of protocolResults) {
    if (error) {
      console.log(`  [ERROR] ${task.headerPath}: ${error}`);
      continue;
    }
    if (!result) continue;

    if (!frameworkProtocolsParsed.has(task.frameworkName)) {
      frameworkProtocolsParsed.set(task.frameworkName, new Map());
    }
    const fwProtos = frameworkProtocolsParsed.get(task.frameworkName)!;

    for (const [name, proto] of result.protocols) {
      fwProtos.set(name, proto);
    }
  }

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
    const classCount = fwClasses?.size ?? 0;
    const protoCount = fwProtos?.size ?? 0;
    console.log(
      `  ${fw.name}: parsed ${classCount}/${fw.classes.length} classes, ` +
      `${protoCount}/${fw.protocols.length} protocols`
    );
  }
  console.log("");

  // ========================================
  // Phase 5: Emit files
  // ========================================

  const emitStart = performance.now();
  const generatedProtocolsByFramework = new Map<string, string[]>();

  for (const framework of frameworksToProcess) {
    const frameworkDir = join(SRC_DIR, framework.name);
    await mkdir(frameworkDir, { recursive: true });

    const fwClasses = frameworkClasses.get(framework.name) ?? new Map<string, ObjCClass>();
    const fwProtos = frameworkProtocolsParsed.get(framework.name) ?? new Map<string, ObjCProtocol>();

    // Emit class files
    const generatedClasses: string[] = [];
    const classWritePromises: Promise<void>[] = [];

    for (const className of framework.classes) {
      const cls = fwClasses.get(className);
      if (!cls) continue;

      const content = emitClassFile(
        cls,
        framework,
        frameworks,
        allKnownClasses,
        allParsedClasses,
        allKnownProtocols
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
        allKnownProtocols
      );
      protoWritePromises.push(
        writeFile(join(frameworkDir, `${protoName}.ts`), content)
      );
      generatedProtocols.push(protoName);
    }

    // Wait for all file writes in this framework to complete
    await Promise.all([...classWritePromises, ...protoWritePromises]);

    // Emit framework index
    const indexContent = emitFrameworkIndex(framework, generatedClasses, generatedProtocols);
    await writeFile(join(frameworkDir, "index.ts"), indexContent);
    generatedProtocolsByFramework.set(framework.name, generatedProtocols);

    console.log(
      `  ${framework.name}: ${generatedClasses.length} class files + ${generatedProtocols.length} protocol files + index.ts`
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
  }

  const emitTime = ((performance.now() - emitStart) / 1000).toFixed(1);
  const totalTime = ((performance.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  Emitted files in ${emitTime}s`);
  console.log(`\n=== Generation complete${isFiltered ? " (partial)" : ""} (${totalTime}s total) ===`);

  // Print summary
  let totalClasses = 0;
  let totalProtocols = 0;
  for (const fw of frameworksToProcess) {
    const dir = join(SRC_DIR, fw.name);
    const classCount = fw.classes.filter((c) =>
      existsSync(join(dir, `${c}.ts`))
    ).length;
    const protoCount = fw.protocols.filter((p) =>
      existsSync(join(dir, `${p}.ts`))
    ).length;
    console.log(`  ${fw.name}: ${classCount} classes, ${protoCount} protocols`);
    totalClasses += classCount;
    totalProtocols += protoCount;
  }
  console.log(`  Total: ${totalClasses} classes, ${totalProtocols} protocols`);
}

main().catch((err) => {
  console.error("Generator failed:", err);
  process.exit(1);
});
