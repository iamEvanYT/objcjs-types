/**
 * Runs clang to produce AST JSON dumps from Objective-C header files.
 */

const SDK_PATH =
  "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk";

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
      headerPath,
    ],
    { stdout: "pipe", stderr: "ignore" }
  );
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(text) as ClangASTNode;
}

/**
 * Run clang on a header file WITHOUT -fmodules, using pre-includes instead.
 * This is needed for some WebKit headers where -fmodules causes macro
 * resolution issues (e.g., WK_EXTERN, API_AVAILABLE not expanding properly).
 */
export async function clangASTDumpWithPreIncludes(
  headerPath: string,
  preIncludes: string[]
): Promise<ClangASTNode> {
  const args = [
    "clang",
    "-Xclang",
    "-ast-dump=json",
    "-fsyntax-only",
    "-x",
    "objective-c",
    "-isysroot",
    SDK_PATH,
  ];
  for (const inc of preIncludes) {
    args.push("-include", inc);
  }
  args.push("-Xclang", "-fparse-all-comments");
  args.push(headerPath);

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(text) as ClangASTNode;
}
