import { fileURLToPath } from "node:url";

import { type ScanJobSnapshot } from "@intellirepo/contracts";
import { startPostgresTestContainer, type PostgresTestContainer } from "@intellirepo/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCatalogDatabase, migrateCatalogToLatest } from "./database.js";
import type { CatalogDatabaseHandle } from "./database.js";
import {
  claimOutboxEvents,
  enqueueOutboxEvent,
  markOutboxEventPublished,
  releaseOutboxEvent,
} from "./outbox.js";
import { RepositoryCatalog } from "./repository-catalog.js";
import { RevisionCatalog } from "./revision-catalog.js";
import { ScanJobCatalog } from "./scan-job-catalog.js";

const describeWithDocker = process.env.RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const migrationFolder = fileURLToPath(new URL("../migrations", import.meta.url));

describeWithDocker("runtime state catalog", () => {
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

  async function seed(suffix: string) {
    const repositoryId = `runtime-repository-${suffix}`;
    const revisionId = `runtime-revision-${suffix}`;
    await new RepositoryCatalog(handle.database).register({
      displayName: suffix,
      id: repositoryId,
      rootPath: `/runtime/${suffix}`,
    });
    await new RevisionCatalog(handle.database).create({
      commitSha: `commit-${suffix}`,
      id: revisionId,
      repositoryId,
      worktreeFingerprint: `fingerprint-${suffix}`,
    });
    return { repositoryId, revisionId };
  }

  it("serializes scan leases and permits stale-owner recovery", async () => {
    const identity = await seed("lease");
    const snapshot = {
      ...identity,
      attempt: 0,
      completedStages: [],
      createdAt: "2026-07-21T10:00:00.000Z",
      degradedReasons: [],
      dispatchMode: "bullmq",
      dispatchState: "dispatched",
      id: "scan-runtime-lease",
      stageTimings: {},
      state: "QUEUED",
      updatedAt: "2026-07-21T10:00:00.000Z",
    } satisfies ScanJobSnapshot;
    const catalog = new ScanJobCatalog(handle.database);
    await catalog.save(snapshot);
    const running = {
      ...snapshot,
      attempt: 1,
      currentStage: "DISCOVERING",
      stageTimings: { DISCOVERING: { startedAt: "2026-07-21T10:00:01.000Z" } },
      startedAt: "2026-07-21T10:00:01.000Z",
      state: "RUNNING",
      updatedAt: "2026-07-21T10:00:01.000Z",
    } satisfies ScanJobSnapshot;
    await expect(
      catalog.transition(running, { currentStage: null, state: "QUEUED" }),
    ).resolves.toBe(true);
    await expect(
      catalog.transition(running, { currentStage: null, state: "QUEUED" }),
    ).resolves.toBe(false);

    const acquiredAt = new Date("2026-07-21T10:00:01.000Z");
    await expect(catalog.acquireLease(snapshot.id, "worker-a", 30_000, acquiredAt)).resolves.toBe(
      true,
    );
    await expect(catalog.acquireLease(snapshot.id, "worker-b", 30_000, acquiredAt)).resolves.toBe(
      false,
    );
    await expect(
      catalog.acquireLease(snapshot.id, "worker-b", 30_000, new Date("2026-07-21T10:00:32.000Z")),
    ).resolves.toBe(true);
    await expect(catalog.releaseLease(snapshot.id, "worker-a")).resolves.toBe(false);
    await expect(catalog.releaseLease(snapshot.id, "worker-b")).resolves.toBe(true);
  });

  it("claims, releases, retries, and publishes outbox events once", async () => {
    const identity = await seed("outbox");
    const now = new Date("2026-07-21T10:00:00.000Z");
    await enqueueOutboxEvent(handle.database, {
      aggregateId: identity.repositoryId,
      availableAt: now,
      eventType: "scan.requested",
      idempotencyKey: "scan-runtime-outbox",
      payload: { scanJobId: "scan-runtime-outbox" },
    });

    const first = await claimOutboxEvents(handle.database, {
      eventType: "scan.requested",
      now,
      owner: "dispatcher-a",
    });
    expect(first).toHaveLength(1);
    expect(first[0]?.publishAttempt).toBe(1);
    await expect(
      claimOutboxEvents(handle.database, {
        eventType: "scan.requested",
        now,
        owner: "dispatcher-b",
      }),
    ).resolves.toEqual([]);

    const event = first[0];
    expect(event).toBeDefined();
    if (event === undefined) return;
    const retryAt = new Date("2026-07-21T10:00:05.000Z");
    await expect(
      releaseOutboxEvent(handle.database, {
        error: { message: "Redis unavailable" },
        id: event.id,
        owner: "dispatcher-a",
        retryAt,
      }),
    ).resolves.toBe(true);
    await expect(
      claimOutboxEvents(handle.database, {
        eventType: "scan.requested",
        now: new Date("2026-07-21T10:00:04.000Z"),
        owner: "dispatcher-b",
      }),
    ).resolves.toEqual([]);
    const retried = await claimOutboxEvents(handle.database, {
      eventType: "scan.requested",
      now: retryAt,
      owner: "dispatcher-b",
    });
    expect(retried[0]?.publishAttempt).toBe(2);
    await expect(
      markOutboxEventPublished(handle.database, event.id, "dispatcher-b", retryAt),
    ).resolves.toBe(true);
    await expect(
      claimOutboxEvents(handle.database, {
        eventType: "scan.requested",
        now: retryAt,
        owner: "dispatcher-c",
      }),
    ).resolves.toEqual([]);
  });

  it("persists durable question and documentation review payloads", async () => {
    const identity = await seed("durable-product-state");
    const other = await seed("other-product-state");
    await expect(
      handle.database
        .insertInto("question_tasks")
        .values({
          error: null,
          id: "cross-repository-question",
          question: "This revision belongs to another repository",
          repository_id: identity.repositoryId,
          result: null,
          revision_id: other.revisionId,
          state: "queued",
        })
        .execute(),
    ).rejects.toThrow();
    await handle.database
      .insertInto("question_tasks")
      .values({
        error: null,
        id: "question-task-1",
        question: "Where is authentication configured?",
        repository_id: identity.repositoryId,
        result: null,
        revision_id: identity.revisionId,
        state: "queued",
      })
      .execute();
    await handle.database
      .insertInto("documentation_reviews")
      .values({
        applied_at: null,
        diff: "diff",
        explanation: { reason: "deterministic facts" },
        finding_id: null,
        id: "review-1",
        manifest: { entityKeys: ["entity-1"] },
        original_checksum: "checksum-1",
        proposed_markdown: "# Authentication",
        repository_id: identity.repositoryId,
        request: { kind: "module" },
        revision_id: identity.revisionId,
        state: "pending",
        target_path: "docs/authentication.md",
      })
      .execute();

    await expect(
      handle.database
        .selectFrom("question_tasks")
        .select(["question", "state"])
        .where("id", "=", "question-task-1")
        .executeTakeFirst(),
    ).resolves.toEqual({ question: "Where is authentication configured?", state: "queued" });
    await expect(
      handle.database
        .selectFrom("documentation_reviews")
        .select(["original_checksum", "target_path"])
        .where("id", "=", "review-1")
        .executeTakeFirst(),
    ).resolves.toEqual({
      original_checksum: "checksum-1",
      target_path: "docs/authentication.md",
    });
  });
});
