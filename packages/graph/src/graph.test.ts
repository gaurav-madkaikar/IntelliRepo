import { describe, expect, it, vi } from "vitest";

import { benchmarkTraversalAdapters } from "./benchmark.js";
import type { Neo4jExecutor, Neo4jStatement } from "./neo4j/neo4j-executor.js";
import {
  Neo4jProjectionRebuilder,
  Neo4jProjector,
  type CanonicalGraphSnapshot,
} from "./neo4j/neo4j-projector.js";
import type { AdjacentGraphSlice, CanonicalGraphReader } from "./postgres/postgres-traversal.js";
import { PostgresGraphTraversal } from "./postgres/postgres-traversal.js";
import { ProjectionAwareTraversal } from "./projection-aware-traversal.js";
import type {
  GraphEdge,
  GraphNode,
  GraphTraversal,
  TraversalQuery,
  TraversalResult,
} from "./traversal.js";

const nodes: readonly GraphNode[] = ["api", "service", "repository", "test"].map(
  (stableKey): GraphNode => ({
    attributes: {},
    id: stableKey,
    kind: stableKey === "api" ? "endpoint" : "class",
    name: stableKey,
    stableKey,
  }),
);
const edges: readonly GraphEdge[] = [
  { attributes: {}, id: "e1", kind: "CALLS", sourceId: "api", targetId: "service" },
  {
    attributes: {},
    id: "e2",
    kind: "CALLS",
    sourceId: "service",
    targetId: "repository",
  },
  { attributes: {}, id: "e3", kind: "TESTS", sourceId: "test", targetId: "service" },
];

class FixtureReader implements CanonicalGraphReader {
  public readonly adjacent = vi.fn(
    async (
      _repositoryId: string,
      entityIds: readonly string[],
      direction: "both" | "incoming" | "outgoing",
      kinds: readonly string[],
    ): Promise<AdjacentGraphSlice> => {
      const matching = edges.filter((edge) => {
        const directionMatches =
          direction === "both"
            ? entityIds.includes(edge.sourceId) || entityIds.includes(edge.targetId)
            : direction === "incoming"
              ? entityIds.includes(edge.targetId)
              : entityIds.includes(edge.sourceId);
        return directionMatches && (kinds.length === 0 || kinds.includes(edge.kind));
      });
      const ids = new Set(matching.flatMap(({ sourceId, targetId }) => [sourceId, targetId]));
      return { edges: matching, nodes: nodes.filter(({ id }) => ids.has(id)) };
    },
  );

  public assertCurrentRevision(repositoryId: string, revisionId: string): Promise<void> {
    if (repositoryId !== "repo" || revisionId !== "r2") throw new Error("not current");
    return Promise.resolve();
  }

  public findAdjacent(
    repositoryId: string,
    entityIds: readonly string[],
    direction: "both" | "incoming" | "outgoing",
    relationshipKinds: readonly string[],
  ): Promise<AdjacentGraphSlice> {
    return this.adjacent(repositoryId, entityIds, direction, relationshipKinds);
  }

  public findNodesByStableKeys(
    _repositoryId: string,
    stableKeys: readonly string[],
  ): Promise<readonly GraphNode[]> {
    return Promise.resolve(nodes.filter(({ stableKey }) => stableKeys.includes(stableKey)));
  }
}

const query: TraversalQuery = {
  maxDepth: 2,
  mode: "endpoint-flow",
  repositoryId: "repo",
  revisionId: "r2",
  startEntityKeys: ["api"],
};

function result(adapter: "neo4j" | "postgresql" = "postgresql"): TraversalResult {
  return {
    adapter,
    edges: edges.slice(0, 2),
    missingStartEntityKeys: [],
    nodes: nodes.slice(0, 3),
    projection: { requestedRevisionId: "r2", state: "current" },
    repositoryId: "repo",
    revisionId: "r2",
    truncated: false,
  };
}

describe("PostgresGraphTraversal", () => {
  it("performs a bounded endpoint flow through the canonical graph", async () => {
    const reader = new FixtureReader();
    const traversal = new PostgresGraphTraversal(reader);

    await expect(traversal.traverse(query)).resolves.toMatchObject({
      adapter: "postgresql",
      edges: [{ id: "e1" }, { id: "e2" }],
      nodes: [{ id: "api" }, { id: "service" }, { id: "repository" }],
      truncated: false,
    });
    expect(reader.adjacent).toHaveBeenNthCalledWith(1, "repo", ["api"], "outgoing", []);
  });

  it("enforces node limits and reports missing roots", async () => {
    const traversal = new PostgresGraphTraversal(new FixtureReader());
    const bounded = await traversal.traverse({
      ...query,
      maxNodes: 2,
      startEntityKeys: ["api", "missing"],
    });

    expect(bounded.nodes).toHaveLength(2);
    expect(bounded.missingStartEntityKeys).toEqual(["missing"]);
    expect(bounded.truncated).toBe(true);
  });
});

describe("ProjectionAwareTraversal", () => {
  const postgres = { traverse: vi.fn(() => Promise.resolve(result())) } satisfies GraphTraversal;

  it("uses PostgreSQL and exposes projection lag when Neo4j is stale", async () => {
    const neo4j = { traverse: vi.fn(() => Promise.resolve(result("neo4j"))) };
    const traversal = new ProjectionAwareTraversal(
      postgres,
      { find: () => Promise.resolve({ revision_id: "r1", state: "current" }) },
      neo4j,
    );

    await expect(traversal.traverse(query)).resolves.toMatchObject({
      adapter: "postgresql",
      projection: { projectedRevisionId: "r1", requestedRevisionId: "r2", state: "stale" },
    });
    expect(neo4j.traverse).not.toHaveBeenCalled();
  });

  it("falls back deterministically when a current Neo4j projection fails", async () => {
    const traversal = new ProjectionAwareTraversal(
      postgres,
      { find: () => Promise.resolve({ revision_id: "r2", state: "current" }) },
      { traverse: () => Promise.reject(new Error("connection refused")) },
    );

    await expect(traversal.traverse(query)).resolves.toMatchObject({
      adapter: "postgresql",
      projection: {
        degradedReason: expect.stringContaining("connection refused"),
        state: "failed",
      },
    });
  });
});

describe("Neo4j projection", () => {
  it("rebuilds a repository projection as a transactional statement batch", async () => {
    const writes: Neo4jStatement[][] = [];
    const executor: Neo4jExecutor = {
      read: () => Promise.resolve([]),
      write: (statements) => {
        writes.push([...statements]);
        return Promise.resolve();
      },
    };
    const snapshot: CanonicalGraphSnapshot = {
      edges: edges.slice(0, 2),
      nodes: nodes.slice(0, 3),
      repositoryId: "repo",
      revisionId: "r2",
    };
    const save = vi.fn(() => Promise.resolve(undefined));
    const rebuilder = new Neo4jProjectionRebuilder(
      { load: () => Promise.resolve(snapshot) },
      new Neo4jProjector(executor),
      { save },
    );

    await rebuilder.rebuild("repo", "r2");

    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(3);
    expect(writes[0]?.every(({ parameters }) => parameters.repositoryId === "repo")).toBe(true);
    expect(save).toHaveBeenLastCalledWith({
      projection: "neo4j",
      repositoryId: "repo",
      revisionId: "r2",
      state: "current",
    });
  });

  it("applies replay-safe incremental upserts inside one write transaction", async () => {
    const writes: Neo4jStatement[][] = [];
    const projector = new Neo4jProjector({
      read: () => Promise.resolve([]),
      write: (statements) => {
        writes.push([...statements]);
        return Promise.resolve();
      },
    });

    await projector.apply({
      removedEdgeIds: ["old-edge"],
      removedNodeIds: ["old-node"],
      repositoryId: "repo",
      revisionId: "r2",
      upsertedEdges: edges.slice(0, 1),
      upsertedNodes: nodes.slice(0, 2),
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(5);
    expect(writes[0]?.[2]?.cypher).toContain("MERGE");
    expect(writes[0]?.[4]?.parameters).toEqual({ repositoryId: "repo", revisionId: "r2" });
  });
});

describe("benchmarkTraversalAdapters", () => {
  it("compares representative results independent of adapter metadata", async () => {
    const times = [0, 4, 4, 5];
    const benchmark = await benchmarkTraversalAdapters(
      query,
      { traverse: () => Promise.resolve(result()) },
      { traverse: () => Promise.resolve(result("neo4j")) },
      () => times.shift() ?? 0,
    );

    expect(benchmark).toMatchObject({
      equivalent: true,
      neo4jMilliseconds: 1,
      postgresqlMilliseconds: 4,
    });
  });
});
