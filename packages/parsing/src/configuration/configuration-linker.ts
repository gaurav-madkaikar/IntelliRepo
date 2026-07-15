import type { EntityFact, EntityStableKey } from "@intellirepo/domain";

import type { ArtifactExtractionResult, UnresolvedReference } from "../interfaces/extraction.js";
import {
  makeMetadataRelationshipFact,
  type MetadataFactContext,
} from "../metadata/fact-factory.js";

function definitionName(entity: EntityFact): string | undefined {
  if (entity.kind === "configuration_key") return entity.attributes.key;
  if (entity.kind === "environment_variable") return entity.attributes.name;
  return undefined;
}

function uniqueDefinition(
  definitions: readonly EntityFact[],
  name: string,
): EntityFact | undefined {
  const matches = definitions.filter((entity) => definitionName(entity) === name);
  return matches.length === 1 ? matches[0] : undefined;
}

function contextFor(
  result: ArtifactExtractionResult,
  source: EntityFact | undefined,
  repositoryId: string,
  revisionId: string,
): MetadataFactContext {
  return {
    artifactPath: result.artifactPath,
    extractor: "configuration-linker",
    ...(source?.language === undefined ? {} : { language: source.language }),
    repositoryId,
    revisionId,
  };
}

function sourceEntity(
  entities: ReadonlyMap<EntityStableKey, EntityFact>,
  reference: UnresolvedReference,
): EntityFact | undefined {
  return entities.get(reference.sourceEntityKey);
}

export function linkConfigurationReferences(
  results: readonly ArtifactExtractionResult[],
  repositoryId: string,
  revisionId: string,
): readonly ArtifactExtractionResult[] {
  const allEntities = results.flatMap(({ entities }) => entities);
  const entityByKey = new Map(allEntities.map((entity) => [entity.stableKey, entity]));
  const definitions = allEntities.filter(
    ({ kind, provenance }) =>
      (kind === "configuration_key" || kind === "environment_variable") &&
      provenance.extractor === "configuration-manifest",
  );

  return results.map((result) => {
    const relationships = [...result.relationships];
    const linked = new Set<UnresolvedReference>();
    for (const reference of result.unresolvedReferences) {
      if (reference.kind !== "configuration") continue;
      const target = uniqueDefinition(definitions, reference.name);
      if (target === undefined) continue;
      const source = sourceEntity(entityByKey, reference);
      relationships.push(
        makeMetadataRelationshipFact(contextFor(result, source, repositoryId, revisionId), {
          attributes: { access: "direct" },
          evidence: reference.name,
          kind: "READS_CONFIG",
          level: "inferred",
          range: reference.range,
          reason: "Unique repository configuration definition matched",
          score: 0.9,
          source: reference.sourceEntityKey,
          target: target.stableKey,
        }),
      );
      linked.add(reference);
    }

    for (const relationship of result.relationships) {
      if (relationship.kind !== "READS_CONFIG") continue;
      const used = entityByKey.get(relationship.target);
      if (used?.kind !== "environment_variable") continue;
      const target = uniqueDefinition(definitions, used.attributes.name);
      if (target === undefined || target.stableKey === used.stableKey) continue;
      const source = entityByKey.get(relationship.source);
      relationships.push(
        makeMetadataRelationshipFact(contextFor(result, source, repositoryId, revisionId), {
          attributes: relationship.attributes,
          evidence: used.attributes.name,
          kind: "READS_CONFIG",
          level: "inferred",
          range: relationship.provenance.range,
          reason: "Environment variable example matched to source use",
          score: 0.9,
          source: relationship.source,
          target: target.stableKey,
        }),
      );
    }

    return Object.freeze({
      ...result,
      relationships: Object.freeze(relationships),
      unresolvedReferences: Object.freeze(
        result.unresolvedReferences.filter((reference) => !linked.has(reference)),
      ),
    });
  });
}
