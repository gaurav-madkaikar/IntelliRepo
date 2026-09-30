import type { CatalogDatabase } from "@intellirepo/catalog";
import { sql, type Kysely } from "kysely";

import type {
  SemanticChunkStore,
  SemanticSearchResult,
  StoredSemanticChunk,
} from "./embedding-model.js";

function jsonObject(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function vectorLiteral(vector: readonly number[]): string {
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding vector must contain finite values");
  }
  return `'[${vector.join(",")}]'::vector`;
}

export class PostgresSemanticChunkStore implements SemanticChunkStore {
  public constructor(private readonly database: Kysely<CatalogDatabase>) {}

  public async list(repositoryId: string): Promise<readonly StoredSemanticChunk[]> {
    const rows = await this.database
      .selectFrom("semantic_chunks")
      .select([
        "checksum",
        "id",
        "metadata",
        "redacted_content",
        "revision_id",
        "source_id",
        "source_kind",
      ])
      .where("repository_id", "=", repositoryId)
      .execute();
    return rows.map((row) => {
      const embeddingModel = row.metadata.embeddingModel;
      return {
        checksum: row.checksum,
        content: row.redacted_content,
        ...(typeof embeddingModel === "string" ? { embeddingModel } : {}),
        id: row.id,
        metadata: row.metadata as StoredSemanticChunk["metadata"],
        revisionId: row.revision_id,
        sourceId: row.source_id,
        sourceKind: row.source_kind as StoredSemanticChunk["sourceKind"],
      };
    });
  }

  public async upsert(repositoryId: string, chunks: readonly StoredSemanticChunk[]): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      for (const chunk of chunks) {
        if (chunk.vector === undefined)
          throw new Error("Cannot persist a semantic chunk without a vector");
        const metadata = { ...chunk.metadata, embeddingModel: chunk.embeddingModel };
        await transaction
          .insertInto("semantic_chunks")
          .values({
            checksum: chunk.checksum,
            embedding: sql.raw(vectorLiteral(chunk.vector)),
            id: chunk.id,
            metadata: jsonObject(metadata),
            redacted_content: chunk.content,
            repository_id: repositoryId,
            revision_id: chunk.revisionId,
            source_id: chunk.sourceId,
            source_kind: chunk.sourceKind,
          })
          .onConflict((conflict) =>
            conflict.column("id").doUpdateSet({
              checksum: chunk.checksum,
              embedding: sql.raw(vectorLiteral(chunk.vector as readonly number[])),
              metadata: jsonObject(metadata),
              redacted_content: chunk.content,
              revision_id: chunk.revisionId,
            }),
          )
          .execute();
      }
    });
  }

  public async retag(
    repositoryId: string,
    chunkIds: readonly string[],
    revisionId: string,
  ): Promise<void> {
    if (chunkIds.length === 0) return;
    await this.database
      .updateTable("semantic_chunks")
      .set({ revision_id: revisionId })
      .where("repository_id", "=", repositoryId)
      .where("id", "in", [...chunkIds])
      .execute();
  }

  public async delete(repositoryId: string, chunkIds: readonly string[]): Promise<void> {
    if (chunkIds.length === 0) return;
    await this.database
      .deleteFrom("semantic_chunks")
      .where("repository_id", "=", repositoryId)
      .where("id", "in", [...chunkIds])
      .execute();
  }

  public async search(
    repositoryId: string,
    vector: readonly number[],
    limit: number,
    revisionId?: string,
  ): Promise<readonly SemanticSearchResult[]> {
    const queryVector = sql.raw(vectorLiteral(vector));
    const result = await sql<{
      checksum: string;
      id: string;
      metadata: Record<string, unknown>;
      redacted_content: string;
      revision_id: string;
      similarity: number;
      source_id: string;
      source_kind: string;
    }>`
      SELECT id, revision_id, source_kind, source_id, checksum, redacted_content, metadata,
             1 - (embedding <=> ${queryVector}) AS similarity
      FROM semantic_chunks
      WHERE repository_id = ${repositoryId}
        AND embedding IS NOT NULL
        AND (${revisionId ?? null}::text IS NULL OR revision_id = ${revisionId ?? null})
      ORDER BY embedding <=> ${queryVector}
      LIMIT ${limit}
    `.execute(this.database);
    return result.rows.map((row) => {
      const embeddingModel = row.metadata.embeddingModel;
      return {
        chunk: {
          checksum: row.checksum,
          content: row.redacted_content,
          ...(typeof embeddingModel === "string" ? { embeddingModel } : {}),
          id: row.id,
          metadata: row.metadata as StoredSemanticChunk["metadata"],
          revisionId: row.revision_id,
          sourceId: row.source_id,
          sourceKind: row.source_kind as StoredSemanticChunk["sourceKind"],
        },
        similarity: Number(row.similarity),
      };
    });
  }
}
