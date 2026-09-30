import { fileURLToPath } from "node:url";

import {
  createCatalogDatabase,
  migrateCatalogToLatest,
  RepositoryCatalog,
  ScanJobCatalog,
  type CatalogDatabaseHandle,
} from "@intellirepo/catalog";
import { startPostgresTestContainer, type PostgresTestContainer } from "@intellirepo/testkit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { OutboxDispatcher } from "../dispatch/outbox-dispatcher.js";
import type { ScanDispatcher } from "../dispatch/scan-dispatcher.js";
import { IndexingRuntimeError, type ScanTargetInspector } from "./indexing-runtime.js";
import { PostgresIndexingRuntime } from "./postgres-indexing-runtime.js";

const describeWithContainers =
  process.env.RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const migrationFolder = fileURLToPath(new URL("../../../catalog/migrations", import.meta.url));

describeWithContainers("PostgresIndexingRuntime", () => {
  let container: PostgresTestContainer;
  let handle: CatalogDatabaseHandle;
  let currentTarget = { commitSha: "commit-1", worktreeFingerprint: "fingerprint-1" };
  const inspector = {
    inspect: vi.fn(() => Promise.resolve(currentTarget)),
  } satisfies ScanTargetInspector;
  const now = new Date("2026-07-22T00:00:00.000Z");

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

  async function repository(suffix: string) {
    return new RepositoryCatalog(handle.database).register({
      displayName: suffix,
      id: `repository-${suffix}`,
      rootPath: `/fixtures/${suffix}`,
    });
  }

  function runtime() {
    return new PostgresIndexingRuntime(handle.database, "bullmq", inspector, () => now);
  }

  it("submits atomically, deduplicates the target, and selects the active parent", async () => {
    const registered = await repository("submit");
    currentTarget = { commitSha: "submit-1", worktreeFingerprint: "submit-fingerprint-1" };

    const first = await runtime().submit({ repositoryId: registered.id, target: currentTarget });
    const duplicate = await runtime().submit({
      repositoryId: registered.id,
      target: currentTarget,
    });

    expect(first).toMatchObject({
      created: true,
      scan: { dispatchMode: "bullmq", dispatchState: "pending", state: "QUEUED" },
    });
    expect(duplicate).toEqual({ created: false, scan: first.scan });
    await handle.database
      .updateTable("revisions")
      .set({ status: "active" })
      .where("id", "=", first.scan.revisionId)
      .execute();

    currentTarget = { commitSha: "submit-2", worktreeFingerprint: "submit-fingerprint-2" };
    const second = await runtime().submit({ repositoryId: registered.id, target: currentTarget });
    const secondRevision = await handle.database
      .selectFrom("revisions")
      .select("parent_revision_id")
      .where("id", "=", second.scan.revisionId)
      .executeTakeFirstOrThrow();
    expect(secondRevision.parent_revision_id).toBe(first.scan.revisionId);
    const outbox = await handle.database
      .selectFrom("outbox_events")
      .select("id")
      .where("event_type", "=", "scan.requested")
      .where("aggregate_id", "=", first.scan.id)
      .execute();
    expect(outbox).toHaveLength(1);
  });

  it("rejects unknown repositories and stale or nonrecoverable retries", async () => {
    await expect(
      runtime().submit({ repositoryId: "missing", target: currentTarget }),
    ).rejects.toMatchObject({ code: "REPOSITORY_NOT_FOUND" });
    const registered = await repository("retry");
    currentTarget = { commitSha: "retry-1", worktreeFingerprint: "retry-fingerprint-1" };
    const submission = await runtime().submit({
      repositoryId: registered.id,
      target: currentTarget,
    });
    const failed = {
      ...submission.scan,
      attempt: 1,
      completedStages: ["DISCOVERING" as const],
      error: { message: "Parser interrupted", recoverable: true, stage: "PARSING" as const },
      recoverableStage: "PARSING" as const,
      state: "FAILED" as const,
      updatedAt: "2026-07-22T00:00:01.000Z",
    };
    await new ScanJobCatalog(handle.database).save(failed);

    const retried = await runtime().retry(submission.scan.id);
    expect(retried.scan).toMatchObject({
      attempt: 2,
      completedStages: ["DISCOVERING"],
      dispatchState: "pending",
      state: "QUEUED",
    });
    await handle.database
      .updateTable("scan_jobs")
      .set({
        error: { message: "Parser rejected input", recoverable: false, stage: "PARSING" },
        recoverable_stage: null,
        state: "FAILED",
        updated_at: new Date("2026-07-22T00:00:02.000Z"),
      })
      .where("id", "=", submission.scan.id)
      .execute();
    await expect(runtime().retry(submission.scan.id)).rejects.toMatchObject({
      code: "SCAN_NOT_RETRYABLE",
    } satisfies Partial<IndexingRuntimeError>);

    await new ScanJobCatalog(handle.database).save(failed);
    currentTarget = { ...currentTarget, worktreeFingerprint: "changed" };
    await expect(runtime().retry(submission.scan.id)).rejects.toMatchObject({
      code: "STALE_SCAN_TARGET",
    } satisfies Partial<IndexingRuntimeError>);
  });

  it("publishes pending outbox events and retries dispatch failures", async () => {
    await handle.database
      .updateTable("outbox_events")
      .set({ published_at: now })
      .where("published_at", "is", null)
      .execute();
    const registered = await repository("dispatch");
    currentTarget = { commitSha: "dispatch-1", worktreeFingerprint: "dispatch-fingerprint-1" };
    const first = await runtime().submit({ repositoryId: registered.id, target: currentTarget });
    const dispatch = vi.fn(() => Promise.resolve());
    const dispatcher = {
      close: () => Promise.resolve(),
      dispatch,
    } satisfies ScanDispatcher;
    let pumpTime = now;
    const pump = new OutboxDispatcher(
      handle.database,
      dispatcher,
      { owner: "api-1", retryBackoffMs: 1_000 },
      () => pumpTime,
    );

    await expect(pump.pump()).resolves.toEqual({ attempted: 1, failed: 0, published: 1 });
    expect(dispatch).toHaveBeenCalledWith({
      repositoryId: registered.id,
      revisionId: first.scan.revisionId,
      scanJobId: first.scan.id,
    });
    await expect(runtime().status(first.scan.id)).resolves.toMatchObject({
      dispatchState: "dispatched",
    });

    currentTarget = { commitSha: "dispatch-2", worktreeFingerprint: "dispatch-fingerprint-2" };
    const second = await runtime().submit({ repositoryId: registered.id, target: currentTarget });
    dispatch.mockRejectedValueOnce(new Error("Redis unavailable"));
    await expect(pump.pump()).resolves.toEqual({ attempted: 1, failed: 1, published: 0 });
    await expect(runtime().status(second.scan.id)).resolves.toMatchObject({
      dispatchState: "failed",
    });
    await expect(pump.pump()).resolves.toEqual({ attempted: 0, failed: 0, published: 0 });
    pumpTime = new Date(now.getTime() + 1_000);
    await expect(pump.pump()).resolves.toEqual({ attempted: 1, failed: 0, published: 1 });
  });
});
