import type { SnapshotRelationship } from "./impact-model.js";

export interface TraversalRule {
  readonly incoming: number;
  readonly kind: string;
  readonly outgoing: number;
  readonly reason: string;
}

export const DEFAULT_TRAVERSAL_RULES: readonly TraversalRule[] = Object.freeze([
  { incoming: 0.85, kind: "CALLS", outgoing: 0.45, reason: "call dependency" },
  { incoming: 0.75, kind: "IMPORTS", outgoing: 0.3, reason: "import dependency" },
  { incoming: 0.8, kind: "CONTAINS", outgoing: 0.8, reason: "containment" },
  { incoming: 0.8, kind: "DECLARES", outgoing: 0.8, reason: "declaration ownership" },
  { incoming: 0.95, kind: "HANDLES", outgoing: 0.95, reason: "endpoint handler" },
  { incoming: 0.75, kind: "USES_MIDDLEWARE", outgoing: 0.55, reason: "middleware chain" },
  { incoming: 0.9, kind: "READS_CONFIG", outgoing: 0.35, reason: "configuration consumer" },
  { incoming: 0.95, kind: "TESTS", outgoing: 0.25, reason: "test coverage" },
  { incoming: 0.9, kind: "DOCUMENTS", outgoing: 0.2, reason: "documentation coverage" },
  { incoming: 0.7, kind: "DEPENDS_ON", outgoing: 0.35, reason: "module dependency" },
  { incoming: 0.7, kind: "EXTENDS", outgoing: 0.55, reason: "inheritance" },
  { incoming: 0.7, kind: "IMPLEMENTS", outgoing: 0.55, reason: "implementation" },
]);

export function relationshipConfidenceMultiplier(relationship: SnapshotRelationship): number {
  if (relationship.confidence !== undefined) return relationship.confidence;
  if (relationship.kind === "CALLS") {
    const resolution = relationship.attributes.resolution;
    if (resolution === "unresolved") return 0.35;
    if (resolution === "name") return 0.75;
  }
  if (relationship.kind === "TESTS" && relationship.attributes.basis === "naming") return 0.55;
  return 1;
}
