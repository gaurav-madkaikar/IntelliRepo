import type { EntityFact, RelationshipFact } from "@intellirepo/domain";

import { createDiagnostic, type ExtractionDiagnostic } from "../../diagnostics/diagnostic.js";
import type {
  ArtifactExtractor,
  ArtifactExtractorContext,
} from "../../interfaces/artifact-extractor.js";
import type { ArtifactExtractionResult, SourceArtifactInput } from "../../interfaces/extraction.js";
import {
  makeMetadataEntityFact,
  makeMetadataRelationshipFact,
  rangeForOffsets,
  wholeArtifactRange,
  type MetadataFactContext,
} from "../../metadata/fact-factory.js";

function wrapper(context: ArtifactExtractorContext): string {
  return context.artifacts.some(({ path }) => /(^|\/)gradlew$/u.test(path))
    ? "./gradlew"
    : "gradle";
}

function commandFacts(content: string, context: ArtifactExtractorContext): readonly string[] {
  const executable = wrapper(context);
  const commands = [`${executable} build`, `${executable} test`];
  if (/org\.springframework\.boot|bootRun/u.test(content)) commands.push(`${executable} bootRun`);
  if (/application/u.test(content)) commands.push(`${executable} run`);
  return [...new Set(commands)];
}

function dependencyMatches(content: string) {
  const pattern =
    /\b(api|compileOnly|implementation|kapt|ksp|runtimeOnly|testImplementation|testRuntimeOnly)\s*(?:\(\s*)?["']([^"']+)["']\s*\)?/gu;
  return [...content.matchAll(pattern)].flatMap((match) =>
    match.index === undefined || match[1] === undefined || match[2] === undefined
      ? []
      : [
          {
            coordinate: match[2],
            end: match.index + match[0].length,
            scope: match[1],
            start: match.index,
          },
        ],
  );
}

function pluginMatches(content: string) {
  const pattern =
    /\bid\s*(?:\(\s*)?["']([^"']+)["']\s*\)?(?:\s+version\s*(?:\(\s*)?["']([^"']+)["']\s*\)?)?/gu;
  return [...content.matchAll(pattern)].flatMap((match) =>
    match.index === undefined || match[1] === undefined
      ? []
      : [
          {
            coordinate: `plugin:${match[1]}${match[2] === undefined ? "" : `:${match[2]}`}`,
            end: match.index + match[0].length,
            name: match[1],
            start: match.index,
          },
        ],
  );
}

export class GradleExtractor implements ArtifactExtractor {
  public readonly id = "gradle-manifest";

  public supports(artifact: SourceArtifactInput): boolean {
    return (
      artifact.artifactKind === "build" &&
      /(^|\/)(?:build|settings)\.gradle(?:\.kts)?$/u.test(artifact.path)
    );
  }

  public async extract(
    artifact: SourceArtifactInput,
    extraction: ArtifactExtractorContext,
  ): Promise<ArtifactExtractionResult> {
    const context: MetadataFactContext = {
      artifactPath: artifact.path,
      extractor: this.id,
      language: artifact.path.endsWith(".kts") ? "kotlin" : "java",
      repositoryId: extraction.repositoryId,
      revisionId: extraction.revisionId,
    };
    const entities: EntityFact[] = [];
    const relationships: RelationshipFact[] = [];
    const diagnostics: ExtractionDiagnostic[] = [];
    const range = wholeArtifactRange(artifact.content);
    const rootName = /rootProject\.name\s*=\s*["']([^"']+)["']/u.exec(artifact.content)?.[1];
    const module = makeMetadataEntityFact(context, {
      attributes: { path: artifact.path },
      evidence: "gradle-file",
      kind: "module",
      level: "confirmed",
      name: rootName ?? artifact.path,
      qualifiedName: `${artifact.path}#project:${rootName ?? artifact.path}`,
      range,
      reason: "Static Gradle project",
      score: 1,
    });
    const build = makeMetadataEntityFact(context, {
      attributes: { buildTool: "gradle", commands: commandFacts(artifact.content, extraction) },
      evidence: "gradle-file",
      kind: "build_script",
      level: "confirmed",
      name: artifact.path,
      qualifiedName: `${artifact.path}#build`,
      range,
      reason: "Gradle build manifest",
      score: 1,
    });
    entities.push(module, build);
    relationships.push(
      makeMetadataRelationshipFact(context, {
        attributes: {},
        evidence: "gradle-file",
        kind: "DECLARES",
        level: "confirmed",
        range,
        reason: "Static Gradle declaration",
        score: 1,
        source: module.stableKey,
        target: build.stableKey,
      }),
    );

    for (const dependency of dependencyMatches(artifact.content)) {
      const dependencyRange = rangeForOffsets(artifact.content, dependency.start, dependency.end);
      const name = dependency.coordinate.split(":")[1] ?? dependency.coordinate;
      const entity = makeMetadataEntityFact(context, {
        attributes: { coordinate: dependency.coordinate, scope: dependency.scope },
        evidence: "dependency-declaration",
        kind: "dependency",
        level: "confirmed",
        name,
        qualifiedName: `${artifact.path}#dependency:${dependency.coordinate}:${dependency.scope}`,
        range: dependencyRange,
        reason: "Static Gradle dependency",
        score: 1,
      });
      entities.push(entity);
      relationships.push(
        makeMetadataRelationshipFact(context, {
          attributes: { scope: dependency.scope },
          evidence: "dependency-declaration",
          kind: "DEPENDS_ON",
          level: "confirmed",
          range: dependencyRange,
          reason: "Static Gradle dependency",
          score: 1,
          source: build.stableKey,
          target: entity.stableKey,
        }),
      );
    }

    for (const plugin of pluginMatches(artifact.content)) {
      const pluginRange = rangeForOffsets(artifact.content, plugin.start, plugin.end);
      const entity = makeMetadataEntityFact(context, {
        attributes: { coordinate: plugin.coordinate, scope: "plugin" },
        evidence: "plugin-declaration",
        kind: "dependency",
        level: "confirmed",
        name: plugin.name,
        qualifiedName: `${artifact.path}#${plugin.coordinate}`,
        range: pluginRange,
        reason: "Static Gradle plugin",
        score: 1,
      });
      entities.push(entity);
      relationships.push(
        makeMetadataRelationshipFact(context, {
          attributes: { scope: "plugin" },
          evidence: "plugin-declaration",
          kind: "DEPENDS_ON",
          level: "confirmed",
          range: pluginRange,
          reason: "Static Gradle plugin",
          score: 1,
          source: build.stableKey,
          target: entity.stableKey,
        }),
      );
    }

    const dependencyLines =
      artifact.content.match(/^\s*(?:api|implementation|runtimeOnly|testImplementation)\b.*$/gmu) ??
      [];
    for (const line of dependencyLines) {
      if (/["'][^"']+:[^"']+["']/u.test(line)) continue;
      const start = artifact.content.indexOf(line);
      diagnostics.push(
        createDiagnostic({
          artifactPath: artifact.path,
          code: "GRADLE_UNSUPPORTED_EXPRESSION",
          message: "Dynamic Gradle dependency expression was not evaluated",
          range: rangeForOffsets(artifact.content, start, start + line.length),
          severity: "information",
        }),
      );
    }

    return Object.freeze({
      artifactPath: artifact.path,
      diagnostics: Object.freeze(diagnostics),
      entities: Object.freeze(entities),
      mode: "semantic" as const,
      relationships: Object.freeze(relationships),
      unresolvedReferences: Object.freeze([]),
    });
  }
}
