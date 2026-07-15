import ts from "typescript";

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
  wholeArtifactRange,
  type MetadataFactContext,
} from "../../metadata/fact-factory.js";

function packageManager(context: ArtifactExtractorContext, declared?: string): "npm" | "pnpm" {
  if (
    declared?.startsWith("pnpm@") ||
    context.artifacts.some(({ path }) => path === "pnpm-lock.yaml")
  ) {
    return "pnpm";
  }
  return "npm";
}

function emptyResult(
  artifact: SourceArtifactInput,
  diagnostics: readonly ExtractionDiagnostic[],
): ArtifactExtractionResult {
  return Object.freeze({
    artifactPath: artifact.path,
    diagnostics: Object.freeze([...diagnostics]),
    entities: Object.freeze([]),
    mode: "semantic" as const,
    relationships: Object.freeze([]),
    unresolvedReferences: Object.freeze([]),
  });
}

export class NodeManifestExtractor implements ArtifactExtractor {
  public readonly id = "node-manifest";

  public supports(artifact: SourceArtifactInput): boolean {
    return (
      artifact.artifactKind === "build" &&
      (/(^|\/)package\.json$/u.test(artifact.path) ||
        /(^|\/)tsconfig(?:\.[^/]+)?\.json$/u.test(artifact.path))
    );
  }

  public async extract(
    artifact: SourceArtifactInput,
    extraction: ArtifactExtractorContext,
  ): Promise<ArtifactExtractionResult> {
    return /(^|\/)package\.json$/u.test(artifact.path)
      ? this.extractPackageJson(artifact, extraction)
      : this.extractTsconfig(artifact, extraction);
  }

  private extractPackageJson(
    artifact: SourceArtifactInput,
    extraction: ArtifactExtractorContext,
  ): ArtifactExtractionResult {
    let value: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      name?: string;
      packageManager?: string;
      scripts?: Record<string, string>;
    };
    try {
      value = JSON.parse(artifact.content) as typeof value;
    } catch (error) {
      return emptyResult(artifact, [
        createDiagnostic({
          artifactPath: artifact.path,
          code: "PACKAGE_JSON_INVALID",
          message: error instanceof Error ? error.message : "Invalid package.json",
          severity: "error",
        }),
      ]);
    }

    const context: MetadataFactContext = {
      artifactPath: artifact.path,
      extractor: this.id,
      language: "typescript",
      repositoryId: extraction.repositoryId,
      revisionId: extraction.revisionId,
    };
    const range = wholeArtifactRange(artifact.content);
    const entities: EntityFact[] = [];
    const relationships: RelationshipFact[] = [];
    const name = value.name?.trim() || artifact.path;
    const manager = packageManager(extraction, value.packageManager);
    const module = makeMetadataEntityFact(context, {
      attributes: { path: artifact.path },
      evidence: "package.json",
      kind: "module",
      level: "confirmed",
      name,
      qualifiedName: `${artifact.path}#package:${name}`,
      range,
      reason: "Static Node package manifest",
      score: 1,
    });
    const commands = ["start", "build", "test"].flatMap((script) =>
      value.scripts?.[script] === undefined ? [] : [`${manager} run ${script}`],
    );
    const build = makeMetadataEntityFact(context, {
      attributes: { buildTool: manager, commands },
      evidence: "scripts",
      kind: "build_script",
      level: "confirmed",
      name: artifact.path,
      qualifiedName: `${artifact.path}#scripts`,
      range,
      reason: "Static package.json scripts",
      score: 1,
    });
    entities.push(module, build);
    relationships.push(
      makeMetadataRelationshipFact(context, {
        attributes: {},
        evidence: "scripts",
        kind: "DECLARES",
        level: "confirmed",
        range,
        reason: "Static package.json scripts",
        score: 1,
        source: module.stableKey,
        target: build.stableKey,
      }),
    );

    for (const [scope, dependencies] of [
      ["runtime", value.dependencies],
      ["development", value.devDependencies],
    ] as const) {
      for (const [dependencyName, version] of Object.entries(dependencies ?? {}).sort(
        ([left], [right]) => left.localeCompare(right),
      )) {
        const coordinate = `${dependencyName}@${version}`;
        const dependency = makeMetadataEntityFact(context, {
          attributes: { coordinate, scope },
          evidence: scope === "runtime" ? "dependencies" : "devDependencies",
          kind: "dependency",
          level: "confirmed",
          name: dependencyName,
          qualifiedName: `${artifact.path}#dependency:${coordinate}:${scope}`,
          range,
          reason: "Static package.json dependency",
          score: 1,
        });
        entities.push(dependency);
        relationships.push(
          makeMetadataRelationshipFact(context, {
            attributes: { scope },
            evidence: scope === "runtime" ? "dependencies" : "devDependencies",
            kind: "DEPENDS_ON",
            level: "confirmed",
            range,
            reason: "Static package.json dependency",
            score: 1,
            source: build.stableKey,
            target: dependency.stableKey,
          }),
        );
      }
    }

    return Object.freeze({
      artifactPath: artifact.path,
      diagnostics: Object.freeze([]),
      entities: Object.freeze(entities),
      mode: "semantic" as const,
      relationships: Object.freeze(relationships),
      unresolvedReferences: Object.freeze([]),
    });
  }

  private extractTsconfig(
    artifact: SourceArtifactInput,
    extraction: ArtifactExtractorContext,
  ): ArtifactExtractionResult {
    const parsed = ts.parseConfigFileTextToJson(artifact.path, artifact.content);
    if (parsed.error !== undefined) {
      return emptyResult(artifact, [
        createDiagnostic({
          artifactPath: artifact.path,
          code: `TSCONFIG_${parsed.error.code}`,
          message: ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"),
          severity: "error",
        }),
      ]);
    }
    const value = parsed.config as {
      exclude?: unknown;
      include?: unknown;
      references?: readonly { path?: unknown }[];
    };
    const context: MetadataFactContext = {
      artifactPath: artifact.path,
      extractor: this.id,
      language: "typescript",
      repositoryId: extraction.repositoryId,
      revisionId: extraction.revisionId,
    };
    const range = wholeArtifactRange(artifact.content);
    const entities: EntityFact[] = [];
    const relationships: RelationshipFact[] = [];
    const module = makeMetadataEntityFact(context, {
      attributes: { path: artifact.path },
      evidence: "tsconfig",
      kind: "module",
      level: "confirmed",
      name: artifact.path,
      qualifiedName: `${artifact.path}#typescript-project`,
      range,
      reason: "Static TypeScript project configuration",
      score: 1,
    });
    entities.push(module);
    for (const reference of value.references ?? []) {
      if (typeof reference.path !== "string") continue;
      const dependency = makeMetadataEntityFact(context, {
        attributes: { coordinate: `tsconfig:${reference.path}`, scope: "project-reference" },
        evidence: "references",
        kind: "dependency",
        level: "confirmed",
        name: reference.path,
        qualifiedName: `${artifact.path}#reference:${reference.path}`,
        range,
        reason: "Static TypeScript project reference",
        score: 1,
      });
      entities.push(dependency);
      relationships.push(
        makeMetadataRelationshipFact(context, {
          attributes: { scope: "project-reference" },
          evidence: "references",
          kind: "DEPENDS_ON",
          level: "confirmed",
          range,
          reason: "Static TypeScript project reference",
          score: 1,
          source: module.stableKey,
          target: dependency.stableKey,
        }),
      );
    }
    for (const [key, raw] of [
      ["typescript.include", value.include],
      ["typescript.exclude", value.exclude],
    ] as const) {
      if (raw === undefined) continue;
      const config = makeMetadataEntityFact(context, {
        attributes: { defaultValue: JSON.stringify(raw), key },
        evidence: key,
        kind: "configuration_key",
        level: "confirmed",
        name: key,
        qualifiedName: `${artifact.path}#config:${key}`,
        range,
        reason: "Static TypeScript source layout",
        score: 1,
      });
      entities.push(config);
      relationships.push(
        makeMetadataRelationshipFact(context, {
          attributes: {},
          evidence: key,
          kind: "DECLARES",
          level: "confirmed",
          range,
          reason: "Static TypeScript source layout",
          score: 1,
          source: module.stableKey,
          target: config.stableKey,
        }),
      );
    }
    return Object.freeze({
      artifactPath: artifact.path,
      diagnostics: Object.freeze([]),
      entities: Object.freeze(entities),
      mode: "semantic" as const,
      relationships: Object.freeze(relationships),
      unresolvedReferences: Object.freeze([]),
    });
  }
}
