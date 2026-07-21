import type { GraphEdge, GraphNode, TraversalAdapter, ProjectionContext } from "@intellirepo/graph";

export type QuestionIntentKind =
  | "callees"
  | "callers"
  | "configuration_usage"
  | "documentation_impact"
  | "endpoint_flow"
  | "entity_lookup"
  | "module_explanation"
  | "semantic_unknown"
  | "test_impact";

export interface QuestionIntent {
  readonly kind: QuestionIntentKind;
  readonly searchTerm: string;
  readonly structural: boolean;
}

export interface EvidenceReference {
  readonly confidence: number;
  readonly endLine?: number;
  readonly evidence: string;
  readonly id: string;
  readonly path: string;
  readonly sourceId: string;
  readonly sourceKind: "semantic" | "structural";
  readonly startLine?: number;
}

export interface EvidencePack {
  readonly adapter?: TraversalAdapter;
  readonly edges: readonly GraphEdge[];
  readonly intent: QuestionIntent;
  readonly nodes: readonly GraphNode[];
  readonly projection?: ProjectionContext;
  readonly references: readonly EvidenceReference[];
  readonly truncated: boolean;
}

export interface RepositoryAnswer {
  readonly answer: string;
  readonly citations: readonly EvidenceReference[];
  readonly confidence: "high" | "low" | "medium";
  readonly degraded: boolean;
  readonly degradedReasons: readonly string[];
  readonly evidence: EvidencePack;
  readonly inferred: boolean;
  readonly intent: QuestionIntentKind;
  readonly question: string;
  readonly repositoryId: string;
  readonly revisionId: string;
}
