export type TraversalMode = "affected-subgraph" | "endpoint-flow" | "neighborhood";
export type TraversalDirection = "both" | "incoming" | "outgoing";
export type TraversalAdapter = "neo4j" | "postgresql";

export interface GraphNode {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly qualifiedName?: string;
  readonly stableKey: string;
}

export interface GraphEdge {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly kind: string;
  readonly sourceId: string;
  readonly targetId: string;
}

export interface TraversalQuery {
  readonly direction?: TraversalDirection;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly mode: TraversalMode;
  readonly relationshipKinds?: readonly string[];
  readonly repositoryId: string;
  readonly revisionId: string;
  readonly startEntityKeys: readonly string[];
}

export interface ProjectionContext {
  readonly degradedReason?: string;
  readonly projectedRevisionId?: string;
  readonly requestedRevisionId: string;
  readonly state: "current" | "disabled" | "failed" | "stale";
}

export interface TraversalResult {
  readonly adapter: TraversalAdapter;
  readonly edges: readonly GraphEdge[];
  readonly missingStartEntityKeys: readonly string[];
  readonly nodes: readonly GraphNode[];
  readonly projection: ProjectionContext;
  readonly repositoryId: string;
  readonly revisionId: string;
  readonly truncated: boolean;
}

export interface GraphTraversal {
  traverse(query: TraversalQuery): Promise<TraversalResult>;
}

export function traversalDirection(query: TraversalQuery): TraversalDirection {
  return query.direction ?? (query.mode === "endpoint-flow" ? "outgoing" : "both");
}

export function validateTraversalQuery(query: TraversalQuery): {
  readonly maxDepth: number;
  readonly maxNodes: number;
} {
  const maxDepth = query.maxDepth ?? 3;
  const maxNodes = query.maxNodes ?? 200;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 10) {
    throw new Error("Traversal maxDepth must be an integer between 0 and 10");
  }
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 1_000) {
    throw new Error("Traversal maxNodes must be an integer between 1 and 1000");
  }
  if (query.startEntityKeys.length === 0) {
    throw new Error("Traversal requires at least one start entity key");
  }
  return { maxDepth, maxNodes };
}
