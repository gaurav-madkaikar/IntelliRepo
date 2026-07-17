import type { CatalogDatabase } from "@intellirepo/catalog";
import type { Kysely } from "kysely";

import {
  type GraphEdge,
  type GraphNode,
  type GraphTraversal,
  type TraversalDirection,
  type TraversalQuery,
  type TraversalResult,
  traversalDirection,
  validateTraversalQuery,
} from "../traversal.js";
import type {
  CanonicalGraphSnapshot,
  CanonicalGraphSnapshotSource,
} from "../neo4j/neo4j-projector.js";

export interface AdjacentGraphSlice {
  readonly edges: readonly GraphEdge[];
  readonly nodes: readonly GraphNode[];
}

export interface CanonicalGraphReader {
  assertCurrentRevision(repositoryId: string, revisionId: string): Promise<void>;
  findAdjacent(
    repositoryId: string,
    entityIds: readonly string[],
    direction: TraversalDirection,
    relationshipKinds: readonly string[],
  ): Promise<AdjacentGraphSlice>;
  findNodesByStableKeys(
    repositoryId: string,
    stableKeys: readonly string[],
  ): Promise<readonly GraphNode[]>;
}

type EntityRow = {
  attributes: Record<string, unknown>;
  id: string;
  kind: string;
  name: string;
  qualified_name: string | null;
  stable_key: string;
};

function graphNode(row: EntityRow): GraphNode {
  return {
    attributes: row.attributes,
    id: row.id,
    kind: row.kind,
    name: row.name,
    ...(row.qualified_name === null ? {} : { qualifiedName: row.qualified_name }),
    stableKey: row.stable_key,
  };
}

export class PostgresCanonicalGraphReader implements CanonicalGraphReader {
  public constructor(private readonly database: Kysely<CatalogDatabase>) {}

  public async assertCurrentRevision(repositoryId: string, revisionId: string): Promise<void> {
    const revision = await this.database
      .selectFrom("revisions")
      .select("status")
      .where("id", "=", revisionId)
      .where("repository_id", "=", repositoryId)
      .executeTakeFirst();
    if (revision?.status !== "active") {
      throw new Error(`Revision ${revisionId} is not the active canonical revision`);
    }
  }

  public async findNodesByStableKeys(
    repositoryId: string,
    stableKeys: readonly string[],
  ): Promise<readonly GraphNode[]> {
    if (stableKeys.length === 0) return [];
    const rows = await this.database
      .selectFrom("entities")
      .select(["attributes", "id", "kind", "name", "qualified_name", "stable_key"])
      .where("repository_id", "=", repositoryId)
      .where("stable_key", "in", [...stableKeys])
      .execute();
    return rows.map(graphNode);
  }

  public async findAdjacent(
    repositoryId: string,
    entityIds: readonly string[],
    direction: TraversalDirection,
    relationshipKinds: readonly string[],
  ): Promise<AdjacentGraphSlice> {
    if (entityIds.length === 0) return { edges: [], nodes: [] };
    let query = this.database
      .selectFrom("relationships")
      .select(["attributes", "id", "kind", "source_entity_id", "target_entity_id"])
      .where("repository_id", "=", repositoryId)
      .where((expression) => {
        if (direction === "incoming") {
          return expression("target_entity_id", "in", [...entityIds]);
        }
        if (direction === "outgoing") {
          return expression("source_entity_id", "in", [...entityIds]);
        }
        return expression.or([
          expression("source_entity_id", "in", [...entityIds]),
          expression("target_entity_id", "in", [...entityIds]),
        ]);
      });
    if (relationshipKinds.length > 0) {
      query = query.where("kind", "in", [...relationshipKinds]);
    }
    const rows = await query.execute();
    const edges = rows.map((row): GraphEdge => ({
      attributes: row.attributes,
      id: row.id,
      kind: row.kind,
      sourceId: row.source_entity_id,
      targetId: row.target_entity_id,
    }));
    const adjacentIds = [
      ...new Set(edges.flatMap(({ sourceId, targetId }) => [sourceId, targetId])),
    ];
    const nodes =
      adjacentIds.length === 0
        ? []
        : await this.database
            .selectFrom("entities")
            .select(["attributes", "id", "kind", "name", "qualified_name", "stable_key"])
            .where("repository_id", "=", repositoryId)
            .where("id", "in", adjacentIds)
            .execute();
    return { edges, nodes: nodes.map(graphNode) };
  }
}

/** Loads the canonical current graph for a rebuildable projection. */
export class PostgresGraphSnapshotSource implements CanonicalGraphSnapshotSource {
  public constructor(private readonly database: Kysely<CatalogDatabase>) {}

  public async load(repositoryId: string, revisionId: string): Promise<CanonicalGraphSnapshot> {
    const reader = new PostgresCanonicalGraphReader(this.database);
    await reader.assertCurrentRevision(repositoryId, revisionId);
    const entityRows = await this.database
      .selectFrom("entities")
      .select(["attributes", "id", "kind", "name", "qualified_name", "stable_key"])
      .where("repository_id", "=", repositoryId)
      .execute();
    const relationshipRows = await this.database
      .selectFrom("relationships")
      .select(["attributes", "id", "kind", "source_entity_id", "target_entity_id"])
      .where("repository_id", "=", repositoryId)
      .execute();
    return {
      edges: relationshipRows.map((row) => ({
        attributes: row.attributes,
        id: row.id,
        kind: row.kind,
        sourceId: row.source_entity_id,
        targetId: row.target_entity_id,
      })),
      nodes: entityRows.map(graphNode),
      repositoryId,
      revisionId,
    };
  }
}

export class PostgresGraphTraversal implements GraphTraversal {
  public constructor(private readonly reader: CanonicalGraphReader) {}

  public async traverse(query: TraversalQuery): Promise<TraversalResult> {
    const { maxDepth, maxNodes } = validateTraversalQuery(query);
    await this.reader.assertCurrentRevision(query.repositoryId, query.revisionId);
    const startNodes = await this.reader.findNodesByStableKeys(
      query.repositoryId,
      query.startEntityKeys,
    );
    const foundKeys = new Set(startNodes.map(({ stableKey }) => stableKey));
    const nodes = new Map(startNodes.map((node) => [node.id, node]));
    const edges = new Map<string, GraphEdge>();
    let frontier = startNodes.map(({ id }) => id);
    let truncated = startNodes.length > maxNodes;

    for (let depth = 0; depth < maxDepth && frontier.length > 0 && !truncated; depth += 1) {
      const slice = await this.reader.findAdjacent(
        query.repositoryId,
        frontier,
        traversalDirection(query),
        query.relationshipKinds ?? [],
      );
      const next: string[] = [];
      for (const node of slice.nodes) {
        if (nodes.has(node.id)) continue;
        if (nodes.size >= maxNodes) {
          truncated = true;
          break;
        }
        nodes.set(node.id, node);
        next.push(node.id);
      }
      for (const edge of slice.edges) {
        if (nodes.has(edge.sourceId) && nodes.has(edge.targetId)) edges.set(edge.id, edge);
      }
      frontier = next;
    }

    return {
      adapter: "postgresql",
      edges: [...edges.values()],
      missingStartEntityKeys: query.startEntityKeys.filter((key) => !foundKeys.has(key)),
      nodes: [...nodes.values()].slice(0, maxNodes),
      projection: { requestedRevisionId: query.revisionId, state: "current" },
      repositoryId: query.repositoryId,
      revisionId: query.revisionId,
      truncated,
    };
  }
}
