export type SemanticSourceKind = "documentation" | "source";

export interface SemanticSource {
  readonly artifactId?: string;
  readonly artifactKind?: "build" | "code" | "configuration" | "documentation" | "test";
  readonly chunkKind?: "documentation-section" | "source-region";
  readonly content: string;
  readonly contentHash?: string;
  readonly endLine?: number;
  readonly generated?: boolean;
  readonly language?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly path: string;
  readonly repositoryId?: string;
  readonly revisionId?: string;
  readonly sourceId: string;
  readonly sourceKind: SemanticSourceKind;
  readonly startLine?: number;
}

export interface SemanticChunk {
  readonly checksum: string;
  readonly content: string;
  readonly endLine?: number;
  readonly id: string;
  readonly metadata: Readonly<Record<string, unknown>> & {
    readonly eligibilityReason: string;
    readonly parentSourceId: string;
    readonly path: string;
  };
  readonly sourceId: string;
  readonly sourceKind: SemanticSourceKind;
  readonly startLine?: number;
}

export interface StoredSemanticChunk extends SemanticChunk {
  readonly embeddingModel?: string;
  readonly revisionId: string;
  readonly vector?: readonly number[];
}

export interface SemanticSearchResult {
  readonly chunk: StoredSemanticChunk;
  readonly similarity: number;
}

export interface SemanticChunkStore {
  delete(repositoryId: string, chunkIds: readonly string[]): Promise<void>;
  list(repositoryId: string): Promise<readonly StoredSemanticChunk[]>;
  retag(repositoryId: string, chunkIds: readonly string[], revisionId: string): Promise<void>;
  search(
    repositoryId: string,
    vector: readonly number[],
    limit: number,
    revisionId?: string,
  ): Promise<readonly SemanticSearchResult[]>;
  upsert(repositoryId: string, chunks: readonly StoredSemanticChunk[]): Promise<void>;
}
