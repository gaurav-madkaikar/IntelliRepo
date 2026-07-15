import type { SourceLanguage } from "@intellirepo/domain";

import type { ProjectDetection, SourceArtifactInput } from "../interfaces/extraction.js";

const languageByExtension: Readonly<Record<string, SourceLanguage>> = {
  ".java": "java",
  ".js": "typescript",
  ".jsx": "typescript",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".ts": "typescript",
  ".tsx": "typescript",
};

function extension(path: string): string {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index).toLowerCase();
}

function packageDependencies(artifacts: readonly SourceArtifactInput[]): ReadonlySet<string> {
  const packageJson = artifacts.find(({ path }) => path === "package.json");
  if (packageJson === undefined) {
    return new Set();
  }

  try {
    const value = JSON.parse(packageJson.content) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    return new Set([
      ...Object.keys(value.dependencies ?? {}),
      ...Object.keys(value.devDependencies ?? {}),
    ]);
  } catch {
    return new Set();
  }
}

function jvmFrameworks(artifacts: readonly SourceArtifactInput[]): readonly string[] {
  const manifests = artifacts
    .filter(({ path }) => /(^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?)$/u.test(path))
    .map(({ content }) => content)
    .join("\n");
  return [
    ...(/org\.springframework|spring-boot/u.test(manifests) ? ["spring-boot"] : []),
    ...(/\bio\.ktor\b/u.test(manifests) ? ["ktor"] : []),
    ...(/\bio\.vertx\b/u.test(manifests) ? ["vertx"] : []),
  ];
}

function sourceRoots(artifacts: readonly SourceArtifactInput[]): readonly string[] {
  const roots = artifacts.flatMap(({ artifactKind, path }) => {
    if (artifactKind !== "code" && artifactKind !== "test") return [];
    const jvm = /^(.*?src\/(?:main|test)\/(?:java|kotlin))(?:\/|$)/u.exec(path)?.[1];
    if (jvm !== undefined) return [jvm];
    const node = /^(.*?src)(?:\/|$)/u.exec(path)?.[1];
    return node === undefined ? [] : [node];
  });
  return [...new Set(roots)].sort();
}

export function inferArtifactLanguage(artifact: SourceArtifactInput): SourceLanguage | undefined {
  return artifact.language ?? languageByExtension[extension(artifact.path)];
}

export function detectProject(artifacts: readonly SourceArtifactInput[]): ProjectDetection {
  const languages = new Set<SourceLanguage>();
  for (const artifact of artifacts) {
    if (artifact.artifactKind !== "code" && artifact.artifactKind !== "test") continue;
    const language = inferArtifactLanguage(artifact);
    if (language !== undefined && language !== "unknown") {
      languages.add(language);
    }
  }

  const dependencies = packageDependencies(artifacts);
  const frameworks = [
    ...jvmFrameworks(artifacts),
    ...(dependencies.has("@nestjs/core") ? ["nestjs"] : []),
    ...(dependencies.has("express") ? ["express"] : []),
  ];
  const configPaths = artifacts
    .map(({ path }) => path)
    .filter((path) =>
      /(^|\/)(?:\.env\.example|application\.(?:properties|ya?ml)|bootstrap\.ya?ml|pom\.xml|(?:build|settings)\.gradle(?:\.kts)?|package\.json|tsconfig(?:\.[^/]+)?\.json)$/u.test(
        path,
      ),
    )
    .sort();

  return Object.freeze({
    configPaths: Object.freeze(configPaths.sort()),
    frameworks: Object.freeze([...new Set(frameworks)].sort()),
    languages: Object.freeze([...languages].sort()),
    sourceRoots: Object.freeze(sourceRoots(artifacts)),
  });
}
