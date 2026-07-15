import {
  createConfidence,
  createEntityStableKey,
  createProvenance,
  type ConfidenceLevel,
  type EntityAttributesByKind,
  type EntityFact,
  type EntityKind,
  type FactProvenance,
  type RelationshipAttributesByKind,
  type RelationshipFact,
  type RelationshipKind,
  type SourceRange,
} from "@intellirepo/domain";

export interface FactContext {
  readonly artifactPath: string;
  readonly repositoryId: string;
  readonly revisionId: string;
}

export interface FactEvidence {
  readonly evidence: string;
  readonly level: ConfidenceLevel;
  readonly range: SourceRange;
  readonly reason: string;
  readonly score: number;
}

function provenance(context: FactContext, evidence: FactEvidence): FactProvenance {
  return createProvenance({
    artifactPath: context.artifactPath,
    confidence: createConfidence({
      level: evidence.level,
      reason: evidence.reason,
      score: evidence.score,
    }),
    evidence: evidence.evidence,
    extractor: "typescript",
    range: evidence.range,
    repositoryRevision: context.revisionId,
  });
}

export interface EntityFactInput<K extends EntityKind> extends FactEvidence {
  readonly attributes: Readonly<EntityAttributesByKind[K]>;
  readonly kind: K;
  readonly name: string;
  readonly qualifiedName: string;
}

export function makeEntityFact<K extends EntityKind>(
  context: FactContext,
  input: EntityFactInput<K>,
): Extract<EntityFact, { readonly kind: K }> {
  return Object.freeze({
    attributes: input.attributes,
    kind: input.kind,
    language: "typescript",
    name: input.name,
    provenance: provenance(context, input),
    qualifiedName: input.qualifiedName,
    stableKey: createEntityStableKey({
      kind: input.kind,
      language: "typescript",
      qualifiedName: input.qualifiedName,
      repositoryId: context.repositoryId,
    }),
  }) as unknown as Extract<EntityFact, { readonly kind: K }>;
}

export interface RelationshipFactInput<K extends RelationshipKind> extends FactEvidence {
  readonly attributes: Readonly<RelationshipAttributesByKind[K]>;
  readonly kind: K;
  readonly source: RelationshipFact["source"];
  readonly target: RelationshipFact["target"];
}

export function makeRelationshipFact<K extends RelationshipKind>(
  context: FactContext,
  input: RelationshipFactInput<K>,
): Extract<RelationshipFact, { readonly kind: K }> {
  return Object.freeze({
    attributes: input.attributes,
    kind: input.kind,
    provenance: provenance(context, input),
    source: input.source,
    target: input.target,
  }) as unknown as Extract<RelationshipFact, { readonly kind: K }>;
}
