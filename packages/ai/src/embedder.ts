export interface EmbeddingBatch {
  readonly model: string;
  readonly vectors: readonly (readonly number[])[];
}

export interface Embedder {
  embed(input: readonly string[]): Promise<EmbeddingBatch>;
}
