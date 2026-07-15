import {
  createConfidence,
  createEntityStableKey,
  createProvenance,
  type ConfidenceLevel,
  type EntityAttributesByKind,
  type EntityFact,
  type EntityKind,
  type RelationshipAttributesByKind,
  type RelationshipFact,
  type RelationshipKind,
  type SourceLanguage,
  type SourceRange,
} from "@intellirepo/domain";

export interface JvmFactContext {
  readonly artifactPath: string;
  readonly extractor: string;
  readonly language: Extract<SourceLanguage, "java" | "kotlin">;
  readonly repositoryId: string;
  readonly revisionId: string;
}

interface Evidence {
  readonly evidence: string;
  readonly level: ConfidenceLevel;
  readonly range: SourceRange;
  readonly reason: string;
  readonly score: number;
}

interface EntityInput<K extends EntityKind> extends Evidence {
  readonly attributes: Readonly<EntityAttributesByKind[K]>;
  readonly kind: K;
  readonly name: string;
  readonly qualifiedName: string;
}

interface RelationshipInput<K extends RelationshipKind> extends Evidence {
  readonly attributes: Readonly<RelationshipAttributesByKind[K]>;
  readonly kind: K;
  readonly source: RelationshipFact["source"];
  readonly target: RelationshipFact["target"];
}

function provenance(context: JvmFactContext, evidence: Evidence) {
  return createProvenance({
    artifactPath: context.artifactPath,
    confidence: createConfidence({
      level: evidence.level,
      reason: evidence.reason,
      score: evidence.score,
    }),
    evidence: evidence.evidence,
    extractor: context.extractor,
    range: evidence.range,
    repositoryRevision: context.revisionId,
  });
}

export function makeJvmEntityFact<K extends EntityKind>(
  context: JvmFactContext,
  input: EntityInput<K>,
): Extract<EntityFact, { readonly kind: K }> {
  return Object.freeze({
    attributes: input.attributes,
    kind: input.kind,
    language: context.language,
    name: input.name,
    provenance: provenance(context, input),
    qualifiedName: input.qualifiedName,
    stableKey: createEntityStableKey({
      kind: input.kind,
      language: context.language,
      qualifiedName: input.qualifiedName,
      repositoryId: context.repositoryId,
    }),
  }) as unknown as Extract<EntityFact, { readonly kind: K }>;
}

export function makeJvmRelationshipFact<K extends RelationshipKind>(
  context: JvmFactContext,
  input: RelationshipInput<K>,
): Extract<RelationshipFact, { readonly kind: K }> {
  return Object.freeze({
    attributes: input.attributes,
    kind: input.kind,
    provenance: provenance(context, input),
    source: input.source,
    target: input.target,
  }) as unknown as Extract<RelationshipFact, { readonly kind: K }>;
}
