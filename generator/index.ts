/**
 * Main generator CLI — orchestrates the full pipeline:
 * 1. Run clang on each header file
 * 2. Parse the AST to extract class/method/property data
 * 3. Map ObjC types to TypeScript types
 * 4. Emit .ts declaration files
 */

import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { FRAMEWORK_BASES, getHeaderPath, getProtocolHeaderPath, type FrameworkConfig } from "./frameworks.ts";
import { discoverFramework } from "./discover.ts";
import { clangASTDump, clangASTDumpWithPreIncludes } from "./clang.ts";
import { parseAST, parseProtocols, type ObjCClass } from "./ast-parser.ts";
import { setKnownClasses } from "./type-mapper.ts";
import {
  emitClassFile,
  emitProtocolFile,
  emitFrameworkIndex,
  emitTopLevelIndex,
  emitDelegatesFile,
  emitStructsFile,
} from "./emitter.ts";

const SRC_DIR = join(import.meta.dir, "..", "src");

async function main(): Promise<void> {
  console.log("=== objcjs-types generator ===\n");

  // --- Discovery phase: scan headers to find all classes and protocols ---
  console.log("Discovering classes and protocols from headers...");
  const frameworks: FrameworkConfig[] = [];
  for (const base of FRAMEWORK_BASES) {
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

  // Track all parsed classes across frameworks (for cross-framework references)
  const allParsedClasses = new Map<string, ObjCClass>();

  // Track generated protocols per framework (for delegates.ts generation)
  const generatedProtocolsByFramework = new Map<string, string[]>();

  // Process each framework
  for (const framework of frameworks) {
    console.log(`\n--- Processing ${framework.name} ---`);

    const frameworkDir = join(SRC_DIR, framework.name);
    await mkdir(frameworkDir, { recursive: true });

    // Group classes by their header file to avoid duplicate parsing
    const headerToClasses = new Map<string, string[]>();
    for (const className of framework.classes) {
      const headerPath = getHeaderPath(framework, className);
      if (!headerToClasses.has(headerPath)) {
        headerToClasses.set(headerPath, []);
      }
      headerToClasses.get(headerPath)!.push(className);
    }

    // Parse each unique header
    const frameworkClasses = new Map<string, ObjCClass>();
    let headerCount = 0;

    for (const [headerPath, classNames] of headerToClasses) {
      if (!existsSync(headerPath)) {
        console.log(`  [SKIP] Header not found: ${headerPath}`);
        continue;
      }

      headerCount++;
      const targetSet = new Set(classNames);
      const shortPath = headerPath.split("/Headers/")[1] ?? headerPath;
      process.stdout.write(
        `  [${headerCount}/${headerToClasses.size}] Parsing ${shortPath}...`
      );

      try {
        let ast = await clangASTDump(headerPath);
        let parsed = parseAST(ast, targetSet);

        // Fallback: if no classes found, retry without -fmodules using pre-includes.
        // Some headers (e.g., WebKit) need Foundation macros pre-loaded to parse correctly.
        if (parsed.size === 0) {
          const preIncludes = [
            "Foundation/Foundation.h",
            ...framework.preIncludes ?? [],
          ];
          ast = await clangASTDumpWithPreIncludes(headerPath, preIncludes);
          parsed = parseAST(ast, targetSet);
        }

        for (const [name, cls] of parsed) {
          frameworkClasses.set(name, cls);
          allParsedClasses.set(name, cls);
        }

        const found = classNames.filter((n) => parsed.has(n));
        const missed = classNames.filter((n) => !parsed.has(n));

        console.log(
          ` found ${found.length}/${classNames.length} classes`
        );
        if (missed.length > 0) {
          console.log(`    Missing: ${missed.join(", ")}`);
        }
      } catch (error) {
        console.log(` ERROR: ${error}`);
      }
    }

    // Parse extra headers (e.g., runtime NSObject.h for alloc/init/isKindOfClass: etc.)
    if (framework.extraHeaders) {
      for (const [className, headerPath] of Object.entries(framework.extraHeaders)) {
        if (!existsSync(headerPath)) {
          console.log(`  [SKIP] Extra header not found: ${headerPath}`);
          continue;
        }

        const shortPath = headerPath.split("/SDKs/MacOSX.sdk/")[1] ?? headerPath;
        process.stdout.write(`  [extra] Parsing ${shortPath} for ${className}...`);

        try {
          const ast = await clangASTDump(headerPath);
          const parsed = parseAST(ast, new Set([className]));

          const extraCls = parsed.get(className);
          if (extraCls) {
            const existing = frameworkClasses.get(className);
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
                ` merged ${extraCls.instanceMethods.length} instance, ${extraCls.classMethods.length} class methods, ${extraCls.properties.length} props`
              );
            } else {
              frameworkClasses.set(className, extraCls);
              allParsedClasses.set(className, extraCls);
              console.log(` found class`);
            }
          } else {
            console.log(` class not found in AST`);
          }
        } catch (error) {
          console.log(` ERROR: ${error}`);
        }
      }
    }

    // Emit class files
    const generatedClasses: string[] = [];

    for (const className of framework.classes) {
      const cls = frameworkClasses.get(className);
      if (!cls) continue;

      const content = emitClassFile(
        cls,
        framework,
        frameworks,
        allKnownClasses,
        allParsedClasses
      );
      const filePath = join(frameworkDir, `${className}.ts`);
      await writeFile(filePath, content);
      generatedClasses.push(className);
    }

    // Parse and emit protocol files
    const frameworkProtocols = framework.protocols;
    const generatedProtocols: string[] = [];

    if (frameworkProtocols.length > 0) {
      // Group protocols by their header file
      const protoHeaderToProtocols = new Map<string, string[]>();
      for (const protoName of frameworkProtocols) {
        const headerPath = getProtocolHeaderPath(framework, protoName);
        if (!protoHeaderToProtocols.has(headerPath)) {
          protoHeaderToProtocols.set(headerPath, []);
        }
        protoHeaderToProtocols.get(headerPath)!.push(protoName);
      }

      const targetProtoSet = new Set(frameworkProtocols);
      let protoHeaderCount = 0;

      for (const [headerPath, protoNames] of protoHeaderToProtocols) {
        if (!existsSync(headerPath)) {
          console.log(`  [SKIP] Protocol header not found: ${headerPath}`);
          continue;
        }

        protoHeaderCount++;
        const shortPath = headerPath.split("/Headers/")[1] ?? headerPath;
        process.stdout.write(
          `  [proto ${protoHeaderCount}/${protoHeaderToProtocols.size}] Parsing ${shortPath}...`
        );

        try {
          let ast = await clangASTDump(headerPath);
          let parsed = parseProtocols(ast, targetProtoSet);

          // Fallback: retry without -fmodules if no protocols found
          if (parsed.size === 0) {
            const preIncludes = [
              "Foundation/Foundation.h",
              ...framework.preIncludes ?? [],
            ];
            ast = await clangASTDumpWithPreIncludes(headerPath, preIncludes);
            parsed = parseProtocols(ast, targetProtoSet);
          }

          const found = protoNames.filter((n) => parsed.has(n));
          const missed = protoNames.filter((n) => !parsed.has(n));

          // Emit protocol files — only for protocols expected from this header
          // (the AST may contain protocols from included headers too)
          for (const name of found) {
            const proto = parsed.get(name)!;
            const content = emitProtocolFile(
              proto,
              framework,
              frameworks,
              allKnownClasses,
              allKnownProtocols
            );
            const filePath = join(frameworkDir, `${name}.ts`);
            await writeFile(filePath, content);
            generatedProtocols.push(name);
          }

          console.log(
            ` found ${found.length}/${protoNames.length} protocols`
          );
          if (missed.length > 0) {
            console.log(`    Missing: ${missed.join(", ")}`);
          }
        } catch (error) {
          console.log(` ERROR: ${error}`);
        }
      }
    }

    // Emit framework index
    const indexContent = emitFrameworkIndex(framework, generatedClasses, generatedProtocols);
    await writeFile(join(frameworkDir, "index.ts"), indexContent);
    generatedProtocolsByFramework.set(framework.name, generatedProtocols);

    console.log(
      `  Generated ${generatedClasses.length} class files + ${generatedProtocols.length} protocol files + index.ts`
    );
  }

  // Emit structs file
  const structsContent = emitStructsFile();
  await writeFile(join(SRC_DIR, "structs.ts"), structsContent);

  // Emit delegates file (ProtocolMap + createDelegate)
  const delegatesContent = emitDelegatesFile(frameworks, generatedProtocolsByFramework);
  await writeFile(join(SRC_DIR, "delegates.ts"), delegatesContent);

  // Emit top-level index
  const topIndex = emitTopLevelIndex(frameworks.map((f) => f.name));
  await writeFile(join(SRC_DIR, "index.ts"), topIndex);

  console.log("\n=== Generation complete ===");

  // Print summary
  let totalClasses = 0;
  let totalProtocols = 0;
  for (const fw of frameworks) {
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
