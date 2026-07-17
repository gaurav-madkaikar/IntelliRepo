import type { GraphTraversal, TraversalQuery, TraversalResult } from "./traversal.js";

export interface ProjectionState {
  readonly revision_id: string | null;
  readonly state: string;
}

export interface ProjectionStateReader {
  find(repositoryId: string, projection: string): Promise<ProjectionState | undefined>;
}

export class ProjectionAwareTraversal implements GraphTraversal {
  public constructor(
    private readonly postgres: GraphTraversal,
    private readonly projectionStates: ProjectionStateReader,
    private readonly neo4j?: GraphTraversal,
  ) {}

  public async traverse(query: TraversalQuery): Promise<TraversalResult> {
    const state = await this.projectionStates.find(query.repositoryId, "neo4j");
    if (
      this.neo4j !== undefined &&
      state?.state === "current" &&
      state.revision_id === query.revisionId
    ) {
      try {
        return await this.neo4j.traverse(query);
      } catch (error) {
        return this.postgresFallback(
          query,
          "failed",
          `Neo4j traversal failed: ${error instanceof Error ? error.message : String(error)}`,
          state.revision_id,
        );
      }
    }

    const disabled = this.neo4j === undefined || state === undefined;
    return this.postgresFallback(
      query,
      disabled ? "disabled" : "stale",
      disabled
        ? "Neo4j projection is disabled; using canonical PostgreSQL traversal"
        : `Neo4j projection is ${state.state} at ${state.revision_id ?? "no revision"}`,
      state?.revision_id ?? undefined,
    );
  }

  private async postgresFallback(
    query: TraversalQuery,
    state: "disabled" | "failed" | "stale",
    degradedReason: string,
    projectedRevisionId?: string,
  ): Promise<TraversalResult> {
    const result = await this.postgres.traverse(query);
    return {
      ...result,
      projection: {
        degradedReason,
        ...(projectedRevisionId === undefined ? {} : { projectedRevisionId }),
        requestedRevisionId: query.revisionId,
        state,
      },
    };
  }
}
