import { execFile as execFileCallback } from "node:child_process";
import { promises as fileSystem } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  createCatalogDatabase,
  migrateCatalogDown,
  migrateCatalogToLatest,
  ProjectionStateCatalog,
  RepositoryCatalog,
  RevisionCatalog,
  ScanJobCatalog,
  type CatalogDatabaseHandle,
} from "@intellirepo/catalog";
import { SCAN_STAGES, type ScanJobSnapshot } from "@intellirepo/contracts";
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
  type RegisteredLocalRepository,
} from "@intellirepo/repository";
import { startPostgresTestContainer, type PostgresTestContainer } from "@intellirepo/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AnalysisStage } from "../analysis/analysis-stage.js";
import { RevisionAnalysis } from "../analysis/revision-analysis.js";
import { PostgresScanJobStore } from "../executor/postgres-scan-job-store.js";
import { ScanExecutor } from "../executor/scan-executor.js";
import { NoOpGraphProjectionStage, type ScanStageHandler } from "../executor/scan-stage.js";
import { CommitRepositoryFactsStage } from "./commit-facts-stage.js";
import { DiscoverRepositoryStage } from "./discover-stage.js";
import { ParseRepositoryStage } from "./parse-stage.js";
import { RepositorySnapshotProvider } from "./repository-snapshot-provider.js";
import { ResolveRepositoryStage } from "./resolve-stage.js";
import { EmbeddingStage } from "../semantic/embedding-stage.js";
import { SemanticSourceBuilder } from "../semantic/semantic-source-builder.js";

const execFile = promisify(execFileCallback);
const describeWithPostgres =
  process.env.RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const migrationFolder = fileURLToPath(new URL("../../../catalog/migrations", import.meta.url));

describeWithPostgres("deterministic indexing pipeline", () => {
  let container: PostgresTestContainer;
  let database: CatalogDatabaseHandle;
  let repositoryRoot: string;
  let registered: RegisteredLocalRepository;
  let snapshotBuilder: RepositorySnapshotBuilder;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    database = createCatalogDatabase(container.connectionUri);
    const migration = await migrateCatalogToLatest(database.database, migrationFolder);
    expect(migration.error).toBeUndefined();

    repositoryRoot = await fileSystem.mkdtemp(join(tmpdir(), "intellirepo-pipeline-"));
    await fileSystem.mkdir(join(repositoryRoot, "src"));
    await fileSystem.mkdir(join(repositoryRoot, "docs"));
    await fileSystem.writeFile(
      join(repositoryRoot, "package.json"),
      JSON.stringify({ name: "pipeline-fixture", scripts: { test: "vitest" } }),
    );
    await fileSystem.writeFile(
      join(repositoryRoot, "src", "alpha.ts"),
      "// Public alpha workflow explains request validation and response behavior.\nexport function alpha(): string { return 'alpha'; }\n",
    );
    await fileSystem.writeFile(
      join(repositoryRoot, "src", "beta.ts"),
      "// Public beta workflow explains request validation and response behavior.\nexport function beta(): string { return 'beta'; }\n",
    );
    await fileSystem.writeFile(
      join(repositoryRoot, "src", "stable.ts"),
      "// Stable workflow explains unchanged validation and response behavior.\nexport function stable(): string { return 'stable'; }\n",
    );
    await fileSystem.writeFile(
      join(repositoryRoot, "docs", "overview.md"),
      "# Overview\n\nThis documentation explains the repository authentication and validation workflow.\n",
    );
    await execFile("git", ["init", "-b", "main", repositoryRoot]);
    await execFile("git", ["-C", repositoryRoot, "add", "."]);
    await execFile("git", [
      "-C",
      repositoryRoot,
      "-c",
      "user.name=IntelliRepo Test",
      "-c",
      "user.email=test@intellirepo.local",
      "commit",
      "-m",
      "fixture",
    ]);
    const policy = new FilePolicy(1_000_000);
    const adapter = new LocalRepositoryAdapter([repositoryRoot], policy);
    registered = await adapter.register(repositoryRoot);
    snapshotBuilder = new RepositorySnapshotBuilder(adapter, new GitChangeDetector(policy));
    await new RepositoryCatalog(database.database).register({
      ...(registered.defaultBranch === undefined
        ? {}
        : { defaultBranch: registered.defaultBranch }),
      displayName: registered.displayName,
      id: registered.id,
      rootPath: registered.rootPath,
    });
  }, 120_000);

  afterAll(async () => {
    if (database !== undefined) {
      await migrateCatalogDown(database.database, migrationFolder);
      await database.destroy();
    }
    if (container !== undefined) await container.stop();
    if (repositoryRoot !== undefined) {
      await fileSystem.rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  async function createScan(revisionId: string, parentRevisionId?: string): Promise<string> {
    const target = await snapshotBuilder.capture({
      ...(parentRevisionId === undefined
        ? {}
        : {
            baseRevision: (
              await database.database
                .selectFrom("revisions")
                .select("commit_sha")
                .where("id", "=", parentRevisionId)
                .executeTakeFirstOrThrow()
            ).commit_sha,
          }),
      repository: registered,
    });
    await new RevisionCatalog(database.database).create({
      commitSha: target.headCommit,
      id: revisionId,
      ...(parentRevisionId === undefined ? {} : { parentRevisionId }),
      repositoryId: registered.id,
      worktreeFingerprint: target.workingTreeFingerprint,
    });
    const scanJobId = `scan-${revisionId}`;
    const now = new Date().toISOString();
    await new ScanJobCatalog(database.database).save({
      attempt: 0,
      completedStages: [],
      createdAt: now,
      degradedReasons: [],
      dispatchMode: "inline",
      dispatchState: "dispatched",
      id: scanJobId,
      repositoryId: registered.id,
      revisionId,
      stageTimings: {},
      state: "QUEUED",
      updatedAt: now,
    } satisfies ScanJobSnapshot);
    return scanJobId;
  }

  async function execute(scanJobId: string): Promise<ScanJobSnapshot> {
    const snapshots = new RepositorySnapshotProvider(database.database, snapshotBuilder);
    const semanticStore = new PostgresSemanticChunkStore(database.database);
    const embedder = {
      embed: (input: readonly string[]) =>
        Promise.resolve({ model: "fixture-embedding", vectors: input.map(() => [1, 0, 0]) }),
    };
    const handlers: readonly ScanStageHandler[] = [
      new DiscoverRepositoryStage(snapshots),
      new ParseRepositoryStage(database.database, snapshots),
      new ResolveRepositoryStage(),
      new CommitRepositoryFactsStage(database.database, snapshots),
      new NoOpGraphProjectionStage(),
      new EmbeddingStage(
        new SemanticSourceBuilder(database.database, snapshots),
        new SemanticProjector(
          semanticStore,
          embedder,
          new CatalogSemanticProjectionStatusWriter(new ProjectionStateCatalog(database.database)),
        ),
      ),
      new AnalysisStage(database.database, new RevisionAnalysis(database.database, snapshots)),
    ];
    expect(handlers.map(({ stage }) => stage)).toEqual(SCAN_STAGES);
    const result = await new ScanExecutor(new PostgresScanJobStore(database.database), handlers, {
      heartbeatIntervalMs: 5_000,
      leaseDurationMs: 30_000,
      owner: `worker-${scanJobId}`,
    }).execute(scanJobId);
    return result.snapshot;
  }

  it("activates an initial scan and incrementally replaces only changed artifacts", async () => {
    const firstScan = await createScan("revision-initial");
    const initial = await execute(firstScan);
    expect(initial.state).toBe("COMPLETED");
    expect(initial.completedStages).toEqual(SCAN_STAGES);
    expect(initial.counts).toMatchObject({
      discoveredArtifacts: 5,
      documentationPages: 1,
      embeddedChunks: 4,
      parsedArtifacts: 4,
    });

    const stableBefore = await database.database
      .selectFrom("entities")
      .innerJoin("source_artifacts", "source_artifacts.id", "entities.owner_artifact_id")
      .select(["entities.id", "entities.stable_key"])
      .where("source_artifacts.path", "=", "src/stable.ts")
      .executeTakeFirstOrThrow();

    await fileSystem.writeFile(
      join(repositoryRoot, "src", "alpha.ts"),
      "// Changed alpha workflow explains authorization and response behavior.\nexport function alphaChanged(): string { return 'changed'; }\n",
    );
    await fileSystem.rm(join(repositoryRoot, "src", "beta.ts"));
    const secondScan = await createScan("revision-incremental", "revision-initial");
    const incremental = await execute(secondScan);
    expect(incremental.state, JSON.stringify(incremental.error)).toBe("COMPLETED");
    expect(incremental.counts).toMatchObject({
      activatedArtifacts: 1,
      deletedArtifacts: 1,
      parsedArtifacts: 1,
    });

    const paths = await database.database
      .selectFrom("source_artifacts")
      .select("path")
      .where("repository_id", "=", registered.id)
      .orderBy("path")
      .execute();
    expect(paths.map(({ path }) => path)).toEqual([
      "docs/overview.md",
      "package.json",
      "src/alpha.ts",
      "src/stable.ts",
    ]);
    const stableAfter = await database.database
      .selectFrom("entities")
      .select(["id", "stable_key"])
      .where("id", "=", stableBefore.id)
      .executeTakeFirstOrThrow();
    expect(stableAfter).toEqual(stableBefore);
    const activeRevision = await database.database
      .selectFrom("revisions")
      .select("id")
      .where("repository_id", "=", registered.id)
      .where("status", "=", "active")
      .executeTakeFirstOrThrow();
    expect(activeRevision.id).toBe("revision-incremental");
    const semanticRevisionIds = await database.database
      .selectFrom("semantic_chunks")
      .select("revision_id")
      .where("repository_id", "=", registered.id)
      .execute();
    expect(new Set(semanticRevisionIds.map(({ revision_id: id }) => id))).toEqual(
      new Set(["revision-incremental"]),
    );
    const reportCount = await database.database
      .selectFrom("impact_reports")
      .select("id")
      .where("target_revision_id", "=", "revision-incremental")
      .execute();
    expect(reportCount).toHaveLength(1);
    await expect(
      new ProjectionStateCatalog(database.database).find(registered.id, "analysis"),
    ).resolves.toMatchObject({ revision_id: "revision-incremental", state: "current" });
  }, 120_000);
});
