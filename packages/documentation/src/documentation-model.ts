export type DocumentationSeverity = "high" | "informational" | "low" | "medium";

export type DocumentationClaimKind =
  "command" | "configuration" | "endpoint" | "entity" | "source_link";

export interface MarkdownDocumentInput {
  readonly content: string;
  readonly path: string;
}

export interface DocumentationSourceReference {
  readonly artifactPath: string;
  readonly endLine?: number;
  readonly evidence: string;
  readonly startLine?: number;
}

export interface DocumentationEntity {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly confidence?: number;
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly qualifiedName?: string;
  readonly source?: DocumentationSourceReference;
  readonly stableKey: string;
}

export interface DocumentationRelationship {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly confidence?: number;
  readonly id: string;
  readonly kind: string;
  readonly sourceEntityKey: string;
  readonly sourceReference?: DocumentationSourceReference;
  readonly targetEntityKey: string;
}

export interface DocumentationFactSnapshot {
  readonly entities: readonly DocumentationEntity[];
  readonly relationships: readonly DocumentationRelationship[];
  readonly repositoryId: string;
  readonly revisionId: string;
}

export interface MarkdownSection {
  readonly body: string;
  readonly heading: string;
  readonly headingPath: readonly string[];
  readonly id: string;
  readonly level: number;
  readonly lineEnd: number;
  readonly lineStart: number;
  readonly stableKey: string;
}

export interface MarkdownPage {
  readonly contentHash: string;
  readonly id: string;
  readonly path: string;
  readonly revisionId: string;
  readonly sections: readonly MarkdownSection[];
  readonly title: string;
}

export interface DocumentationClaim {
  readonly confidence: number;
  readonly id: string;
  readonly kind: DocumentationClaimKind;
  readonly line: number;
  readonly pageId: string;
  readonly payload: Readonly<Record<string, string | number>>;
  readonly sectionId: string;
  readonly sourceText: string;
}

export type DocumentationFindingKind =
  | "ambiguous_claim"
  | "missing_documentation"
  | "removed_entity"
  | "stale_command"
  | "stale_configuration"
  | "stale_endpoint"
  | "stale_source_link";

export interface DocumentationFinding {
  readonly claimId?: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly kind: DocumentationFindingKind;
  readonly message: string;
  readonly pageId?: string;
  readonly severity: DocumentationSeverity;
  readonly status: "confirmed" | "review";
  readonly suggestedText?: string;
}

export type DocumentationGapKind = "changed_component" | "configuration" | "endpoint" | "module";

export interface DocumentationGap {
  readonly entityKey: string;
  readonly id: string;
  readonly kind: DocumentationGapKind;
  readonly message: string;
  readonly severity: "informational";
  readonly suggestedPath: string;
}

export interface DocumentationHealth {
  readonly explanation: string;
  readonly metrics: {
    readonly confirmedFindings: number;
    readonly gaps: number;
    readonly high: number;
    readonly indexingCompleteness: number;
    readonly informational: number;
    readonly low: number;
    readonly medium: number;
    readonly reviewCandidates: number;
  };
  readonly score: number;
}

export interface DocumentationAnalysis {
  readonly claims: readonly DocumentationClaim[];
  readonly findings: readonly DocumentationFinding[];
  readonly gaps: readonly DocumentationGap[];
  readonly health: DocumentationHealth;
  readonly pages: readonly MarkdownPage[];
  readonly repositoryId: string;
  readonly reusedPaths: readonly string[];
  readonly revisionId: string;
}

export interface DocumentationAnalysisInput {
  readonly affectedPaths?: readonly string[];
  readonly changedEntityKeys?: readonly string[];
  readonly documents: readonly MarkdownDocumentInput[];
  readonly indexingCompleteness?: number;
  readonly previous?: DocumentationAnalysis;
  readonly snapshot: DocumentationFactSnapshot;
}
