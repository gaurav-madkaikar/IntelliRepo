import { fileURLToPath } from "node:url";

import { createScanJobId, type ScanJobSnapshot } from "@intellirepo/contracts";
import { startPostgresTestContainer, type PostgresTestContainer } from "@intellirepo/testkit";
import {
  createConfidence,
  createEntityStableKey,
  createProvenance,
  type EntityFact,
  type RelationshipFact,
} from "@intellirepo/domain";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ArtifactCatalog } from "./artifact-catalog.js";
import { createCatalogDatabase, migrateCatalogDown, migrateCatalogToLatest } from "./database.js";
import type { CatalogDatabaseHandle } from "./database.js";
import { activateFactSet, activateRevisionFacts, stageFactSet } from "./fact-activation.js";
import { enqueueOutboxEvent } from "./outbox.js";
import { ProjectionStateCatalog } from "./projection-state-catalog.js";
import { RepositoryCatalog } from "./repository-catalog.js";
import { RevisionCatalog } from "./revision-catalog.js";
import { ScanJobCatalog } from "./scan-job-catalog.js";

const describeWithDocker = process.env.RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const migrationFolder = fileURLToPath(new URL("../migrations", import.meta.url));

describeWithDocker("catalog integration", () => {
  let container: PostgresTestContainer;
  let handle: CatalogDatabaseHandle;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    handle = createCatalogDatabase(container.connectionUri);
    const migration = await migrateCatalogToLatest(handle.database, migrationFolder);
    expect(migration.error).toBeUndefined();
  });

  afterAll(async () => {
    if (handle !== undefined) await handle.destroy();
    if (container !== undefined) await container.stop();
  });

  async function seedCatalog(suffix: string) {
    const repositoryId = `repository-${suffix}`;
    const revisionId = `revision-${suffix}`;
    const artifactId = `artifact-${suffix}`;
    await new RepositoryCatalog(handle.database).register({
      displayName: `Repository ${suffix}`,
      id: repositoryId,
      rootPath: `/fixtures/${suffix}`,
    });
    await new RevisionCatalog(handle.database).create({
      commitSha: `commit-${suffix}`,
      id: revisionId,
      repositoryId,
      worktreeFingerprint: "clean",
    });
    await new ArtifactCatalog(handle.database).upsert({
      artifactKind: "code",
      contentHash: `hash-${suffix}`,
      id: artifactId,
      language: "typescript",
      path: "src/index.ts",
      repositoryId,
      sizeBytes: 42,
    });

    return { artifactId, repositoryId, revisionId };
  }

  function entityFact(repositoryId: string, revisionId: string): EntityFact {
    const stableKey = createEntityStableKey({
      kind: "function",
      language: "typescript",
      qualifiedName: "src/index.main",
      repositoryId,
    });

    return {
      attributes: { signature: "main(): void" },
      kind: "function",
      language: "typescript",
      name: "main",
      provenance: createProvenance({
        artifactPath: "src/index.ts",
        confidence: createConfidence({ level: "confirmed", reason: "declaration", score: 1 }),
        evidence: "function_declaration",
        extractor: "fixture",
        range: { start: { column: 1, line: 1 }, end: { column: 2, line: 3 } },
        repositoryRevision: revisionId,
      }),
      qualifiedName: "src/index.main",
      stableKey,
    };
  }

  it("migrates the canonical schema and activates staged facts idempotently", async () => {
    const seed = await seedCatalog("activation");
    const entity = entityFact(seed.repositoryId, seed.revisionId);
    const stagingRunId = await stageFactSet(handle.database, {
      ...seed,
      entities: [entity],
      id: "stage-activation",
      relationships: [],
    });

    await activateFactSet(handle.database, stagingRunId);
    await activateFactSet(handle.database, stagingRunId);

    const entities = await handle.database
      .selectFrom("entities")
      .selectAll()
      .where("repository_id", "=", seed.repositoryId)
      .execute();
    const outbox = await handle.database
      .selectFrom("outbox_events")
      .selectAll()
      .where("aggregate_id", "=", seed.repositoryId)
      .execute();

    expect(entities).toHaveLength(1);
    expect(entities[0]?.stable_key).toBe(entity.stableKey);
    expect(outbox).toHaveLength(1);
  });

  it("rolls back replacement when a staged relationship cannot resolve", async () => {
    const seed = await seedCatalog("rollback");
    const existingEntity = entityFact(seed.repositoryId, seed.revisionId);
    const firstStage = await stageFactSet(handle.database, {
      ...seed,
      entities: [existingEntity],
      id: "stage-before-failure",
      relationships: [],
    });
    await activateFactSet(handle.database, firstStage);

    const missingTarget = createEntityStableKey({
      kind: "function",
      language: "typescript",
      qualifiedName: "src/missing.target",
      repositoryId: seed.repositoryId,
    });
    const relationship = {
      attributes: { resolution: "symbol" },
      kind: "CALLS",
      provenance: existingEntity.provenance,
      source: existingEntity.stableKey,
      target: missingTarget,
    } satisfies RelationshipFact;
    const failingStage = await stageFactSet(handle.database, {
      ...seed,
      entities: [],
      id: "stage-failure",
      relationships: [relationship],
    });

    await expect(activateFactSet(handle.database, failingStage)).rejects.toThrow("unresolved");
    const retained = await handle.database
      .selectFrom("entities")
      .select("stable_key")
      .where("repository_id", "=", seed.repositoryId)
      .execute();
    expect(retained).toEqual([{ stable_key: existingEntity.stableKey }]);
  });

  it("activates cross-artifact relationships in one revision and preserves unchanged facts", async () => {
    const seed = await seedCatalog("revision-activation");
    const secondArtifactId = "artifact-revision-activation-service";
    await new ArtifactCatalog(handle.database).upsert({
      artifactKind: "code",
      contentHash: "hash-service",
      id: secondArtifactId,
      language: "java",
      path: "src/Service.java",
      repositoryId: seed.repositoryId,
      sizeBytes: 84,
    });
    const caller = entityFact(seed.repositoryId, seed.revisionId);
    const target = {
      ...entityFact(seed.repositoryId, seed.revisionId),
      language: "java" as const,
      name: "serve",
      qualifiedName: "src.Service.serve",
      stableKey: createEntityStableKey({
        kind: "function",
        language: "java",
        qualifiedName: "src.Service.serve",
        repositoryId: seed.repositoryId,
      }),
    };
    const relationship = {
      attributes: { resolution: "symbol" },
      kind: "CALLS",
      provenance: caller.provenance,
      source: caller.stableKey,
      target: target.stableKey,
    } satisfies RelationshipFact;
    const callerStage = await stageFactSet(handle.database, {
      ...seed,
      entities: [caller],
      id: "stage-revision-caller",
      relationships: [relationship],
    });
    const targetStage = await stageFactSet(handle.database, {
      artifactId: secondArtifactId,
      entities: [target],
      id: "stage-revision-target",
      relationships: [],
      repositoryId: seed.repositoryId,
      revisionId: seed.revisionId,
    });

    await activateRevisionFacts(handle.database, {
      repositoryId: seed.repositoryId,
      revisionId: seed.revisionId,
      // Deliberately stage the caller first: entity insertion must make order irrelevant.
      stagingRunIds: [callerStage, targetStage],
    });

    const storedRelationships = await handle.database
      .selectFrom("relationships")
      .select("kind")
      .where("repository_id", "=", seed.repositoryId)
      .execute();
    expect(storedRelationships).toEqual([{ kind: "CALLS" }]);
  });

  it("applies rename and deletion changes without rewriting unchanged artifacts", async () => {
    const seed = await seedCatalog("rename-delete");
    const unchangedArtifactId = "artifact-rename-delete-unchanged";
    await new ArtifactCatalog(handle.database).upsert({
      artifactKind: "code",
      contentHash: "unchanged-hash",
      id: unchangedArtifactId,
      language: "typescript",
      path: "src/unchanged.ts",
      repositoryId: seed.repositoryId,
      sizeBytes: 20,
    });
    const original = entityFact(seed.repositoryId, seed.revisionId);
    const unchanged = {
      ...original,
      name: "unchanged",
      qualifiedName: "src/unchanged.unchanged",
      stableKey: createEntityStableKey({
        kind: "function",
        language: "typescript",
        qualifiedName: "src/unchanged.unchanged",
        repositoryId: seed.repositoryId,
      }),
    };
    const originalStage = await stageFactSet(handle.database, {
      ...seed,
      entities: [original],
      id: "stage-rename-delete-original",
      relationships: [],
    });
    const unchangedStage = await stageFactSet(handle.database, {
      artifactId: unchangedArtifactId,
      entities: [unchanged],
      id: "stage-rename-delete-unchanged",
      relationships: [],
      repositoryId: seed.repositoryId,
      revisionId: seed.revisionId,
    });
    await activateRevisionFacts(handle.database, {
      repositoryId: seed.repositoryId,
      revisionId: seed.revisionId,
      stagingRunIds: [originalStage, unchangedStage],
    });
    const unchangedBefore = await handle.database
      .selectFrom("entities")
      .select(["id", "last_seen_revision_id"])
      .where("stable_key", "=", unchanged.stableKey)
      .executeTakeFirstOrThrow();

    const nextRevisionId = "revision-rename-delete-next";
    await new RevisionCatalog(handle.database).create({
      commitSha: "commit-rename-delete-next",
      id: nextRevisionId,
      parentRevisionId: seed.revisionId,
      repositoryId: seed.repositoryId,
      worktreeFingerprint: "clean-next",
    });
    const renamedArtifactId = "artifact-rename-delete-renamed";
    await new ArtifactCatalog(handle.database).upsert({
      artifactKind: "code",
      contentHash: "renamed-hash",
      id: renamedArtifactId,
      language: "typescript",
      path: "src/renamed.ts",
      repositoryId: seed.repositoryId,
      sizeBytes: 44,
    });
    const renamed = {
      ...entityFact(seed.repositoryId, nextRevisionId),
      name: "renamed",
      qualifiedName: "src/renamed.main",
      stableKey: createEntityStableKey({
        kind: "function",
        language: "typescript",
        qualifiedName: "src/renamed.main",
        repositoryId: seed.repositoryId,
      }),
    };
    const renamedStage = await stageFactSet(handle.database, {
      artifactId: renamedArtifactId,
      entities: [renamed],
      id: "stage-rename-delete-renamed",
      relationships: [],
      repositoryId: seed.repositoryId,
      revisionId: nextRevisionId,
    });

    await activateRevisionFacts(handle.database, {
      deletedArtifactIds: [seed.artifactId],
      repositoryId: seed.repositoryId,
      revisionId: nextRevisionId,
      stagingRunIds: [renamedStage],
    });

    const paths = await handle.database
      .selectFrom("source_artifacts")
      .select("path")
      .where("repository_id", "=", seed.repositoryId)
      .orderBy("path")
      .execute();
    const unchangedAfter = await handle.database
      .selectFrom("entities")
      .select(["id", "last_seen_revision_id"])
      .where("stable_key", "=", unchanged.stableKey)
      .executeTakeFirstOrThrow();
    expect(paths).toEqual([{ path: "src/renamed.ts" }, { path: "src/unchanged.ts" }]);
    expect(unchangedAfter).toEqual(unchangedBefore);
  });

  it("deduplicates outbox events by idempotency key", async () => {
    const inserted = await enqueueOutboxEvent(handle.database, {
      aggregateId: "aggregate-1",
      eventType: "fixture.created",
      idempotencyKey: "fixture:1",
      payload: { value: 1 },
    });
    const duplicate = await enqueueOutboxEvent(handle.database, {
      aggregateId: "aggregate-1",
      eventType: "fixture.created",
      idempotencyKey: "fixture:1",
      payload: { value: 2 },
    });

    expect(inserted).toBe(true);
    expect(duplicate).toBe(false);
  });

  it("persists scan snapshots and attempts", async () => {
    const seed = await seedCatalog("scan-job");
    const request = { repositoryId: seed.repositoryId, revisionId: seed.revisionId };
    const snapshot = {
      attempt: 1,
      completedStages: [],
      createdAt: "2026-07-15T00:00:00.000Z",
      currentStage: "DISCOVERING",
      degradedReasons: [],
      dispatchMode: "bullmq",
      dispatchState: "pending",
      id: createScanJobId(request),
      ...request,
      stageTimings: { DISCOVERING: { startedAt: "2026-07-15T00:00:01.000Z" } },
      startedAt: "2026-07-15T00:00:01.000Z",
      state: "RUNNING",
      updatedAt: "2026-07-15T00:00:01.000Z",
    } satisfies ScanJobSnapshot;
    const catalog = new ScanJobCatalog(handle.database);

    await catalog.save(snapshot);

    await expect(catalog.findById(snapshot.id)).resolves.toEqual(snapshot);
    const attempts = await handle.database
      .selectFrom("job_attempts")
      .select("attempt")
      .where("scan_job_id", "=", snapshot.id)
      .execute();
    expect(attempts).toEqual([{ attempt: 1 }]);
  });

  it("keeps a projection failure visible for later retry", async () => {
    const seed = await seedCatalog("projection-delay");
    const catalog = new ProjectionStateCatalog(handle.database);

    await catalog.save({
      error: { message: "Neo4j unavailable", recoverable: true },
      projection: "neo4j",
      repositoryId: seed.repositoryId,
      revisionId: seed.revisionId,
      state: "delayed",
    });

    await expect(catalog.find(seed.repositoryId, "neo4j")).resolves.toMatchObject({
      error: { message: "Neo4j unavailable", recoverable: true },
      revision_id: seed.revisionId,
      state: "delayed",
    });
  });

  it("rolls the development schema down", async () => {
    const migration = await migrateCatalogDown(handle.database, migrationFolder);
    expect(migration.error).toBeUndefined();
    const result = await sql<{ table_name: string | null }>`
      SELECT to_regclass('public.repositories')::text AS table_name
    `.execute(handle.database);
    expect(result.rows[0]?.table_name).toBeNull();
  });
});
