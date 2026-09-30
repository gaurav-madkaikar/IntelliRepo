import type { Embedder } from "@intellirepo/ai";
import { ProjectionStateCatalog, type CatalogDatabase } from "@intellirepo/catalog";
import type { ApplicationConfig } from "@intellirepo/contracts";
import {
  CatalogSemanticProjectionStatusWriter,
  PostgresSemanticChunkStore,
  SemanticProjector,
} from "@intellirepo/embeddings";
import {
  FilePolicy,
  GitChangeDetector,
  LocalRepositoryAdapter,
  RepositorySnapshotBuilder,
} from "@intellirepo/repository";
import type { Kysely } from "kysely";

import { AnalysisStage } from "../analysis/analysis-stage.js";
import { RevisionAnalysis } from "../analysis/revision-analysis.js";
import { PostgresScanJobStore } from "../executor/postgres-scan-job-store.js";
import { ScanExecutor } from "../executor/scan-executor.js";
import { NoOpGraphProjectionStage } from "../executor/scan-stage.js";
import { CommitRepositoryFactsStage } from "../pipeline/commit-facts-stage.js";
import { DiscoverRepositoryStage } from "../pipeline/discover-stage.js";
import { ParseRepositoryStage } from "../pipeline/parse-stage.js";
import { RepositorySnapshotProvider } from "../pipeline/repository-snapshot-provider.js";
import { ResolveRepositoryStage } from "../pipeline/resolve-stage.js";
import { EmbeddingStage } from "../semantic/embedding-stage.js";
import { SemanticSourceBuilder } from "../semantic/semantic-source-builder.js";

export interface CreateIndexingExecutorInput {
  readonly config: ApplicationConfig;
  readonly database: Kysely<CatalogDatabase>;
  readonly embedder?: Embedder;
  readonly owner: string;
}

export function createIndexingExecutor(input: CreateIndexingExecutorInput): ScanExecutor {
  const policy = new FilePolicy(input.config.maxFileBytes);
  const adapter = new LocalRepositoryAdapter(input.config.repositoryAllowedRoots, policy);
  const snapshots = new RepositorySnapshotProvider(
    input.database,
    new RepositorySnapshotBuilder(adapter, new GitChangeDetector(policy)),
  );
  const semanticStore = new PostgresSemanticChunkStore(input.database);
  return new ScanExecutor(
    new PostgresScanJobStore(input.database),
    [
      new DiscoverRepositoryStage(snapshots),
      new ParseRepositoryStage(input.database, snapshots),
      new ResolveRepositoryStage(),
      new CommitRepositoryFactsStage(input.database, snapshots),
      new NoOpGraphProjectionStage(),
      new EmbeddingStage(
        new SemanticSourceBuilder(input.database, snapshots),
        new SemanticProjector(
          semanticStore,
          input.embedder,
          new CatalogSemanticProjectionStatusWriter(new ProjectionStateCatalog(input.database)),
        ),
      ),
      new AnalysisStage(input.database, new RevisionAnalysis(input.database, snapshots)),
    ],
    {
      heartbeatIntervalMs: input.config.scanHeartbeatIntervalMs,
      leaseDurationMs: input.config.scanLeaseDurationMs,
      owner: input.owner,
    },
  );
}
