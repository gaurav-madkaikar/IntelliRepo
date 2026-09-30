import {
  SCAN_STAGES,
  nextScanStage,
  type ScanDiagnostic,
  type ScanJobSnapshot,
  type ScanStage,
  type ScanStageTiming,
} from "@intellirepo/contracts";

import { ScanExecutionContext } from "./scan-context.js";
import { ScanStageExecutionError, type ScanStageHandler } from "./scan-stage.js";

export interface ScanTransitionExpectation {
  readonly currentStage?: ScanStage | null;
  readonly state: ScanJobSnapshot["state"];
}

export interface ScanJobStore {
  acquireLease(id: string, owner: string, durationMs: number, now: Date): Promise<boolean>;
  findById(id: string): Promise<ScanJobSnapshot | undefined>;
  releaseLease(id: string, owner: string): Promise<boolean>;
  renewLease(id: string, owner: string, durationMs: number, now: Date): Promise<boolean>;
  transition(snapshot: ScanJobSnapshot, expected: ScanTransitionExpectation): Promise<boolean>;
}

export interface ScanExecutorOptions {
  readonly heartbeatIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly owner: string;
}

export interface ScanExecutionResult {
  readonly executed: boolean;
  readonly snapshot: ScanJobSnapshot;
}

export class ScanLeaseLostError extends Error {
  public constructor(scanJobId: string) {
    super(`Lease for scan ${scanJobId} was lost`);
    this.name = "ScanLeaseLostError";
  }
}

function optionalFields(snapshot: ScanJobSnapshot) {
  return {
    ...(snapshot.counts === undefined ? {} : { counts: snapshot.counts }),
    ...(snapshot.diagnostics === undefined ? {} : { diagnostics: snapshot.diagnostics }),
    ...(snapshot.dispatchMode === undefined ? {} : { dispatchMode: snapshot.dispatchMode }),
    ...(snapshot.dispatchState === undefined ? {} : { dispatchState: snapshot.dispatchState }),
    ...(snapshot.lease === undefined ? {} : { lease: snapshot.lease }),
  };
}

function runningSnapshot(snapshot: ScanJobSnapshot, stage: ScanStage, now: Date): ScanJobSnapshot {
  const timestamp = now.toISOString();
  const existingTiming = snapshot.stageTimings[stage];
  return {
    attempt: Math.max(1, snapshot.attempt),
    completedStages: snapshot.completedStages,
    createdAt: snapshot.createdAt,
    currentStage: stage,
    degradedReasons: snapshot.degradedReasons,
    id: snapshot.id,
    ...optionalFields(snapshot),
    repositoryId: snapshot.repositoryId,
    revisionId: snapshot.revisionId,
    stageTimings: {
      ...snapshot.stageTimings,
      [stage]: existingTiming ?? { startedAt: timestamp },
    },
    startedAt: snapshot.startedAt ?? timestamp,
    state: "RUNNING",
    updatedAt: timestamp,
  };
}

function mergeStageResult(
  snapshot: ScanJobSnapshot,
  stage: ScanStage,
  result: Awaited<ReturnType<ScanStageHandler["run"]>>,
  startedAt: Date,
  completedAt: Date,
): ScanJobSnapshot {
  const next = nextScanStage(stage);
  const completedTimestamp = completedAt.toISOString();
  const timing = {
    completedAt: completedTimestamp,
    durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    startedAt: snapshot.stageTimings[stage]?.startedAt ?? startedAt.toISOString(),
  } satisfies ScanStageTiming;
  const diagnostics = [...(snapshot.diagnostics ?? []), ...(result?.diagnostics ?? [])];
  const degradedReasons = [
    ...new Set([...snapshot.degradedReasons, ...(result?.degradedReasons ?? [])]),
  ];
  return {
    attempt: snapshot.attempt,
    ...(next === undefined ? { completedAt: completedTimestamp } : {}),
    completedStages: [...snapshot.completedStages, stage],
    counts: { ...(snapshot.counts ?? {}), ...(result?.counts ?? {}) },
    createdAt: snapshot.createdAt,
    ...(next === undefined ? {} : { currentStage: next }),
    degradedReasons,
    ...(diagnostics.length === 0 ? {} : { diagnostics }),
    ...(snapshot.dispatchMode === undefined ? {} : { dispatchMode: snapshot.dispatchMode }),
    ...(snapshot.dispatchState === undefined ? {} : { dispatchState: snapshot.dispatchState }),
    id: snapshot.id,
    ...(snapshot.lease === undefined ? {} : { lease: snapshot.lease }),
    repositoryId: snapshot.repositoryId,
    revisionId: snapshot.revisionId,
    stageTimings: { ...snapshot.stageTimings, [stage]: timing },
    ...(snapshot.startedAt === undefined ? {} : { startedAt: snapshot.startedAt }),
    state: next === undefined ? "COMPLETED" : "RUNNING",
    updatedAt: completedTimestamp,
  };
}

function failedSnapshot(
  snapshot: ScanJobSnapshot,
  stage: ScanStage,
  error: unknown,
  recoverable: boolean,
  now: Date,
): ScanJobSnapshot {
  const timestamp = now.toISOString();
  const message = error instanceof Error ? error.message : "Unknown scan stage failure";
  const diagnostic = {
    code: "SCAN_STAGE_FAILED",
    message,
    severity: "error",
    stage,
  } satisfies ScanDiagnostic;
  return {
    attempt: snapshot.attempt,
    completedAt: timestamp,
    completedStages: snapshot.completedStages,
    ...(snapshot.counts === undefined ? {} : { counts: snapshot.counts }),
    createdAt: snapshot.createdAt,
    degradedReasons: snapshot.degradedReasons,
    diagnostics: [...(snapshot.diagnostics ?? []), diagnostic],
    ...(snapshot.dispatchMode === undefined ? {} : { dispatchMode: snapshot.dispatchMode }),
    ...(snapshot.dispatchState === undefined ? {} : { dispatchState: snapshot.dispatchState }),
    error: { message, recoverable, stage },
    id: snapshot.id,
    ...(snapshot.lease === undefined ? {} : { lease: snapshot.lease }),
    ...(recoverable ? { recoverableStage: stage } : {}),
    repositoryId: snapshot.repositoryId,
    revisionId: snapshot.revisionId,
    stageTimings: snapshot.stageTimings,
    ...(snapshot.startedAt === undefined ? {} : { startedAt: snapshot.startedAt }),
    state: "FAILED",
    updatedAt: timestamp,
  };
}

export class ScanExecutor {
  private readonly handlers: ReadonlyMap<ScanStage, ScanStageHandler>;

  public constructor(
    private readonly store: ScanJobStore,
    handlers: readonly ScanStageHandler[],
    private readonly options: ScanExecutorOptions,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (options.owner.trim().length === 0) throw new Error("Scan executor owner must not be empty");
    if (!Number.isInteger(options.leaseDurationMs) || options.leaseDurationMs < 1) {
      throw new Error("Scan lease duration must be a positive integer");
    }
    if (
      !Number.isInteger(options.heartbeatIntervalMs) ||
      options.heartbeatIntervalMs < 1 ||
      options.heartbeatIntervalMs >= options.leaseDurationMs
    ) {
      throw new Error("Scan heartbeat must be positive and shorter than the lease duration");
    }
    this.handlers = new Map(handlers.map((handler) => [handler.stage, handler]));
    const missing = SCAN_STAGES.filter((stage) => !this.handlers.has(stage));
    if (missing.length > 0) throw new Error(`Missing scan stage handlers: ${missing.join(", ")}`);
  }

  public async execute(scanJobId: string): Promise<ScanExecutionResult> {
    let snapshot = await this.store.findById(scanJobId);
    if (snapshot === undefined) throw new Error(`Scan ${scanJobId} was not found`);
    if (snapshot.state === "COMPLETED" || snapshot.state === "CANCELLED") {
      return { executed: false, snapshot };
    }
    const acquired = await this.store.acquireLease(
      snapshot.id,
      this.options.owner,
      this.options.leaseDurationMs,
      this.clock(),
    );
    if (!acquired) return { executed: false, snapshot };
    snapshot = (await this.store.findById(scanJobId)) ?? snapshot;
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void this.store
        .renewLease(scanJobId, this.options.owner, this.options.leaseDurationMs, this.clock())
        .then((renewed) => {
          if (!renewed) leaseLost = true;
        })
        .catch(() => {
          leaseLost = true;
        });
    }, this.options.heartbeatIntervalMs);

    try {
      const context = new ScanExecutionContext(snapshot);
      for (const stage of SCAN_STAGES) {
        if (snapshot.completedStages.includes(stage)) continue;
        if (snapshot.currentStage !== undefined && snapshot.currentStage !== stage) {
          throw new Error(
            `Scan ${scanJobId} expects ${snapshot.currentStage} but ${stage} is incomplete`,
          );
        }
        const startedAt = this.clock();
        const running = runningSnapshot(snapshot, stage, startedAt);
        const transitioned = await this.store.transition(running, {
          currentStage: snapshot.currentStage ?? null,
          state: snapshot.state,
        });
        if (!transitioned) throw new ScanLeaseLostError(scanJobId);
        snapshot = running;
        try {
          const result = await this.handlers.get(stage)?.run(context);
          if (leaseLost) throw new ScanLeaseLostError(scanJobId);
          const completed = mergeStageResult(snapshot, stage, result, startedAt, this.clock());
          const saved = await this.store.transition(completed, {
            currentStage: stage,
            state: "RUNNING",
          });
          if (!saved) throw new ScanLeaseLostError(scanJobId);
          snapshot = completed;
        } catch (error) {
          if (error instanceof ScanLeaseLostError) throw error;
          const recoverable = error instanceof ScanStageExecutionError ? error.recoverable : false;
          const failed = failedSnapshot(snapshot, stage, error, recoverable, this.clock());
          await this.store.transition(failed, { currentStage: stage, state: "RUNNING" });
          snapshot = failed;
          break;
        }
      }
      return { executed: true, snapshot };
    } finally {
      clearInterval(heartbeat);
      await this.store.releaseLease(scanJobId, this.options.owner);
    }
  }
}
