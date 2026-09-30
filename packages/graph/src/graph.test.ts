import { describe, expect, it, vi } from "vitest";

import type { AdjacentGraphSlice, CanonicalGraphReader } from "./postgres/postgres-traversal.js";
import { PostgresGraphTraversal } from "./postgres/postgres-traversal.js";
import type { GraphEdge, GraphNode, TraversalQuery } from "./traversal.js";

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

  it("rejects repository or revision mismatches before traversal", async () => {
    const traversal = new PostgresGraphTraversal(new FixtureReader());
    await expect(traversal.traverse({ ...query, repositoryId: "other" })).rejects.toThrow(
      "not current",
    );
  });
});
