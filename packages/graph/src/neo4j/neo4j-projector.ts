import type { GraphEdge, GraphNode } from "../traversal.js";
import type { Neo4jExecutor, Neo4jStatement } from "./neo4j-executor.js";

export interface CanonicalGraphSnapshot {
  readonly edges: readonly GraphEdge[];
  readonly nodes: readonly GraphNode[];
  readonly repositoryId: string;
  readonly revisionId: string;
}

export interface GraphProjectionDelta {
  readonly removedEdgeIds: readonly string[];
  readonly removedNodeIds: readonly string[];
  readonly repositoryId: string;
  readonly revisionId: string;
  readonly upsertedEdges: readonly GraphEdge[];
  readonly upsertedNodes: readonly GraphNode[];
}

export interface CanonicalGraphSnapshotSource {
  load(repositoryId: string, revisionId: string): Promise<CanonicalGraphSnapshot>;
}

export interface ProjectionStateWriter {
  save(input: {
    readonly error?: Readonly<Record<string, unknown>>;
    readonly projection: string;
    readonly repositoryId: string;
    readonly revisionId?: string;
    readonly state: "current" | "delayed" | "pending" | "projecting";
  }): Promise<unknown>;
}

function projectionStatements(snapshot: CanonicalGraphSnapshot): readonly Neo4jStatement[] {
  const scope = { repositoryId: snapshot.repositoryId, revisionId: snapshot.revisionId };
  return [
    {
      cypher: "MATCH (n:IntelliRepoEntity {repositoryId: $repositoryId}) DETACH DELETE n",
      parameters: scope,
    },
    {
      cypher:
        "UNWIND $nodes AS node CREATE (n:IntelliRepoEntity {id: node.id, stableKey: node.stableKey, repositoryId: $repositoryId, revisionId: $revisionId}) SET n.kind = node.kind, n.name = node.name, n.qualifiedName = node.qualifiedName, n.attributes = node.attributes",
      parameters: { ...scope, nodes: snapshot.nodes },
    },
    {
      cypher:
        "UNWIND $edges AS edge MATCH (source:IntelliRepoEntity {id: edge.sourceId, repositoryId: $repositoryId}), (target:IntelliRepoEntity {id: edge.targetId, repositoryId: $repositoryId}) CREATE (source)-[:INTELLIREPO_RELATIONSHIP {id: edge.id, kind: edge.kind, attributes: edge.attributes, revisionId: $revisionId}]->(target)",
      parameters: { ...scope, edges: snapshot.edges },
    },
  ];
}

export class Neo4jProjector {
  public constructor(private readonly executor: Neo4jExecutor) {}

  public replace(snapshot: CanonicalGraphSnapshot): Promise<void> {
    return this.executor.write(projectionStatements(snapshot));
  }

  public apply(delta: GraphProjectionDelta): Promise<void> {
    const scope = { repositoryId: delta.repositoryId, revisionId: delta.revisionId };
    return this.executor.write([
      {
        cypher:
          "MATCH ()-[relationship:INTELLIREPO_RELATIONSHIP]->() WHERE relationship.id IN $removedEdgeIds DELETE relationship",
        parameters: { ...scope, removedEdgeIds: delta.removedEdgeIds },
      },
      {
        cypher:
          "MATCH (node:IntelliRepoEntity {repositoryId: $repositoryId}) WHERE node.id IN $removedNodeIds DETACH DELETE node",
        parameters: { ...scope, removedNodeIds: delta.removedNodeIds },
      },
      {
        cypher:
          "UNWIND $nodes AS node MERGE (entity:IntelliRepoEntity {repositoryId: $repositoryId, id: node.id}) SET entity.stableKey = node.stableKey, entity.revisionId = $revisionId, entity.kind = node.kind, entity.name = node.name, entity.qualifiedName = node.qualifiedName, entity.attributes = node.attributes",
        parameters: { ...scope, nodes: delta.upsertedNodes },
      },
      {
        cypher:
          "UNWIND $edges AS edge MATCH (source:IntelliRepoEntity {repositoryId: $repositoryId, id: edge.sourceId}), (target:IntelliRepoEntity {repositoryId: $repositoryId, id: edge.targetId}) MERGE (source)-[relationship:INTELLIREPO_RELATIONSHIP {id: edge.id}]->(target) SET relationship.kind = edge.kind, relationship.attributes = edge.attributes, relationship.revisionId = $revisionId",
        parameters: { ...scope, edges: delta.upsertedEdges },
      },
      {
        cypher:
          "MERGE (projection:IntelliRepoProjection {repositoryId: $repositoryId}) SET projection.revisionId = $revisionId, projection.updatedAt = datetime()",
        parameters: scope,
      },
    ]);
  }
}

export class Neo4jProjectionRebuilder {
  public constructor(
    private readonly source: CanonicalGraphSnapshotSource,
    private readonly projector: Neo4jProjector,
    private readonly states: ProjectionStateWriter,
  ) {}

  public async rebuild(repositoryId: string, revisionId: string): Promise<void> {
    await this.states.save({ projection: "neo4j", repositoryId, revisionId, state: "projecting" });
    try {
      const snapshot = await this.source.load(repositoryId, revisionId);
      await this.projector.replace(snapshot);
      await this.states.save({ projection: "neo4j", repositoryId, revisionId, state: "current" });
    } catch (error) {
      await this.states.save({
        error: {
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        },
        projection: "neo4j",
        repositoryId,
        revisionId,
        state: "delayed",
      });
      throw error;
    }
  }
}
