import { ScanJobCatalog, type CatalogDatabase } from "@intellirepo/catalog";
import type { ScanJobSnapshot } from "@intellirepo/contracts";
import type { Kysely } from "kysely";

import type { ScanJobStore, ScanTransitionExpectation } from "./scan-executor.js";

function jsonObject(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export class PostgresScanJobStore implements ScanJobStore {
  private readonly catalog: ScanJobCatalog;

  public constructor(private readonly database: Kysely<CatalogDatabase>) {
    this.catalog = new ScanJobCatalog(database);
  }

  public findById(id: string): Promise<ScanJobSnapshot | undefined> {
    return this.catalog.findById(id);
  }

  public acquireLease(id: string, owner: string, durationMs: number, now: Date): Promise<boolean> {
    return this.catalog.acquireLease(id, owner, durationMs, now);
  }

  public renewLease(id: string, owner: string, durationMs: number, now: Date): Promise<boolean> {
    return this.catalog.renewLease(id, owner, durationMs, now);
  }

  public releaseLease(id: string, owner: string): Promise<boolean> {
    return this.catalog.releaseLease(id, owner);
  }

  public async transition(
    snapshot: ScanJobSnapshot,
    expected: ScanTransitionExpectation,
  ): Promise<boolean> {
    let statement = this.database
      .updateTable("scan_jobs")
      .set({
        attempt: snapshot.attempt,
        completed_at: snapshot.completedAt ?? null,
        completed_stages: JSON.stringify(snapshot.completedStages),
        counts: { ...(snapshot.counts ?? {}) },
        current_stage: snapshot.currentStage ?? null,
        degraded_reasons: JSON.stringify(snapshot.degradedReasons),
        diagnostics: JSON.stringify(snapshot.diagnostics ?? []),
        dispatch_mode: snapshot.dispatchMode ?? "bullmq",
        dispatch_state: snapshot.dispatchState ?? "pending",
        error: snapshot.error === undefined ? null : jsonObject(snapshot.error),
        recoverable_stage: snapshot.recoverableStage ?? null,
        stage_timings: jsonObject(snapshot.stageTimings),
        started_at: snapshot.startedAt ?? null,
        state: snapshot.state,
        updated_at: snapshot.updatedAt,
      })
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
}
