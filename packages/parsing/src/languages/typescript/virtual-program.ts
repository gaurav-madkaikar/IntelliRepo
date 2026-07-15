import { posix } from "node:path";

import ts from "typescript";

import type { SourceArtifactInput } from "../../interfaces/extraction.js";

const VIRTUAL_ROOT = "/__intellirepo__";

export class ProjectConfigurationError extends Error {
  public override readonly name = "ProjectConfigurationError";
}

export interface VirtualTypeScriptProgram {
  readonly artifactPathByFileName: ReadonlyMap<string, string>;
  readonly checker: ts.TypeChecker;
  readonly fileNameByArtifactPath: ReadonlyMap<string, string>;
  readonly program: ts.Program;
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

function compilerOptions(artifacts: readonly SourceArtifactInput[]): ts.CompilerOptions {
  const base: ts.CompilerOptions = {
    allowJs: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2023,
  };
  const config = artifacts.find(({ path }) => /(^|\/)tsconfig(?:\.[^/]+)?\.json$/u.test(path));
  if (config === undefined) {
    return base;
  }

  const parsed = ts.parseConfigFileTextToJson(config.path, config.content);
  if (parsed.error !== undefined) {
    throw new ProjectConfigurationError(formatDiagnostic(parsed.error));
  }
  const converted = ts.convertCompilerOptionsFromJson(
    (parsed.config as { compilerOptions?: Record<string, unknown> }).compilerOptions ?? {},
    VIRTUAL_ROOT,
    config.path,
  );
  if (converted.errors.length > 0) {
    throw new ProjectConfigurationError(converted.errors.map(formatDiagnostic).join("; "));
  }
  return { ...base, ...converted.options, noEmit: true };
}

function virtualFileName(artifactPath: string): string {
  return posix.join(VIRTUAL_ROOT, artifactPath.replaceAll("\\", "/"));
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (fileName.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function createVirtualTypeScriptProgram(
  artifacts: readonly SourceArtifactInput[],
): VirtualTypeScriptProgram {
  const sourceArtifacts = artifacts.filter(({ path }) => /\.[cm]?[jt]sx?$/u.test(path));
  const contents = new Map(
    sourceArtifacts.map((artifact) => [virtualFileName(artifact.path), artifact.content]),
  );
  const artifactPathByFileName = new Map(
    sourceArtifacts.map((artifact) => [virtualFileName(artifact.path), artifact.path]),
  );
  const fileNameByArtifactPath = new Map(
    [...artifactPathByFileName].map(([fileName, artifactPath]) => [artifactPath, fileName]),
  );
  const options = compilerOptions(artifacts);
  const defaultHost = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists: (fileName) => contents.has(fileName) || defaultHost.fileExists(fileName),
    getCurrentDirectory: () => VIRTUAL_ROOT,
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const content = contents.get(fileName);
      return content === undefined
        ? defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
        : ts.createSourceFile(fileName, content, languageVersion, true, scriptKind(fileName));
    },
    readFile: (fileName) => contents.get(fileName) ?? defaultHost.readFile(fileName),
    writeFile: () => undefined,
  };
  const program = ts.createProgram({
    host,
    options,
    rootNames: [...contents.keys()],
  });

  return {
    artifactPathByFileName,
    checker: program.getTypeChecker(),
    fileNameByArtifactPath,
    program,
  };
}
