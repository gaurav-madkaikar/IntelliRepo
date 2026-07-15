import { randomUUID } from "node:crypto";

import type { Kysely, Selectable } from "kysely";

import type { CatalogDatabase, RevisionTable } from "./database-types.js";

export interface CreateRevisionInput {
  readonly commitSha: string;
  readonly id?: string;
  readonly parentRevisionId?: string;
  readonly repositoryId: string;
  readonly status?: "active" | "indexing" | "superseded";
  readonly worktreeFingerprint: string;
}

export type RevisionRecord = Selectable<RevisionTable>;

export class RevisionCatalog {
  public constructor(private readonly database: Kysely<CatalogDatabase>) {}

  public async create(input: CreateRevisionInput): Promise<RevisionRecord> {
    return this.database
      .insertInto("revisions")
      .values({
        commit_sha: input.commitSha,
        id: input.id ?? randomUUID(),
        parent_revision_id: input.parentRevisionId ?? null,
        repository_id: input.repositoryId,
        status: input.status ?? "indexing",
        worktree_fingerprint: input.worktreeFingerprint,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["repository_id", "commit_sha", "worktree_fingerprint"])
          .doUpdateSet({ status: input.status ?? "indexing" }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
