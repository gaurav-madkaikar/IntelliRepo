import type { GraphTraversal, TraversalQuery, TraversalResult } from "./traversal.js";

export interface TraversalBenchmark {
  readonly equivalent: boolean;
  readonly neo4jMilliseconds: number;
  readonly neo4jResult: TraversalResult;
  readonly postgresqlMilliseconds: number;
  readonly postgresqlResult: TraversalResult;
}

function identity(result: TraversalResult): string {
  return JSON.stringify({
    edges: result.edges
      .map(({ kind, sourceId, targetId }) => ({ kind, sourceId, targetId }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    nodes: result.nodes.map(({ stableKey }) => stableKey).sort(),
    truncated: result.truncated,
  });
}

export async function benchmarkTraversalAdapters(
  query: TraversalQuery,
  postgresql: GraphTraversal,
  neo4j: GraphTraversal,
  clock: () => number = () => performance.now(),
): Promise<TraversalBenchmark> {
  const postgresStart = clock();
  const postgresqlResult = await postgresql.traverse(query);
  const postgresqlMilliseconds = clock() - postgresStart;
  const neo4jStart = clock();
  const neo4jResult = await neo4j.traverse(query);
  const neo4jMilliseconds = clock() - neo4jStart;
  return {
    equivalent: identity(postgresqlResult) === identity(neo4jResult),
    neo4jMilliseconds,
    neo4jResult,
    postgresqlMilliseconds,
    postgresqlResult,
  };
}
