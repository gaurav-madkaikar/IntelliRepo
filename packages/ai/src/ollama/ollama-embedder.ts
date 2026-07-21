import type { Embedder, EmbeddingBatch } from "../embedder.js";
import { OllamaClient } from "./ollama-client.js";

interface OllamaEmbeddingResponse {
  readonly embeddings?: readonly (readonly number[])[];
  readonly model?: string;
}

export class OllamaEmbedder implements Embedder {
  public constructor(
    private readonly client: OllamaClient,
    private readonly model: string,
  ) {}

  public async embed(input: readonly string[]): Promise<EmbeddingBatch> {
    if (input.length === 0) return { model: this.model, vectors: [] };
    const response = await this.client.post<OllamaEmbeddingResponse>("/api/embed", {
      input,
      model: this.model,
      truncate: true,
    });
    const vectors = response.embeddings;
    if (
      vectors === undefined ||
      vectors.length !== input.length ||
      vectors.some(
        (vector) => vector.length === 0 || vector.some((value) => !Number.isFinite(value)),
      )
    ) {
      throw new Error("Ollama returned an invalid embedding batch");
    }
    return { model: response.model ?? this.model, vectors };
  }
}
