import type { Embedder } from "@intellirepo/ai";

import { createSemanticChunks } from "./chunker.js";
import type { SemanticChunkStore, SemanticSource, StoredSemanticChunk } from "./embedding-model.js";

export interface SemanticProjectionInput {
  readonly removedSourceIds?: readonly string[];
  readonly repositoryId: string;
  readonly revisionId: string;
  readonly sources: readonly SemanticSource[];
}

export interface SemanticProjectionResult {
  readonly embedded: number;
  readonly eligible: number;
  readonly model?: string;
  readonly removed: number;
  readonly retained: number;
  readonly state: "current" | "degraded" | "disabled";
  readonly statusReason?: string;
}

export interface SemanticProjectionStatusWriter {
  record(input: {
    readonly repositoryId: string;
    readonly requestedRevisionId: string;
    readonly result: SemanticProjectionResult;
  }): Promise<void>;
}

export class SemanticProjector {
  public constructor(
    private readonly store: SemanticChunkStore,
    private readonly embedder?: Embedder,
    private readonly statusWriter?: SemanticProjectionStatusWriter,
  ) {}

  private async complete(
    input: SemanticProjectionInput,
    result: SemanticProjectionResult,
  ): Promise<SemanticProjectionResult> {
    await this.statusWriter?.record({
      repositoryId: input.repositoryId,
      requestedRevisionId: input.revisionId,
      result,
    });
    return result;
  }

  public async project(input: SemanticProjectionInput): Promise<SemanticProjectionResult> {
    const chunks = input.sources.flatMap((source) => createSemanticChunks(source));
    if (this.embedder === undefined) {
      return this.complete(input, {
        embedded: 0,
        eligible: chunks.length,
        removed: 0,
        retained: 0,
        state: "disabled",
        statusReason: "Embedding adapter unavailable; semantic projection skipped",
      });
    }
    const existing = await this.store.list(input.repositoryId);
    const existingById = new Map(existing.map((chunk) => [chunk.id, chunk]));
    let modelIdentity: string;
    try {
      modelIdentity = (await this.embedder.embed([])).model;
    } catch (error) {
      return this.complete(input, {
        embedded: 0,
        eligible: chunks.length,
        removed: 0,
        retained: 0,
        state: "degraded",
        statusReason: `Embedding model unavailable; previous semantic projection retained: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    const changed = chunks.filter((chunk) => {
      const previous = existingById.get(chunk.id);
      return previous?.checksum !== chunk.checksum || previous.embeddingModel !== modelIdentity;
    });
    const retained = chunks.length - changed.length;
    let batch: Awaited<ReturnType<Embedder["embed"]>>;
    if (changed.length === 0) {
      batch = {
        model:
          existing.find(({ embeddingModel }) => embeddingModel !== undefined)?.embeddingModel ??
          modelIdentity,
        vectors: [],
      };
    } else {
      try {
        batch = await this.embedder.embed(changed.map(({ content }) => content));
      } catch (error) {
        return this.complete(input, {
          embedded: 0,
          eligible: chunks.length,
          removed: 0,
          retained,
          state: "degraded",
          statusReason: `Embedding failed; previous semantic projection retained: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    if (batch.vectors.length !== changed.length)
      throw new Error("Embedder returned wrong vector count");
    const stored: StoredSemanticChunk[] = changed.map((chunk, index) => ({
      ...chunk,
      embeddingModel: batch.model,
      revisionId: input.revisionId,
      vector: batch.vectors[index] as readonly number[],
    }));
    await this.store.upsert(input.repositoryId, stored);
    const retainedIds = chunks.filter((chunk) => !changed.includes(chunk)).map(({ id }) => id);
    await this.store.retag(input.repositoryId, retainedIds, input.revisionId);

    const activeIds = new Set(chunks.map(({ id }) => id));
    const updatedParents = new Set(input.sources.map(({ sourceId }) => sourceId));
    const removedParents = new Set(input.removedSourceIds ?? []);
    const staleIds = existing
      .filter((chunk) => {
        const parent = chunk.metadata.parentSourceId;
        return (
          removedParents.has(parent) || (updatedParents.has(parent) && !activeIds.has(chunk.id))
        );
      })
      .map(({ id }) => id);
    await this.store.delete(input.repositoryId, staleIds);
    return this.complete(input, {
      embedded: changed.length,
      eligible: chunks.length,
      model: batch.model,
      removed: staleIds.length,
      retained,
      state: "current",
    });
  }
}
