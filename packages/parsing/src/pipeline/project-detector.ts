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

export function inferArtifactLanguage(artifact: SourceArtifactInput): SourceLanguage | undefined {
  return artifact.language ?? languageByExtension[extension(artifact.path)];
}

export function detectProject(artifacts: readonly SourceArtifactInput[]): ProjectDetection {
  const languages = new Set<SourceLanguage>();
  for (const artifact of artifacts) {
    const language = inferArtifactLanguage(artifact);
    if (language !== undefined && language !== "unknown") {
      languages.add(language);
    }
  }

  const dependencies = packageDependencies(artifacts);
  const frameworks = [
    ...(dependencies.has("@nestjs/core") ? ["nestjs"] : []),
    ...(dependencies.has("express") ? ["express"] : []),
  ];
  const configPaths = artifacts
    .map(({ path }) => path)
    .filter((path) => /(^|\/)tsconfig(?:\.[^/]+)?\.json$/u.test(path));

  return Object.freeze({
    configPaths: Object.freeze(configPaths.sort()),
    frameworks: Object.freeze(frameworks),
    languages: Object.freeze([...languages].sort()),
  });
}
