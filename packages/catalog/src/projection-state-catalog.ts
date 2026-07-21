import type { Kysely, Selectable } from "kysely";

import type { CatalogDatabase, ProjectionStateTable } from "./database-types.js";

export type ProjectionStatus =
  "current" | "delayed" | "disabled" | "failed" | "pending" | "projecting" | "stale";

export interface SaveProjectionStateInput {
  readonly error?: Readonly<Record<string, unknown>>;
  readonly projection: string;
  readonly repositoryId: string;
  readonly revisionId?: string;
  readonly state: ProjectionStatus;
}

export type ProjectionStateRecord = Selectable<ProjectionStateTable>;

export class ProjectionStateCatalog {
  public constructor(private readonly database: Kysely<CatalogDatabase>) {}

  public save(input: SaveProjectionStateInput): Promise<ProjectionStateRecord> {
    const values = {
      error: input.error === undefined ? null : { ...input.error },
      projection: input.projection,
      repository_id: input.repositoryId,
      revision_id: input.revisionId ?? null,
      state: input.state,
      updated_at: new Date(),
    } as const;

    return this.database
      .insertInto("projection_states")
      .values(values)
      .onConflict((conflict) =>
        conflict.columns(["repository_id", "projection"]).doUpdateSet({
          error: values.error,
          revision_id: values.revision_id,
          state: values.state,
          updated_at: values.updated_at,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  public find(
    repositoryId: string,
    projection: string,
  ): Promise<ProjectionStateRecord | undefined> {
    return this.database
      .selectFrom("projection_states")
      .selectAll()
      .where("repository_id", "=", repositoryId)
      .where("projection", "=", projection)
      .executeTakeFirst();
  }
}
