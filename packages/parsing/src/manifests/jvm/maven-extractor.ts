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

function tagValue(content: string, tag: string): string | undefined {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]+)</${tag}>`, "u").exec(content)?.[1]?.trim();
}

function blocks(
  content: string,
  tag: string,
): readonly { end: number; start: number; text: string }[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "gu");
  return [...content.matchAll(pattern)].flatMap((match) =>
    match.index === undefined
      ? []
      : [{ end: match.index + match[0].length, start: match.index, text: match[0] }],
  );
}

function commands(
  artifact: SourceArtifactInput,
  context: ArtifactExtractorContext,
): readonly string[] {
  const executable = context.artifacts.some(({ path }) => /(^|\/)mvnw$/u.test(path))
    ? "./mvnw"
    : "mvn";
  const values = [`${executable} clean package`, `${executable} test`];
  if (/spring-boot-maven-plugin/u.test(artifact.content))
    values.push(`${executable} spring-boot:run`);
  return values;
}

function addRelationship(
  relationships: RelationshipFact[],
  context: MetadataFactContext,
  source: EntityFact,
  target: EntityFact,
  range: ReturnType<typeof wholeArtifactRange>,
  kind: "DECLARES" | "DEPENDS_ON",
  scope?: string,
): void {
  relationships.push(
    makeMetadataRelationshipFact(context, {
      attributes: kind === "DEPENDS_ON" && scope !== undefined ? { scope } : {},
      evidence: kind === "DEPENDS_ON" ? "dependency" : "project",
      kind,
      level: "confirmed",
      range,
      reason: `Static Maven ${kind === "DEPENDS_ON" ? "dependency" : "declaration"}`,
      score: 1,
      source: source.stableKey,
      target: target.stableKey,
    }),
  );
}

export class MavenExtractor implements ArtifactExtractor {
  public readonly id = "maven-manifest";

  public supports(artifact: SourceArtifactInput): boolean {
    return artifact.artifactKind === "build" && /(^|\/)pom\.xml$/u.test(artifact.path);
  }

  public async extract(
    artifact: SourceArtifactInput,
    extraction: ArtifactExtractorContext,
  ): Promise<ArtifactExtractionResult> {
    const context: MetadataFactContext = {
      artifactPath: artifact.path,
      extractor: this.id,
      language: "java",
      repositoryId: extraction.repositoryId,
      revisionId: extraction.revisionId,
    };
    const entities: EntityFact[] = [];
    const relationships: RelationshipFact[] = [];
    const diagnostics: ExtractionDiagnostic[] = [];
    const artifactRange = wholeArtifactRange(artifact.content);
    if (!/<project(?:\s|>)/u.test(artifact.content) || !/<\/project>/u.test(artifact.content)) {
      diagnostics.push(
        createDiagnostic({
          artifactPath: artifact.path,
          code: "MAVEN_INVALID_XML",
          message: "Maven manifest does not contain a complete project element",
          range: artifactRange,
          severity: "error",
        }),
      );
    }
    const artifactId =
      tagValue(artifact.content.split("<dependencies", 1)[0] ?? artifact.content, "artifactId") ??
      artifact.path;
    const module = makeMetadataEntityFact(context, {
      attributes: { path: artifact.path },
      evidence: "project",
      kind: "module",
      level: "confirmed",
      name: artifactId,
      qualifiedName: `${artifact.path}#project:${artifactId}`,
      range: artifactRange,
      reason: "Static Maven project",
      score: 1,
    });
    const build = makeMetadataEntityFact(context, {
      attributes: { buildTool: "maven", commands: commands(artifact, extraction) },
      evidence: "project",
      kind: "build_script",
      level: "confirmed",
      name: artifact.path,
      qualifiedName: `${artifact.path}#build`,
      range: artifactRange,
      reason: "Maven build manifest",
      score: 1,
    });
    entities.push(module, build);
    addRelationship(relationships, context, module, build, artifactRange, "DECLARES");

    for (const block of blocks(artifact.content, "dependency")) {
      const group = tagValue(block.text, "groupId");
      const name = tagValue(block.text, "artifactId");
      if (group === undefined || name === undefined) continue;
      const version = tagValue(block.text, "version");
      const scope = tagValue(block.text, "scope") ?? "compile";
      const coordinate = `${group}:${name}${version === undefined ? "" : `:${version}`}`;
      const range = rangeForOffsets(artifact.content, block.start, block.end);
      const dependency = makeMetadataEntityFact(context, {
        attributes: { coordinate, scope },
        evidence: "dependency",
        kind: "dependency",
        level: "confirmed",
        name,
        qualifiedName: `${artifact.path}#dependency:${coordinate}:${scope}`,
        range,
        reason: "Static Maven dependency",
        score: 1,
      });
      entities.push(dependency);
      addRelationship(relationships, context, build, dependency, range, "DEPENDS_ON", scope);
    }

    for (const block of blocks(artifact.content, "plugin")) {
      const name = tagValue(block.text, "artifactId");
      if (name === undefined) continue;
      const group = tagValue(block.text, "groupId") ?? "org.apache.maven.plugins";
      const version = tagValue(block.text, "version");
      const coordinate = `${group}:${name}${version === undefined ? "" : `:${version}`}`;
      const range = rangeForOffsets(artifact.content, block.start, block.end);
      const plugin = makeMetadataEntityFact(context, {
        attributes: { coordinate, scope: "plugin" },
        evidence: "plugin",
        kind: "dependency",
        level: "confirmed",
        name,
        qualifiedName: `${artifact.path}#plugin:${coordinate}`,
        range,
        reason: "Static Maven plugin",
        score: 1,
      });
      entities.push(plugin);
      addRelationship(relationships, context, build, plugin, range, "DEPENDS_ON", "plugin");
    }

    for (const block of blocks(artifact.content, "module")) {
      const name = block.text
        .replace(/^<module>/u, "")
        .replace(/<\/module>$/u, "")
        .trim();
      if (name.length === 0) continue;
      const child = makeMetadataEntityFact(context, {
        attributes: { path: name },
        evidence: "module",
        kind: "module",
        level: "confirmed",
        name,
        qualifiedName: `${artifact.path}#module:${name}`,
        range: rangeForOffsets(artifact.content, block.start, block.end),
        reason: "Static Maven module",
        score: 1,
      });
      entities.push(child);
      addRelationship(
        relationships,
        context,
        module,
        child,
        rangeForOffsets(artifact.content, block.start, block.end),
        "DECLARES",
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
