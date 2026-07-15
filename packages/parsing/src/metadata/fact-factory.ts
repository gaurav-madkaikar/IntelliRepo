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

export interface MetadataFactContext {
  readonly artifactPath: string;
  readonly extractor: string;
  readonly language?: SourceLanguage;
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

function provenance(context: MetadataFactContext, evidence: Evidence) {
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

export function makeMetadataEntityFact<K extends EntityKind>(
  context: MetadataFactContext,
  input: EntityInput<K>,
): Extract<EntityFact, { readonly kind: K }> {
  return Object.freeze({
    attributes: input.attributes,
    kind: input.kind,
    ...(context.language === undefined ? {} : { language: context.language }),
    name: input.name,
    provenance: provenance(context, input),
    qualifiedName: input.qualifiedName,
    stableKey: createEntityStableKey({
      kind: input.kind,
      ...(context.language === undefined ? {} : { language: context.language }),
      qualifiedName: input.qualifiedName,
      repositoryId: context.repositoryId,
    }),
  }) as unknown as Extract<EntityFact, { readonly kind: K }>;
}

export function makeMetadataRelationshipFact<K extends RelationshipKind>(
  context: MetadataFactContext,
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

export function rangeForOffsets(
  content: string,
  startOffset: number,
  endOffset: number,
): SourceRange {
  const position = (offset: number) => {
    const before = content.slice(0, Math.max(0, offset));
    const lines = before.split("\n");
    return { column: (lines.at(-1)?.length ?? 0) + 1, line: lines.length };
  };
  return { end: position(endOffset), start: position(startOffset) };
}

export function wholeArtifactRange(content: string): SourceRange {
  return rangeForOffsets(content, 0, Math.max(1, content.length));
}
