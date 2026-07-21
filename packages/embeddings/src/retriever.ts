import type { Embedder } from "@intellirepo/ai";

import type { SemanticChunkStore, SemanticSearchResult } from "./embedding-model.js";

export class SemanticRetriever {
  public constructor(
    private readonly store: SemanticChunkStore,
    private readonly embedder: Embedder,
  ) {}

  public async search(
    repositoryId: string,
    query: string,
    limit = 8,
  ): Promise<readonly SemanticSearchResult[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("Semantic search limit must be between 1 and 50");
    }
    const batch = await this.embedder.embed([query]);
    const vector = batch.vectors[0];
    if (vector === undefined) throw new Error("Embedder returned no query vector");
    return this.store.search(repositoryId, vector, limit);
  }
}
