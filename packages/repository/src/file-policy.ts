import { extname, posix } from "node:path";

export type ArtifactKind = "build" | "code" | "configuration" | "documentation" | "test";

export interface FilePolicyInput {
  readonly contentPrefix?: Uint8Array;
  readonly path: string;
  readonly sizeBytes: number;
}

export type FilePolicyDecision =
  | Readonly<{
      artifactKind: ArtifactKind;
      language?: "java" | "kotlin" | "typescript";
      normalizedPath: string;
      supported: true;
    }>
  | Readonly<{
      normalizedPath: string;
      reason: "binary" | "environment-secret" | "generated" | "oversized" | "unsupported";
      supported: false;
    }>;

const generatedSegments = new Set([
  ".gradle",
  ".idea",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "target",
]);
const buildFileNames = new Set([
  "build.gradle",
  "build.gradle.kts",
  "package.json",
  "pnpm-lock.yaml",
  "pom.xml",
  "settings.gradle",
  "settings.gradle.kts",
  "tsconfig.json",
  "yarn.lock",
]);
const configurationFileNames = new Set([
  ".env.example",
  "application.properties",
  "application.yaml",
  "application.yml",
  "bootstrap.yaml",
  "bootstrap.yml",
]);

function normalizePath(path: string): string {
  return posix.normalize(path.trim().replaceAll("\\", "/")).replace(/^\.\//, "");
}

function isBinary(contentPrefix: Uint8Array | undefined): boolean {
  return contentPrefix?.includes(0) ?? false;
}

function isTestPath(path: string): boolean {
  const lowerPath = path.toLowerCase();
  return (
    lowerPath.includes("/test/") ||
    lowerPath.includes("/tests/") ||
    lowerPath.includes("/__tests__/") ||
    /(?:\.|-)(?:spec|test)\.[^.]+$/u.test(lowerPath)
  );
}

export class FilePolicy {
  public constructor(private readonly maxFileBytes: number) {
    if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1) {
      throw new Error("maxFileBytes must be a positive integer");
    }
  }

  public evaluate(input: FilePolicyInput): FilePolicyDecision {
    const normalizedPath = normalizePath(input.path);
    const segments = normalizedPath.split("/");
    const fileName = segments.at(-1)?.toLowerCase() ?? "";
    const extension = extname(fileName);

    if (segments.some((segment) => generatedSegments.has(segment))) {
      return { normalizedPath, reason: "generated", supported: false };
    }
    if (fileName.startsWith(".env") && fileName !== ".env.example") {
      return { normalizedPath, reason: "environment-secret", supported: false };
    }
    if (input.sizeBytes > this.maxFileBytes) {
      return { normalizedPath, reason: "oversized", supported: false };
    }
    if (isBinary(input.contentPrefix)) {
      return { normalizedPath, reason: "binary", supported: false };
    }
    if (buildFileNames.has(fileName)) {
      return { artifactKind: "build", normalizedPath, supported: true };
    }
    if (configurationFileNames.has(fileName) || extension === ".properties") {
      return { artifactKind: "configuration", normalizedPath, supported: true };
    }
    if (extension === ".md" || extension === ".mdx") {
      return { artifactKind: "documentation", normalizedPath, supported: true };
    }

    const language =
      extension === ".java"
        ? "java"
        : extension === ".kt" || extension === ".kts"
          ? "kotlin"
          : extension === ".ts" || extension === ".tsx"
            ? "typescript"
            : undefined;

    if (language !== undefined) {
      return {
        artifactKind: isTestPath(normalizedPath) ? "test" : "code",
        language,
        normalizedPath,
        supported: true,
      };
    }

    return { normalizedPath, reason: "unsupported", supported: false };
  }
}
