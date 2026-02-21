/**
 * Runs clang to produce AST JSON dumps from Objective-C header files.
 */

const SDK_PATH = "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk";

export interface ClangASTNode {
  id: string;
  kind: string;
  name?: string;
  mangledName?: string;
  loc?: Record<string, unknown>;
  range?: Record<string, unknown>;
  inner?: ClangASTNode[];
  // ObjCInterfaceDecl
  super?: { id: string; kind: string; name: string };
  protocols?: { id: string; kind: string; name: string }[];
  // ObjCMethodDecl
  instance?: boolean;
  returnType?: { qualType: string; desugaredQualType?: string };
  // ObjCPropertyDecl / VarDecl / EnumConstantDecl
  type?: { qualType: string; desugaredQualType?: string; typeAliasDeclId?: string };
  // ObjCCategoryDecl
  interface?: { id: string; kind: string; name: string };
  // ParmVarDecl
  // type is reused
  // Availability
  availability?: unknown[];
  // ObjCPropertyDecl attributes
  readonly?: boolean;
  readwrite?: boolean;
  // For checking if implicit
  isImplicit?: boolean;
  // EnumDecl
  fixedUnderlyingType?: { qualType: string; desugaredQualType?: string; typeAliasDeclId?: string };
  previousDecl?: string;
  // VarDecl
  storageClass?: string;
  // ConstantExpr
  value?: string;
}

/** Node kinds we actually need from the AST (ObjC decls, enums, structs, typedefs, vars for string enums) */
const RELEVANT_KINDS = new Set([
  "ObjCInterfaceDecl",
  "ObjCCategoryDecl",
  "ObjCProtocolDecl",
  "EnumDecl",
  "RecordDecl",
  "TypedefDecl",
  "VarDecl"
]);

/**
 * Strip the top-level AST to only keep nodes we care about.
 * The clang AST includes thousands of FunctionDecl, TypedefDecl for C stdlib,
 * RecordDecl for POSIX structs, etc. that we never process. By pruning these
 * immediately after JSON.parse, we allow GC to reclaim ~50-70% of the parsed
 * AST memory.
 *
 * This mutates the AST in place for minimal allocation.
 */
function pruneAST(ast: ClangASTNode): ClangASTNode {
  if (ast.inner) {
    ast.inner = ast.inner.filter((node) => RELEVANT_KINDS.has(node.kind));
  }
  return ast;
}

/**
 * Run clang on a header file and return the parsed AST JSON.
 * Clang may exit with code 1 due to warnings but still produce valid AST JSON.
 */
export async function clangASTDump(headerPath: string): Promise<ClangASTNode> {
  const proc = Bun.spawn(
    [
      "clang",
      "-Xclang",
      "-ast-dump=json",
      "-fsyntax-only",
      "-x",
      "objective-c",
      "-isysroot",
      SDK_PATH,
      "-fmodules",
      "-Xclang",
      "-fparse-all-comments",
      headerPath
    ],
    { stdout: "pipe", stderr: "ignore" }
  );
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return pruneAST(JSON.parse(text) as ClangASTNode);
}

/**
 * Run clang on a header file WITHOUT -fmodules, using pre-includes instead.
 * This is needed for some WebKit headers where -fmodules causes macro
 * resolution issues (e.g., WK_EXTERN, API_AVAILABLE not expanding properly).
 */
export async function clangASTDumpWithPreIncludes(headerPath: string, preIncludes: string[]): Promise<ClangASTNode> {
  const args = ["clang", "-Xclang", "-ast-dump=json", "-fsyntax-only", "-x", "objective-c", "-isysroot", SDK_PATH];
  for (const inc of preIncludes) {
    args.push("-include", inc);
  }
  args.push("-Xclang", "-fparse-all-comments");
  args.push(headerPath);

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return pruneAST(JSON.parse(text) as ClangASTNode);
}

/**
 * Run clang on multiple header files at once by creating a temporary .m file
 * with #include directives for all headers. This avoids spawning a separate
 * clang process per header, dramatically reducing total parse time.
 *
 * IMPORTANT: This runs WITHOUT -fmodules because modules deduplicate content
 * and produce incomplete ASTs when batching. Instead, pre-includes are used
 * to ensure macros (API_AVAILABLE, NS_ENUM, etc.) are properly expanded.
 *
 * @param headerPaths - Array of absolute paths to .h header files to include
 * @param preIncludes - Headers to include before the batch (e.g., Foundation/Foundation.h)
 * @param extraArgs - Additional clang arguments (e.g., ["-I", "/path/to/includes"])
 */
export async function clangBatchASTDump(
  headerPaths: string[],
  preIncludes: string[],
  extraArgs?: string[]
): Promise<ClangASTNode> {
  // Create a temporary .m file that includes all headers
  const includes = headerPaths.map((p) => `#include "${p}"`).join("\n");
  const tmpPath = `${Bun.env.TMPDIR ?? "/tmp"}/objcjs-batch-${Date.now()}-${Math.random().toString(36).slice(2)}.m`;
  await Bun.write(tmpPath, includes + "\n");

  try {
    const args = ["clang", "-Xclang", "-ast-dump=json", "-fsyntax-only", "-x", "objective-c", "-isysroot", SDK_PATH];
    for (const inc of preIncludes) {
      args.push("-include", inc);
    }
    if (extraArgs) {
      args.push(...extraArgs);
    }
    args.push("-Xclang", "-fparse-all-comments");
    args.push(tmpPath);

    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return pruneAST(JSON.parse(text) as ClangASTNode);
  } finally {
    // Clean up temp file
    try {
      await Bun.write(tmpPath, "");
    } catch {}
    try {
      const { unlink } = await import("fs/promises");
      await unlink(tmpPath);
    } catch {}
  }
}
