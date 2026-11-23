import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { test } from "node:test";
import * as ts from "typescript";

const root = process.cwd();
const sourceRoots = ["server", "shared", "client"];
const entryFiles = ["index.server.ts", "index.client.tsx"];
const nodeBuiltins = new Set(builtinModules);
const allowedPluginSpecifiers = new Set([
  "@getpaseo/plugin",
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/ui",
  "@getpaseo/plugin/client/react-native",
  "@getpaseo/plugin/server",
  "@getpaseo/plugin/server/provider",
  "@getpaseo/plugin/server/usage",
  "@getpaseo/plugin/server/acp",
]);

interface ImportReference {
  file: string;
  specifier: string;
  typeOnly: boolean;
}

function sourceFiles(directory: string): string[] {
  const absoluteDirectory = join(root, directory);
  const files: string[] = [];
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const path = join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") files.push(...sourceFiles(relative(root, path)));
      continue;
    }
    if ((extname(entry.name) === ".ts" || extname(entry.name) === ".tsx") && !entry.name.includes(".test.")) files.push(path);
  }
  return files;
}

function collectImports(file: string): ImportReference[] {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const references: ImportReference[] = [];
  const add = (specifier: string, typeOnly: boolean) => references.push({ file, specifier, typeOnly });

  for (const directive of sourceFile.typeReferenceDirectives) add(directive.fileName, true);
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (ts.isStringLiteral(specifier)) add(specifier.text, Boolean(node.importClause?.isTypeOnly));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, Boolean(node.isTypeOnly));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      add(node.moduleReference.expression.text, false);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      add(node.argument.literal.text, true);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      add(node.arguments[0].text, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || nodeBuiltins.has(specifier);
}

function isAllowedExternal(reference: ImportReference): boolean {
  const { specifier, typeOnly } = reference;
  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) return true;
  if (allowedPluginSpecifiers.has(specifier)) return true;
  if (specifier === "zod" || specifier === "react" || specifier === "react-native" || specifier === "@tanstack/react-query") return true;
  if (specifier.startsWith("@getpaseo/protocol/")) return typeOnly;
  return isNodeBuiltin(specifier);
}

function runtimeBoundaryProblem(reference: ImportReference): string | null {
  const path = relative(root, reference.file).replaceAll("\\", "/");
  const clientOrShared = path.startsWith("client/") || path.startsWith("shared/") || path === "index.client.tsx";
  const serverOrShared = path.startsWith("server/") || path.startsWith("shared/") || path === "index.server.ts";
  const serverOnly = reference.specifier === "@getpaseo/plugin/server" || reference.specifier.startsWith("@getpaseo/plugin/server/");
  const clientOnly = reference.specifier === "@getpaseo/plugin/client" || reference.specifier.startsWith("@getpaseo/plugin/client/");
  if (clientOrShared && isNodeBuiltin(reference.specifier)) return `${path} imports Node builtin ${reference.specifier}`;
  if (clientOrShared && serverOnly) return `${path} imports server-only SDK ${reference.specifier}`;
  if (serverOrShared && clientOnly) return `${path} imports client-only SDK ${reference.specifier}`;
  if (serverOrShared && ["react", "react-native", "@tanstack/react-query"].includes(reference.specifier)) return `${path} imports client runtime ${reference.specifier}`;
  return null;
}

test("all plugin source imports resolve through the Paseo host boundary", () => {
  const files = [...entryFiles.map((file) => join(root, file)), ...sourceRoots.flatMap(sourceFiles)];
  const references = files.flatMap(collectImports);
  const disallowed = references.filter((reference) => !isAllowedExternal(reference));
  assert.deepEqual(disallowed, [], disallowed.map(({ file, specifier }) => `${relative(root, file)} -> ${specifier}`).join("\n"));
  const forbiddenClientSpecifier = ["@getpaseo", "client"].join("/");
  assert.equal(references.some(({ specifier }) => specifier === forbiddenClientSpecifier), false);

  const boundaryProblems = references.map(runtimeBoundaryProblem).filter((problem): problem is string => problem !== null);
  assert.deepEqual(boundaryProblems, [], boundaryProblems.join("\n"));
});
