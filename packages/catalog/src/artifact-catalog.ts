import { randomUUID } from "node:crypto";

import type { Kysely, Selectable } from "kysely";

import type { CatalogDatabase, SourceArtifactTable } from "./database-types.js";

export interface UpsertArtifactInput {
  readonly artifactKind: string;
  readonly contentHash: string;
  readonly id?: string;
  readonly language?: string;
  readonly path: string;
  readonly repositoryId: string;
  readonly sizeBytes: number;
}

export type SourceArtifactRecord = Selectable<SourceArtifactTable>;

export class ArtifactCatalog {
  public constructor(private readonly database: Kysely<CatalogDatabase>) {}

  public upsert(input: UpsertArtifactInput): Promise<SourceArtifactRecord> {
    return this.database
      .insertInto("source_artifacts")
      .values({
        active_revision_id: null,
        artifact_kind: input.artifactKind,
        content_hash: input.contentHash,
        id: input.id ?? randomUUID(),
        language: input.language ?? null,
        last_indexed_at: null,
        path: input.path,
        repository_id: input.repositoryId,
        size_bytes: input.sizeBytes,
      })
      .onConflict((conflict) =>
        conflict.columns(["repository_id", "path"]).doUpdateSet({
          artifact_kind: input.artifactKind,
          content_hash: input.contentHash,
          language: input.language ?? null,
          size_bytes: input.sizeBytes,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
