#!/usr/bin/env bun
/**
 * CLI entry point for objcjs-types.
 *
 * Usage:
 *   bunx objcjs-types generate-custom header1.h [header2.h ...] [--include <header>] [-I <path>] [-D <macro[=value]>]
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const subcommand = process.argv[2];

if (!subcommand || subcommand === "--help" || subcommand === "-h") {
  console.log("Usage: objcjs-types <command> [options]\n");
  console.log("Commands:");
  console.log("  generate-custom   Generate TypeScript types from custom Objective-C headers");
  console.log("\nRun `objcjs-types <command> --help` for command-specific usage.");
  process.exit(0);
}

if (subcommand === "generate-custom") {
  // Strip the subcommand from argv so custom.ts sees only header args / flags
  process.argv = [process.argv[0]!, process.argv[1]!, ...process.argv.slice(3)];
  await import(join(__dirname, "..", "generator", "custom.ts"));
} else {
  console.error(`Unknown command: ${subcommand}`);
  console.error("Run `objcjs-types --help` for available commands.");
  process.exit(1);
}
