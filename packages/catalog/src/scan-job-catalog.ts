import type {
  IndexingDispatchMode,
  ScanDiagnostic,
  ScanDispatchState,
  ScanJobSnapshot,
  ScanStage,
  ScanStageTiming,
} from "@intellirepo/contracts";
import type { Kysely, Selectable } from "kysely";

import type { CatalogDatabase, ScanJobTable } from "./database-types.js";

function jsonObject(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function asStages(value: readonly string[]): readonly ScanStage[] {
  return value as readonly ScanStage[];
}

function snapshotFromRow(row: Selectable<ScanJobTable>): ScanJobSnapshot {
  const stageTimings = row.stage_timings as unknown as Partial<Record<ScanStage, ScanStageTiming>>;
  const error = row.error as { message: string; recoverable: boolean; stage: ScanStage } | null;

  const diagnostics = row.diagnostics as unknown as readonly ScanDiagnostic[];
  const counts = row.counts as Readonly<Record<string, number>>;
  const lease =
    row.lease_owner === null || row.lease_expires_at === null || row.heartbeat_at === null
      ? undefined
      : {
          expiresAt: row.lease_expires_at.toISOString(),
          heartbeatAt: row.heartbeat_at.toISOString(),
          owner: row.lease_owner,
        };

  return {
    attempt: row.attempt,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at.toISOString() }),
    completedStages: asStages(row.completed_stages),
    ...(Object.keys(counts).length === 0 ? {} : { counts }),
    createdAt: row.created_at.toISOString(),
    ...(row.current_stage === null ? {} : { currentStage: row.current_stage as ScanStage }),
    degradedReasons: row.degraded_reasons,
    ...(diagnostics.length === 0 ? {} : { diagnostics }),
    dispatchMode: row.dispatch_mode as IndexingDispatchMode,
    dispatchState: row.dispatch_state as ScanDispatchState,
    ...(error === null ? {} : { error }),
    id: row.id,
    ...(lease === undefined ? {} : { lease }),
    ...(row.recoverable_stage === null
      ? {}
      : { recoverableStage: row.recoverable_stage as ScanStage }),
    repositoryId: row.repository_id,
    revisionId: row.revision_id,
    stageTimings,
    ...(row.started_at === null ? {} : { startedAt: row.started_at.toISOString() }),
    state: row.state as ScanJobSnapshot["state"],
    updatedAt: row.updated_at.toISOString(),
  };
}

function snapshotValues(snapshot: ScanJobSnapshot) {
  return {
    attempt: snapshot.attempt,
    completed_at: snapshot.completedAt ?? null,
    completed_stages: snapshot.completedStages,
    counts: { ...(snapshot.counts ?? {}) },
    current_stage: snapshot.currentStage ?? null,
    degraded_reasons: snapshot.degradedReasons,
    diagnostics: (snapshot.diagnostics ?? []).map(jsonObject),
    dispatch_mode: snapshot.dispatchMode ?? "bullmq",
    dispatch_state: snapshot.dispatchState ?? "pending",
    error: snapshot.error === undefined ? null : jsonObject(snapshot.error),
    heartbeat_at: snapshot.lease?.heartbeatAt ?? null,
    lease_expires_at: snapshot.lease?.expiresAt ?? null,
    lease_owner: snapshot.lease?.owner ?? null,
    recoverable_stage: snapshot.recoverableStage ?? null,
    stage_timings: jsonObject(snapshot.stageTimings),
    started_at: snapshot.startedAt ?? null,
    state: snapshot.state,
    updated_at: snapshot.updatedAt,
  };
}

export interface ScanTransitionExpectation {
  readonly currentStage?: ScanStage | null;
  readonly state: ScanJobSnapshot["state"];
}

export class ScanJobCatalog {
  public constructor(private readonly database: Kysely<CatalogDatabase>) {}

  public async save(snapshot: ScanJobSnapshot): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("scan_jobs")
        .values({
          created_at: snapshot.createdAt,
          id: snapshot.id,
          repository_id: snapshot.repositoryId,
          revision_id: snapshot.revisionId,
          ...snapshotValues(snapshot),
        })
        .onConflict((conflict) =>
          conflict.column("id").doUpdateSet({
            ...snapshotValues(snapshot),
          }),
        )
        .execute();

      if (snapshot.attempt > 0) {
        await transaction
          .insertInto("job_attempts")
          .values({
            attempt: snapshot.attempt,
            completed_at: snapshot.completedAt ?? null,
            error: snapshot.error === undefined ? null : jsonObject(snapshot.error),
            id: `${snapshot.id}-attempt-${snapshot.attempt}`,
            scan_job_id: snapshot.id,
            stage: snapshot.currentStage ?? snapshot.error?.stage ?? null,
            started_at: snapshot.startedAt ?? snapshot.updatedAt,
            state: snapshot.state,
          })
          .onConflict((conflict) =>
            conflict.columns(["scan_job_id", "attempt"]).doUpdateSet({
              completed_at: snapshot.completedAt ?? null,
              error: snapshot.error === undefined ? null : jsonObject(snapshot.error),
              stage: snapshot.currentStage ?? snapshot.error?.stage ?? null,
              state: snapshot.state,
            }),
          )
          .execute();
      }
    });
  }

  public async findById(id: string): Promise<ScanJobSnapshot | undefined> {
    const row = await this.database
      .selectFrom("scan_jobs")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row === undefined ? undefined : snapshotFromRow(row);
  }

  public async transition(
    snapshot: ScanJobSnapshot,
    expected: ScanTransitionExpectation,
  ): Promise<boolean> {
    let statement = this.database
      .updateTable("scan_jobs")
      .set(snapshotValues(snapshot))
      .where("id", "=", snapshot.id)
      .where("state", "=", expected.state);
    if (expected.currentStage !== undefined) {
      statement =
        expected.currentStage === null
          ? statement.where("current_stage", "is", null)
          : statement.where("current_stage", "=", expected.currentStage);
    }
    const changed = await statement.returning("id").executeTakeFirst();
    return changed !== undefined;
  }

  public async markDispatchState(
    id: string,
    state: ScanDispatchState,
    now = new Date(),
  ): Promise<boolean> {
    const changed = await this.database
      .updateTable("scan_jobs")
      .set({ dispatch_state: state, updated_at: now })
      .where("id", "=", id)
      .returning("id")
      .executeTakeFirst();
    return changed !== undefined;
  }

  public async acquireLease(
    id: string,
    owner: string,
    durationMs: number,
    now = new Date(),
  ): Promise<boolean> {
    if (owner.trim().length === 0) throw new Error("Lease owner must not be empty");
    if (!Number.isInteger(durationMs) || durationMs < 1) {
      throw new Error("Lease duration must be a positive integer");
    }
    const expiresAt = new Date(now.getTime() + durationMs);
    const changed = await this.database
      .updateTable("scan_jobs")
      .set({ heartbeat_at: now, lease_expires_at: expiresAt, lease_owner: owner })
      .where("id", "=", id)
      .where((expression) =>
        expression.or([
          expression("lease_owner", "is", null),
          expression("lease_expires_at", "<=", now),
          expression("lease_owner", "=", owner),
        ]),
      )
      .returning("id")
      .executeTakeFirst();
    return changed !== undefined;
  }

  public async renewLease(
    id: string,
    owner: string,
    durationMs: number,
    now = new Date(),
  ): Promise<boolean> {
    if (!Number.isInteger(durationMs) || durationMs < 1) {
      throw new Error("Lease duration must be a positive integer");
    }
    const changed = await this.database
      .updateTable("scan_jobs")
      .set({ heartbeat_at: now, lease_expires_at: new Date(now.getTime() + durationMs) })
      .where("id", "=", id)
      .where("lease_owner", "=", owner)
      .where("lease_expires_at", ">", now)
      .returning("id")
      .executeTakeFirst();
    return changed !== undefined;
  }

  public async releaseLease(id: string, owner: string): Promise<boolean> {
    const changed = await this.database
      .updateTable("scan_jobs")
      .set({ heartbeat_at: null, lease_expires_at: null, lease_owner: null })
      .where("id", "=", id)
      .where("lease_owner", "=", owner)
      .returning("id")
      .executeTakeFirst();
    return changed !== undefined;
  }
}
