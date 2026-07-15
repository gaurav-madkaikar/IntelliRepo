import {
  ENTITY_KINDS,
  RELATIONSHIP_KINDS,
  createConfidence,
  createProvenance,
  createSourceRange,
  type EntityFact,
  type RelationshipFact,
} from "@intellirepo/domain";

import type { ArtifactExtractionResult } from "../interfaces/extraction.js";

function validateProvenance(
  fact: EntityFact | RelationshipFact,
  artifactPath: string,
  revisionId: string,
): void {
  if (fact.provenance.artifactPath !== artifactPath) {
    throw new Error(`Fact provenance must belong to ${artifactPath}`);
  }
  if (fact.provenance.repositoryRevision !== revisionId) {
    throw new Error(`Fact provenance must reference revision ${revisionId}`);
  }

  const confidence = createConfidence(fact.provenance.confidence);
  createProvenance({ ...fact.provenance, confidence });
}

export function validateArtifactExtraction(
  result: ArtifactExtractionResult,
  revisionId: string,
): ArtifactExtractionResult {
  const entityKeys = new Set<string>();

  if (result.artifactPath.trim().length === 0) {
    throw new Error("Artifact extraction path must not be empty");
  }

  for (const entity of result.entities) {
    if (!(ENTITY_KINDS as readonly string[]).includes(entity.kind)) {
      throw new Error(`Unknown entity kind: ${String(entity.kind)}`);
    }
    if (entityKeys.has(entity.stableKey)) {
      throw new Error(`Duplicate entity stable key: ${entity.stableKey}`);
    }
    entityKeys.add(entity.stableKey);
    validateProvenance(entity, result.artifactPath, revisionId);
  }

  for (const relationship of result.relationships) {
    if (!(RELATIONSHIP_KINDS as readonly string[]).includes(relationship.kind)) {
      throw new Error(`Unknown relationship kind: ${String(relationship.kind)}`);
    }
    if (relationship.source.length === 0 || relationship.target.length === 0) {
      throw new Error("Relationship source and target keys must not be empty");
    }
    validateProvenance(relationship, result.artifactPath, revisionId);
  }

  for (const diagnostic of result.diagnostics) {
    if (diagnostic.artifactPath !== result.artifactPath) {
      throw new Error(`Diagnostic must belong to ${result.artifactPath}`);
    }
    if (diagnostic.range !== undefined) createSourceRange(diagnostic.range);
  }

  for (const unresolved of result.unresolvedReferences) {
    if (unresolved.artifactPath !== result.artifactPath) {
      throw new Error(`Unresolved reference must belong to ${result.artifactPath}`);
    }
    createSourceRange(unresolved.range);
  }

  return result;
}
