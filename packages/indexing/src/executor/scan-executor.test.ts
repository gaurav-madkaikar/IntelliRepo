import { SCAN_STAGES, type ScanJobSnapshot, type ScanStage } from "@intellirepo/contracts";
import { describe, expect, it } from "vitest";

import {
  ScanExecutor,
  type ScanJobStore,
  type ScanTransitionExpectation,
} from "./scan-executor.js";
import { ScanStageExecutionError, type ScanStageHandler } from "./scan-stage.js";

const timestamp = "2026-07-22T00:00:00.000Z";

function queuedSnapshot(): ScanJobSnapshot {
  return {
    attempt: 0,
    completedStages: [],
    createdAt: timestamp,
    degradedReasons: [],
    id: "scan-1",
    repositoryId: "repository-1",
    revisionId: "revision-1",
    stageTimings: {},
    state: "QUEUED",
    updatedAt: timestamp,
  };
}

class MemoryScanJobStore implements ScanJobStore {
  public leaseAvailable = true;
  public snapshot = queuedSnapshot();

  public acquireLease(): Promise<boolean> {
    return Promise.resolve(this.leaseAvailable);
  }

  public findById(): Promise<ScanJobSnapshot> {
    return Promise.resolve(this.snapshot);
  }

  public releaseLease(): Promise<boolean> {
    return Promise.resolve(true);
  }

  public renewLease(): Promise<boolean> {
    return Promise.resolve(true);
  }

  public transition(
    snapshot: ScanJobSnapshot,
    expected: ScanTransitionExpectation,
  ): Promise<boolean> {
    if (this.snapshot.state !== expected.state) return Promise.resolve(false);
    if (
      expected.currentStage !== undefined &&
      (this.snapshot.currentStage ?? null) !== expected.currentStage
    ) {
      return Promise.resolve(false);
    }
    this.snapshot = snapshot;
    return Promise.resolve(true);
  }
}

function handlers(
  run: (stage: ScanStage) => Promise<void> = () => Promise.resolve(),
): readonly ScanStageHandler[] {
  return SCAN_STAGES.map((stage) => ({
    stage,
    async run() {
      await run(stage);
      return { counts: { [`${stage.toLowerCase()}Count`]: 1 } };
    },
  }));
}

function executor(store: ScanJobStore, stageHandlers: readonly ScanStageHandler[]): ScanExecutor {
  let now = Date.parse(timestamp);
  return new ScanExecutor(
    store,
    stageHandlers,
    { heartbeatIntervalMs: 5_000, leaseDurationMs: 30_000, owner: "worker-1" },
    () => new Date((now += 10)),
  );
}

describe("ScanExecutor", () => {
  it("runs every stage in order and records timings and counts", async () => {
    const store = new MemoryScanJobStore();
    const visited: ScanStage[] = [];

    const result = await executor(
      store,
      handlers((stage) => {
        visited.push(stage);
        return Promise.resolve();
      }),
    ).execute("scan-1");

    expect(visited).toEqual(SCAN_STAGES);
    expect(result.snapshot.state).toBe("COMPLETED");
    expect(result.snapshot.completedStages).toEqual(SCAN_STAGES);
    expect(result.snapshot.counts?.discoveringCount).toBe(1);
    expect(Object.keys(result.snapshot.stageTimings)).toEqual(SCAN_STAGES);
  });

  it("records a recoverable failure and resumes only the remaining stages", async () => {
    const store = new MemoryScanJobStore();
    const firstVisited: ScanStage[] = [];

    await executor(
      store,
      handlers((stage) => {
        firstVisited.push(stage);
        if (stage === "RESOLVING") {
          throw new ScanStageExecutionError("temporary parser dependency failure", true);
        }
        return Promise.resolve();
      }),
    ).execute("scan-1");

    expect(firstVisited).toEqual(["DISCOVERING", "PARSING", "RESOLVING"]);
    expect(store.snapshot).toMatchObject({
      completedStages: ["DISCOVERING", "PARSING"],
      recoverableStage: "RESOLVING",
      state: "FAILED",
    });

    const {
      completedAt: _completedAt,
      error: _error,
      recoverableStage: _recoverableStage,
      ...failedSnapshot
    } = store.snapshot;
    void _completedAt;
    void _error;
    void _recoverableStage;
    store.snapshot = {
      ...failedSnapshot,
      attempt: 1,
      state: "QUEUED",
    };
    const resumedVisited: ScanStage[] = [];
    const resumed = await executor(
      store,
      handlers((stage) => {
        resumedVisited.push(stage);
        return Promise.resolve();
      }),
    ).execute("scan-1");

    expect(resumedVisited).toEqual(SCAN_STAGES.slice(2));
    expect(resumed.snapshot.state).toBe("COMPLETED");
    expect(resumed.snapshot.attempt).toBe(1);
  });

  it("does not execute when another worker owns the lease", async () => {
    const store = new MemoryScanJobStore();
    store.leaseAvailable = false;
    const visited: ScanStage[] = [];

    const result = await executor(
      store,
      handlers((stage) => {
        visited.push(stage);
        return Promise.resolve();
      }),
    ).execute("scan-1");

    expect(result.executed).toBe(false);
    expect(result.snapshot.state).toBe("QUEUED");
    expect(visited).toEqual([]);
  });
});
