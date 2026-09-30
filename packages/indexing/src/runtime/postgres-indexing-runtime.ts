import { createHash } from "node:crypto";

import { enqueueOutboxEvent, ScanJobCatalog, type CatalogDatabase } from "@intellirepo/catalog";
import {
  createScanJobId,
  type IndexingDispatchMode,
  type ScanJobSnapshot,
} from "@intellirepo/contracts";
import type { Kysely } from "kysely";

import {
  IndexingRuntimeError,
  type IndexingRuntime,
  type ScanSubmission,
  type ScanTarget,
  type ScanTargetInspector,
  type SubmitScanInput,
} from "./indexing-runtime.js";

function required(label: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new IndexingRuntimeError("INVALID_INPUT", `${label} must not be empty`);
  }
  return normalized;
}

function revisionId(repositoryId: string, target: ScanTarget): string {
  const digest = createHash("sha256")
    .update(`${repositoryId}\u001f${target.commitSha}\u001f${target.worktreeFingerprint}`)
    .digest("hex")
    .slice(0, 24);
  return `revision-${digest}`;
}

function targetsEqual(left: ScanTarget, right: ScanTarget): boolean {
  return (
    left.commitSha === right.commitSha && left.worktreeFingerprint === right.worktreeFingerprint
  );
}

export class PostgresIndexingRuntime implements IndexingRuntime {
  public constructor(
    private readonly database: Kysely<CatalogDatabase>,
    public readonly dispatchMode: IndexingDispatchMode,
    private readonly targetInspector: ScanTargetInspector,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async submit(input: SubmitScanInput): Promise<ScanSubmission> {
    const repositoryId = required("repositoryId", input.repositoryId);
    const target = {
      commitSha: required("target.commitSha", input.target.commitSha),
      worktreeFingerprint: required("target.worktreeFingerprint", input.target.worktreeFingerprint),
    };
    const result = await this.database.transaction().execute(async (transaction) => {
      const repository = await transaction
        .selectFrom("repositories")
        .select("id")
        .where("id", "=", repositoryId)
        .executeTakeFirst();
      if (repository === undefined) {
        throw new IndexingRuntimeError(
          "REPOSITORY_NOT_FOUND",
          `Repository ${repositoryId} was not found`,
        );
      }

      const parent = await transaction
        .selectFrom("revisions")
        .select("id")
        .where("repository_id", "=", repositoryId)
        .where("status", "=", "active")
        .orderBy("created_at", "desc")
        .executeTakeFirst();
      const desiredRevisionId = revisionId(repositoryId, target);
      await transaction
        .insertInto("revisions")
        .values({
          commit_sha: target.commitSha,
          id: desiredRevisionId,
          parent_revision_id: parent?.id ?? null,
          repository_id: repositoryId,
          status: "indexing",
          worktree_fingerprint: target.worktreeFingerprint,
        })
        .onConflict((conflict) =>
          conflict.columns(["repository_id", "commit_sha", "worktree_fingerprint"]).doNothing(),
        )
        .execute();
      const revision = await transaction
        .selectFrom("revisions")
        .select(["id", "status"])
        .where("repository_id", "=", repositoryId)
        .where("commit_sha", "=", target.commitSha)
        .where("worktree_fingerprint", "=", target.worktreeFingerprint)
        .executeTakeFirstOrThrow();
      const scanJobId = createScanJobId({ repositoryId, revisionId: revision.id });
      const existing = await transaction
        .selectFrom("scan_jobs")
        .select(["error", "id", "state"])
        .where("id", "=", scanJobId)
        .executeTakeFirst();
      if (existing !== undefined) {
        const error = existing.error as { recoverable?: boolean } | null;
        if (existing.state === "FAILED" && error?.recoverable !== true) {
          throw new IndexingRuntimeError(
            "NONRECOVERABLE_SCAN",
            `Scan ${scanJobId} failed permanently and cannot be resubmitted`,
          );
        }
        return { created: false, scanJobId };
      }

      const now = this.clock();
      await transaction
        .insertInto("scan_jobs")
        .values({
          attempt: 0,
          completed_at: null,
          completed_stages: "[]",
          counts: {},
          created_at: now,
          current_stage: null,
          degraded_reasons: "[]",
          diagnostics: "[]",
          dispatch_mode: this.dispatchMode,
          dispatch_state: "pending",
          error: null,
          heartbeat_at: null,
          id: scanJobId,
          lease_expires_at: null,
          lease_owner: null,
          recoverable_stage: null,
          repository_id: repositoryId,
          revision_id: revision.id,
          stage_timings: {},
          started_at: null,
          state: "QUEUED",
          updated_at: now,
        })
        .execute();
      await enqueueOutboxEvent(transaction, {
        aggregateId: scanJobId,
        availableAt: now,
        eventType: "scan.requested",
        idempotencyKey: `scan.requested:${scanJobId}:0`,
        payload: { repositoryId, revisionId: revision.id, scanJobId },
      });
      return { created: true, scanJobId };
    });
    return { created: result.created, scan: await this.status(result.scanJobId) };
  }

  public async status(scanJobId: string): Promise<ScanJobSnapshot> {
    const id = required("scanJobId", scanJobId);
    const scan = await new ScanJobCatalog(this.database).findById(id);
    if (scan === undefined) {
      throw new IndexingRuntimeError("SCAN_NOT_FOUND", `Scan ${id} was not found`);
    }
    return scan;
  }

  public async retry(scanJobId: string): Promise<ScanSubmission> {
    const previous = await this.status(scanJobId);
    if (
      previous.state !== "FAILED" ||
      previous.error?.recoverable !== true ||
      previous.recoverableStage === undefined
    ) {
      throw new IndexingRuntimeError(
        "SCAN_NOT_RETRYABLE",
        `Scan ${previous.id} is not in a recoverable failed state`,
      );
    }
    const targetRow = await this.database
      .selectFrom("revisions as revision")
      .innerJoin("repositories as repository", "repository.id", "revision.repository_id")
      .select(["repository.root_path", "revision.commit_sha", "revision.worktree_fingerprint"])
      .where("revision.id", "=", previous.revisionId)
      .where("revision.repository_id", "=", previous.repositoryId)
      .executeTakeFirstOrThrow();
    const expectedTarget = {
      commitSha: targetRow.commit_sha,
      worktreeFingerprint: targetRow.worktree_fingerprint,
    };
    const currentTarget = await this.targetInspector.inspect(targetRow.root_path);
    if (!targetsEqual(expectedTarget, currentTarget)) {
      throw new IndexingRuntimeError(
        "STALE_SCAN_TARGET",
        `Repository content no longer matches scan ${previous.id}`,
      );
    }

    const now = this.clock();
    const attempt = previous.attempt + 1;
    const changed = await this.database.transaction().execute(async (transaction) => {
      const updated = await transaction
        .updateTable("scan_jobs")
        .set({
          attempt,
          completed_at: null,
          current_stage: null,
          dispatch_state: "pending",
          error: null,
          heartbeat_at: null,
          lease_expires_at: null,
          lease_owner: null,
          recoverable_stage: null,
          state: "QUEUED",
          updated_at: now,
        })
        .where("id", "=", previous.id)
        .where("state", "=", "FAILED")
        .returning("id")
        .executeTakeFirst();
      if (updated === undefined) return false;
      await enqueueOutboxEvent(transaction, {
        aggregateId: previous.id,
        availableAt: now,
        eventType: "scan.requested",
        idempotencyKey: `scan.requested:${previous.id}:${attempt}`,
        payload: {
          repositoryId: previous.repositoryId,
          revisionId: previous.revisionId,
          scanJobId: previous.id,
        },
      });
      return true;
    });
    if (!changed) {
      throw new IndexingRuntimeError(
        "SCAN_NOT_RETRYABLE",
        `Scan ${previous.id} changed state before retry`,
      );
    }
    return { created: true, scan: await this.status(previous.id) };
  }
}

export const indexingRuntimeIdentityForTesting = { revisionId };
