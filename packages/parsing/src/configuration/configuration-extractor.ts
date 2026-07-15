import type { EntityFact, RelationshipFact, SourceRange } from "@intellirepo/domain";

import { createDiagnostic, type ExtractionDiagnostic } from "../diagnostics/diagnostic.js";
import type {
  ArtifactExtractor,
  ArtifactExtractorContext,
} from "../interfaces/artifact-extractor.js";
import type { ArtifactExtractionResult, SourceArtifactInput } from "../interfaces/extraction.js";
import {
  makeMetadataEntityFact,
  makeMetadataRelationshipFact,
  rangeForOffsets,
  wholeArtifactRange,
  type MetadataFactContext,
} from "../metadata/fact-factory.js";

interface ConfigurationDefinition {
  readonly key: string;
  readonly range: SourceRange;
  readonly value?: string;
}

const SECRET_KEY =
  /(?:^|[._-])(?:api[-_.]?key|credential|password|private[-_.]?key|secret|token)(?:$|[._-])/iu;

function safeValue(key: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return SECRET_KEY.test(key) ? "[REDACTED]" : value;
}

function lineRecords(content: string) {
  let offset = 0;
  return content.split(/\n/u).map((text) => {
    const start = offset;
    offset += text.length + 1;
    return { end: start + Math.max(1, text.length), start, text };
  });
}

function propertiesDefinitions(
  artifact: SourceArtifactInput,
  diagnostics: ExtractionDiagnostic[],
): readonly ConfigurationDefinition[] {
  return lineRecords(artifact.content).flatMap((line) => {
    const trimmed = line.text.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("!")) return [];
    const match = /^([^:=\s]+)\s*[:=]\s*(.*)$/u.exec(trimmed);
    if (match?.[1] === undefined) {
      diagnostics.push(
        createDiagnostic({
          artifactPath: artifact.path,
          code: "PROPERTIES_UNSUPPORTED_EXPRESSION",
          message: "Properties line could not be interpreted as a static key/value mapping",
          range: rangeForOffsets(artifact.content, line.start, line.end),
          severity: "information",
        }),
      );
      return [];
    }
    const value = safeValue(match[1], match[2]?.trim());
    return [
      {
        key: match[1],
        range: rangeForOffsets(artifact.content, line.start, line.end),
        ...(value === undefined ? {} : { value }),
      },
    ];
  });
}

function environmentDefinitions(content: string): readonly ConfigurationDefinition[] {
  return lineRecords(content).flatMap((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:=.*)?$/u.exec(line.text);
    return match?.[1] === undefined
      ? []
      : [{ key: match[1], range: rangeForOffsets(content, line.start, line.end) }];
  });
}

function yamlDefinitions(
  artifact: SourceArtifactInput,
  diagnostics: ExtractionDiagnostic[],
): readonly ConfigurationDefinition[] {
  const stack: { indent: number; key: string }[] = [];
  const definitions: ConfigurationDefinition[] = [];
  for (const line of lineRecords(artifact.content)) {
    if (/^\s*(?:#.*)?$/u.test(line.text)) continue;
    if (/^\s*-/u.test(line.text)) {
      diagnostics.push(
        createDiagnostic({
          artifactPath: artifact.path,
          code: "YAML_UNSUPPORTED_SEQUENCE",
          message: "YAML sequences are not flattened into configuration facts",
          range: rangeForOffsets(artifact.content, line.start, line.end),
          severity: "information",
        }),
      );
      continue;
    }
    const match = /^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*(?:#.*)?$/u.exec(line.text);
    if (match?.[2] === undefined) {
      diagnostics.push(
        createDiagnostic({
          artifactPath: artifact.path,
          code: "YAML_UNSUPPORTED_EXPRESSION",
          message: "YAML line could not be interpreted as a static mapping",
          range: rangeForOffsets(artifact.content, line.start, line.end),
          severity: "information",
        }),
      );
      continue;
    }
    const indent = match[1]?.length ?? 0;
    while ((stack.at(-1)?.indent ?? -1) >= indent) stack.pop();
    const key = [...stack.map(({ key: parent }) => parent), match[2]].join(".");
    const raw = match[3]?.trim() ?? "";
    if (raw.length === 0) {
      stack.push({ indent, key: match[2] });
      continue;
    }
    if (raw === "|" || raw === ">" || raw.startsWith("&") || raw.startsWith("*")) {
      diagnostics.push(
        createDiagnostic({
          artifactPath: artifact.path,
          code: "YAML_UNSUPPORTED_EXPRESSION",
          message: "YAML block, anchor, or alias was not evaluated",
          range: rangeForOffsets(artifact.content, line.start, line.end),
          severity: "information",
        }),
      );
      continue;
    }
    const value = raw.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, "$1$2");
    const safe = safeValue(key, value);
    definitions.push({
      key,
      range: rangeForOffsets(artifact.content, line.start, line.end),
      ...(safe === undefined ? {} : { value: safe }),
    });
  }
  return definitions;
}

export class ConfigurationExtractor implements ArtifactExtractor {
  public readonly id = "configuration-manifest";

  public supports(artifact: SourceArtifactInput): boolean {
    return (
      artifact.artifactKind === "configuration" &&
      (/(^|\/)\.env\.example$/u.test(artifact.path) ||
        /\.(?:properties|ya?ml)$/u.test(artifact.path))
    );
  }

  public async extract(
    artifact: SourceArtifactInput,
    extraction: ArtifactExtractorContext,
  ): Promise<ArtifactExtractionResult> {
    const context: MetadataFactContext = {
      artifactPath: artifact.path,
      extractor: this.id,
      repositoryId: extraction.repositoryId,
      revisionId: extraction.revisionId,
    };
    const diagnostics: ExtractionDiagnostic[] = [];
    const isEnvironment = /(^|\/)\.env\.example$/u.test(artifact.path);
    const definitions = isEnvironment
      ? environmentDefinitions(artifact.content)
      : artifact.path.endsWith(".properties")
        ? propertiesDefinitions(artifact, diagnostics)
        : yamlDefinitions(artifact, diagnostics);
    const entities: EntityFact[] = [];
    const relationships: RelationshipFact[] = [];
    const artifactRange = wholeArtifactRange(artifact.content);
    const module = makeMetadataEntityFact(context, {
      attributes: { path: artifact.path },
      evidence: "configuration-file",
      kind: "module",
      level: "confirmed",
      name: artifact.path,
      qualifiedName: `${artifact.path}#configuration`,
      range: artifactRange,
      reason: "Configuration artifact",
      score: 1,
    });
    entities.push(module);
    const seen = new Set<string>();
    for (const definition of definitions) {
      if (seen.has(definition.key)) {
        diagnostics.push(
          createDiagnostic({
            artifactPath: artifact.path,
            code: "CONFIGURATION_DUPLICATE_KEY",
            message: `Duplicate configuration key ${definition.key} was ignored`,
            range: definition.range,
            severity: "warning",
          }),
        );
        continue;
      }
      seen.add(definition.key);
      const entity = isEnvironment
        ? makeMetadataEntityFact(context, {
            attributes: { name: definition.key },
            evidence: "environment-variable",
            kind: "environment_variable",
            level: "confirmed",
            name: definition.key,
            qualifiedName: `${artifact.path}#env:${definition.key}`,
            range: definition.range,
            reason: "Environment variable example declaration",
            score: 1,
          })
        : makeMetadataEntityFact(context, {
            attributes: {
              ...(definition.value === undefined ? {} : { defaultValue: definition.value }),
              key: definition.key,
            },
            evidence: "configuration-key",
            kind: "configuration_key",
            level: "confirmed",
            name: definition.key,
            qualifiedName: `${artifact.path}#config:${definition.key}`,
            range: definition.range,
            reason: "Static configuration key declaration",
            score: 1,
          });
      entities.push(entity);
      relationships.push(
        makeMetadataRelationshipFact(context, {
          attributes: {},
          evidence: "configuration-key",
          kind: "DECLARES",
          level: "confirmed",
          range: definition.range,
          reason: "Static configuration declaration",
          score: 1,
          source: module.stableKey,
          target: entity.stableKey,
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
