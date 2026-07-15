import type { ScanJobSnapshot, ScanStage, ScanStageTiming } from "@intellirepo/contracts";
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

  return {
    attempt: row.attempt,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at.toISOString() }),
    completedStages: asStages(row.completed_stages),
    createdAt: row.created_at.toISOString(),
    ...(row.current_stage === null ? {} : { currentStage: row.current_stage as ScanStage }),
    degradedReasons: row.degraded_reasons,
    ...(error === null ? {} : { error }),
    id: row.id,
    repositoryId: row.repository_id,
    revisionId: row.revision_id,
    stageTimings,
    ...(row.started_at === null ? {} : { startedAt: row.started_at.toISOString() }),
    state: row.state as ScanJobSnapshot["state"],
    updatedAt: row.updated_at.toISOString(),
  };
}

export class ScanJobCatalog {
  public constructor(private readonly database: Kysely<CatalogDatabase>) {}

  public async save(snapshot: ScanJobSnapshot): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("scan_jobs")
        .values({
          attempt: snapshot.attempt,
          completed_at: snapshot.completedAt ?? null,
          completed_stages: snapshot.completedStages,
          created_at: snapshot.createdAt,
          current_stage: snapshot.currentStage ?? null,
          degraded_reasons: snapshot.degradedReasons,
          error: snapshot.error === undefined ? null : jsonObject(snapshot.error),
          id: snapshot.id,
          repository_id: snapshot.repositoryId,
          revision_id: snapshot.revisionId,
          stage_timings: jsonObject(snapshot.stageTimings),
          started_at: snapshot.startedAt ?? null,
          state: snapshot.state,
          updated_at: snapshot.updatedAt,
        })
        .onConflict((conflict) =>
          conflict.column("id").doUpdateSet({
            attempt: snapshot.attempt,
            completed_at: snapshot.completedAt ?? null,
            completed_stages: snapshot.completedStages,
            current_stage: snapshot.currentStage ?? null,
            degraded_reasons: snapshot.degradedReasons,
            error: snapshot.error === undefined ? null : jsonObject(snapshot.error),
            stage_timings: jsonObject(snapshot.stageTimings),
            started_at: snapshot.startedAt ?? null,
            state: snapshot.state,
            updated_at: snapshot.updatedAt,
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
}
