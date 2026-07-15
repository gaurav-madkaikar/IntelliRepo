import type { EntityFact, RelationshipFact } from "@intellirepo/domain";

import type { ArtifactExtractionResult, UnresolvedReference } from "../interfaces/extraction.js";
import {
  makeMetadataRelationshipFact,
  type MetadataFactContext,
} from "../metadata/fact-factory.js";

function candidatesFor(
  reference: UnresolvedReference,
  source: EntityFact,
  entities: readonly EntityFact[],
): readonly EntityFact[] {
  const differentLanguage = entities.filter(
    (entity) =>
      entity.language !== undefined &&
      source.language !== undefined &&
      entity.language !== source.language,
  );
  if (reference.kind === "import") {
    return differentLanguage.filter(({ qualifiedName }) => qualifiedName === reference.name);
  }
  if (reference.kind === "heritage") {
    return differentLanguage.filter(
      ({ kind, name, qualifiedName }) =>
        (kind === "class" || kind === "interface" || kind === "object") &&
        (name === reference.name || qualifiedName === reference.name),
    );
  }
  if (reference.kind === "call") {
    return differentLanguage.filter(
      ({ kind, name }) =>
        (kind === "constructor" || kind === "function" || kind === "method") &&
        name === reference.name,
    );
  }
  return [];
}

function relationshipKind(
  reference: UnresolvedReference,
  source: EntityFact,
  target: EntityFact,
): "CALLS" | "EXTENDS" | "IMPLEMENTS" | "IMPORTS" | "TESTS" {
  if (reference.kind === "import") return "IMPORTS";
  if (reference.kind === "call") return source.kind === "test" ? "TESTS" : "CALLS";
  if (source.kind === "interface") return "EXTENDS";
  return target.kind === "interface" ? "IMPLEMENTS" : "EXTENDS";
}

function resolvedRelationship(
  context: MetadataFactContext,
  reference: UnresolvedReference,
  source: EntityFact,
  target: EntityFact,
): RelationshipFact {
  const kind = relationshipKind(reference, source, target);
  const common = {
    evidence: reference.name,
    level: "inferred" as const,
    range: reference.range,
    reason: "Unique cross-language repository symbol matched",
    score: 0.8,
    source: source.stableKey,
    target: target.stableKey,
  };
  if (kind === "IMPORTS") {
    const importedName = reference.name.split(".").at(-1);
    return makeMetadataRelationshipFact(context, {
      ...common,
      attributes: importedName === undefined ? {} : { importedName },
      kind,
    });
  }
  if (kind === "CALLS") {
    return makeMetadataRelationshipFact(context, {
      ...common,
      attributes: { resolution: "name" },
      kind,
    });
  }
  if (kind === "TESTS") {
    return makeMetadataRelationshipFact(context, {
      ...common,
      attributes: { basis: "call" },
      kind,
    });
  }
  return makeMetadataRelationshipFact(context, { ...common, attributes: {}, kind });
}

function sameRange(
  left: { readonly start: { readonly column: number; readonly line: number } },
  right: { readonly start: { readonly column: number; readonly line: number } },
): boolean {
  return left.start.line === right.start.line && left.start.column === right.start.column;
}

export function resolveCrossLanguageReferences(
  results: readonly ArtifactExtractionResult[],
  repositoryId: string,
  revisionId: string,
): readonly ArtifactExtractionResult[] {
  const entities = results.flatMap(({ entities: values }) => values);
  const entityByKey = new Map(entities.map((entity) => [entity.stableKey, entity]));
  return results.map((result) => {
    const resolved = new Set<UnresolvedReference>();
    const relationships = [...result.relationships];
    for (const reference of result.unresolvedReferences) {
      if (reference.kind === "configuration") continue;
      const source = entityByKey.get(reference.sourceEntityKey);
      if (source === undefined) continue;
      const candidates = candidatesFor(reference, source, entities);
      if (candidates.length !== 1 || candidates[0] === undefined) continue;
      const target = candidates[0];
      const context: MetadataFactContext = {
        artifactPath: result.artifactPath,
        extractor: "cross-language-resolver",
        ...(source.language === undefined ? {} : { language: source.language }),
        repositoryId,
        revisionId,
      };
      relationships.push(resolvedRelationship(context, reference, source, target));
      resolved.add(reference);
    }
    return Object.freeze({
      ...result,
      diagnostics: Object.freeze(
        result.diagnostics.filter(
          (diagnostic) =>
            ![...resolved].some(
              (reference) =>
                diagnostic.range !== undefined &&
                sameRange(diagnostic.range, reference.range) &&
                diagnostic.message.startsWith(reference.name),
            ),
        ),
      ),
      relationships: Object.freeze(relationships),
      unresolvedReferences: Object.freeze(
        result.unresolvedReferences.filter((reference) => !resolved.has(reference)),
      ),
    });
  });
}
