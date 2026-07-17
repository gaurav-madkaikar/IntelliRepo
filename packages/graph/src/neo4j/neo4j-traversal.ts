import {
  type GraphTraversal,
  type TraversalQuery,
  type TraversalResult,
  traversalDirection,
  validateTraversalQuery,
} from "../traversal.js";
import type { Neo4jExecutor } from "./neo4j-executor.js";

type Neo4jTraversalRow = Pick<
  TraversalResult,
  "edges" | "missingStartEntityKeys" | "nodes" | "truncated"
>;

export class Neo4jGraphTraversal implements GraphTraversal {
  public constructor(private readonly executor: Neo4jExecutor) {}

  public async traverse(query: TraversalQuery): Promise<TraversalResult> {
    const { maxDepth, maxNodes } = validateTraversalQuery(query);
    const direction = traversalDirection(query);
    const cypherDirection =
      direction === "incoming"
        ? "<-[rel:INTELLIREPO_RELATIONSHIP*0..10]-"
        : direction === "outgoing"
          ? "-[rel:INTELLIREPO_RELATIONSHIP*0..10]->"
          : "-[rel:INTELLIREPO_RELATIONSHIP*0..10]-";
    const rows = await this.executor.read<Neo4jTraversalRow>({
      cypher: `MATCH (start:IntelliRepoEntity) WHERE start.repositoryId = $repositoryId AND start.revisionId = $revisionId AND start.stableKey IN $startEntityKeys MATCH path=(start)${cypherDirection}(connected:IntelliRepoEntity) WHERE length(path) <= $maxDepth AND all(edge IN relationships(path) WHERE size($relationshipKinds) = 0 OR edge.kind IN $relationshipKinds) WITH collect(DISTINCT start.stableKey) AS foundKeys, collect(DISTINCT connected) AS allNodes, collect(DISTINCT path) AS paths WITH foundKeys, allNodes[..$maxNodes] AS selectedNodes, size(allNodes) > $maxNodes AS truncated, reduce(allRelationships = [], path IN paths | allRelationships + relationships(path)) AS allRelationships WITH foundKeys, selectedNodes, truncated, reduce(uniqueEdges = [], edge IN allRelationships | CASE WHEN any(existing IN uniqueEdges WHERE existing.id = edge.id) THEN uniqueEdges ELSE uniqueEdges + edge END) AS selectedEdges RETURN [node IN selectedNodes | {attributes: node.attributes, id: node.id, kind: node.kind, name: node.name, qualifiedName: node.qualifiedName, stableKey: node.stableKey}] AS nodes, [edge IN selectedEdges WHERE startNode(edge) IN selectedNodes AND endNode(edge) IN selectedNodes | {attributes: edge.attributes, id: edge.id, kind: edge.kind, sourceId: startNode(edge).id, targetId: endNode(edge).id}] AS edges, truncated, [key IN $startEntityKeys WHERE NOT key IN foundKeys] AS missingStartEntityKeys`,
      parameters: {
        maxDepth,
        maxNodes,
        relationshipKinds: query.relationshipKinds ?? [],
        repositoryId: query.repositoryId,
        revisionId: query.revisionId,
        startEntityKeys: query.startEntityKeys,
      },
    });
    const row = rows[0] ?? {
      edges: [],
      missingStartEntityKeys: query.startEntityKeys,
      nodes: [],
      truncated: false,
    };
    return {
      adapter: "neo4j",
      ...row,
      projection: {
        projectedRevisionId: query.revisionId,
        requestedRevisionId: query.revisionId,
        state: "current",
      },
      repositoryId: query.repositoryId,
      revisionId: query.revisionId,
    };
  }
}
