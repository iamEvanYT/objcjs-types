/**
 * Type-level test: verifies that NSString-backed string enum parameters are
 * typed as NSString objects at call sites, while getters still expose the
 * string-enum alias type.
 *
 * This file is NOT meant to be executed — it only needs to typecheck.
 * Run: bunx tsgo --noEmit tests/string-enum-params.ts
 */

import { NSProgress, NSProgressFileOperationKind, NSProgressKind, type _NSProgress } from "../src/Foundation/index.js";
import { NSStringFromString, type NSStringLiteral } from "../src/helpers.js";

declare const progress: _NSProgress;

const kindString = NSStringFromString(NSProgressKind.File);
const fileOperationKindString = NSStringFromString(NSProgressFileOperationKind.Downloading);
const typedKind: NSProgressKind = kindString;
const typedFileOperationKind: NSProgressFileOperationKind = fileOperationKindString;
void typedKind;
void typedFileOperationKind;

progress.setKind$(kindString);
progress.setFileOperationKind$(fileOperationKindString);

const kind: NSProgressKind | null = progress.kind();
const fileOperationKind: NSProgressFileOperationKind | null = progress.fileOperationKind();
void kind;
void fileOperationKind;

const detached = NSProgress.discreteProgressWithTotalUnitCount$(1);
detached.setKind$(NSStringFromString(NSProgressKind.File));
