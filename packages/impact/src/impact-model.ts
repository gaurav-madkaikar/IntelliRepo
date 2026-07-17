import type { ConfidenceLevel } from "@intellirepo/domain";

export interface SourceReference {
  readonly artifactPath: string;
  readonly endLine?: number;
  readonly evidence: string;
  readonly startLine?: number;
}

export interface SnapshotEntity {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly confidence?: number;
  readonly id: string;
  readonly kind: string;
  readonly language?: string;
  readonly name: string;
  readonly qualifiedName?: string;
  readonly source?: SourceReference;
  readonly stableKey: string;
}

export interface SnapshotRelationship {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly confidence?: number;
  readonly id: string;
  readonly kind: string;
  readonly sourceEntityKey: string;
  readonly sourceReference?: SourceReference;
  readonly targetEntityKey: string;
}

export interface FactSnapshot {
  readonly entities: readonly SnapshotEntity[];
  readonly relationships: readonly SnapshotRelationship[];
  readonly repositoryId: string;
  readonly revisionId: string;
}

export type ChangeKind = "added" | "modified" | "removed";

export interface EntityChange {
  readonly after?: SnapshotEntity;
  readonly before?: SnapshotEntity;
  readonly changedFields: readonly string[];
  readonly kind: ChangeKind;
  readonly stableKey: string;
}

export interface RelationshipChange {
  readonly after?: SnapshotRelationship;
  readonly before?: SnapshotRelationship;
  readonly changedFields: readonly string[];
  readonly identity: string;
  readonly kind: ChangeKind;
}

export interface SemanticDiff {
  readonly baseRevisionId: string;
  readonly entities: readonly EntityChange[];
  readonly relationships: readonly RelationshipChange[];
  readonly repositoryId: string;
  readonly summary: Readonly<Record<ChangeKind, number>>;
  readonly targetRevisionId: string;
}

export interface EvidenceStep {
  readonly direction: "incoming" | "outgoing";
  readonly fromEntityKey: string;
  readonly relationshipId: string;
  readonly relationshipKind: string;
  readonly sourceRevision: "base" | "target";
  readonly toEntityKey: string;
  readonly weight: number;
}

export interface AffectedEntity {
  readonly changeKind?: ChangeKind;
  readonly confidence: number;
  readonly entity: SnapshotEntity;
  readonly evidencePath: readonly EvidenceStep[];
  readonly reason: string;
}

export interface AffectedSubgraph {
  readonly entities: readonly AffectedEntity[];
  readonly repositoryId: string;
  readonly revisionId: string;
  readonly truncated: boolean;
  readonly traversal?: {
    readonly adapter: string;
    readonly degradedReason?: string;
  };
}

export interface TestRecommendation {
  readonly confidence: {
    readonly level: ConfidenceLevel;
    readonly reason: string;
    readonly score: number;
  };
  readonly evidencePath: readonly EvidenceStep[];
  readonly reason: string;
  readonly score: number;
  readonly testEntity: SnapshotEntity;
}

export interface RiskFactor {
  readonly evidence: readonly string[];
  readonly explanation: string;
  readonly factor: string;
  readonly weight: number;
}

export interface RiskAssessment {
  readonly factors: readonly RiskFactor[];
  readonly level: "High" | "Low" | "Medium";
  readonly score: number;
}
