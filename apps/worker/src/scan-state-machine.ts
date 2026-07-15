import {
  createScanJobId,
  isOptionalScanStage,
  nextScanStage,
  type ScanJobRequest,
  type ScanJobSnapshot,
  type ScanStage,
} from "@intellirepo/contracts";

function iso(date: Date): string {
  return date.toISOString();
}

export function createQueuedScan(request: ScanJobRequest, now = new Date()): ScanJobSnapshot {
  const timestamp = iso(now);
  return Object.freeze({
    attempt: 0,
    completedStages: [],
    createdAt: timestamp,
    degradedReasons: [],
    id: createScanJobId(request),
    repositoryId: request.repositoryId,
    revisionId: request.revisionId,
    stageTimings: {},
    state: "QUEUED",
    updatedAt: timestamp,
  });
}

function startStage(snapshot: ScanJobSnapshot, stage: ScanStage, now: Date): ScanJobSnapshot {
  const timestamp = iso(now);
  return Object.freeze({
    ...snapshot,
    currentStage: stage,
    stageTimings: {
      ...snapshot.stageTimings,
      [stage]: { startedAt: timestamp },
    },
    state: "RUNNING",
    updatedAt: timestamp,
  });
}

export function startScan(snapshot: ScanJobSnapshot, now = new Date()): ScanJobSnapshot {
  if (snapshot.state !== "QUEUED") {
    throw new Error(`Cannot start scan from ${snapshot.state}`);
  }
  return startStage({ ...snapshot, attempt: 1, startedAt: iso(now) }, "DISCOVERING", now);
}

export interface CompleteStageOptions {
  readonly degradedReason?: string;
}

export function completeCurrentStage(
  snapshot: ScanJobSnapshot,
  options: CompleteStageOptions = {},
  now = new Date(),
): ScanJobSnapshot {
  if (snapshot.state !== "RUNNING" || snapshot.currentStage === undefined) {
    throw new Error("Only a running scan stage can be completed");
  }
  if (options.degradedReason !== undefined && !isOptionalScanStage(snapshot.currentStage)) {
    throw new Error(`${snapshot.currentStage} is not an optional scan stage`);
  }

  const timestamp = iso(now);
  const startedAt = snapshot.stageTimings[snapshot.currentStage]?.startedAt;
  if (startedAt === undefined) {
    throw new Error(`Missing start timing for ${snapshot.currentStage}`);
  }
  const stageTimings = {
    ...snapshot.stageTimings,
    [snapshot.currentStage]: {
      completedAt: timestamp,
      durationMs: Math.max(0, now.getTime() - new Date(startedAt).getTime()),
      startedAt,
    },
  };
  const completedStages = [...snapshot.completedStages, snapshot.currentStage];
  const degradedReasons =
    options.degradedReason === undefined
      ? snapshot.degradedReasons
      : [...snapshot.degradedReasons, options.degradedReason];
  const nextStage = nextScanStage(snapshot.currentStage);

  if (nextStage === undefined) {
    const { currentStage, ...withoutCurrentStage } = snapshot;
    void currentStage;
    return Object.freeze({
      ...withoutCurrentStage,
      completedAt: timestamp,
      completedStages,
      degradedReasons,
      stageTimings,
      state: "COMPLETED",
      updatedAt: timestamp,
    });
  }

  return startStage(
    {
      ...snapshot,
      completedStages,
      degradedReasons,
      stageTimings,
    },
    nextStage,
    now,
  );
}

export function failCurrentStage(
  snapshot: ScanJobSnapshot,
  message: string,
  recoverable: boolean,
  now = new Date(),
): ScanJobSnapshot {
  if (snapshot.state !== "RUNNING" || snapshot.currentStage === undefined) {
    throw new Error("Only a running scan stage can fail");
  }
  const timestamp = iso(now);
  return Object.freeze({
    ...snapshot,
    error: {
      message: message.trim() || "Unknown scan failure",
      recoverable,
      stage: snapshot.currentStage,
    },
    state: "FAILED",
    updatedAt: timestamp,
  });
}

export function resumeScan(snapshot: ScanJobSnapshot, now = new Date()): ScanJobSnapshot {
  if (snapshot.state !== "FAILED" || snapshot.error?.recoverable !== true) {
    throw new Error("Only a recoverable failed scan can resume");
  }
  const stage = snapshot.error.stage;
  const { error, ...withoutError } = snapshot;
  void error;
  return startStage({ ...withoutError, attempt: snapshot.attempt + 1 }, stage, now);
}

export function cancelScan(snapshot: ScanJobSnapshot, now = new Date()): ScanJobSnapshot {
  if (snapshot.state === "COMPLETED" || snapshot.state === "CANCELLED") {
    throw new Error(`Cannot cancel scan from ${snapshot.state}`);
  }
  const { currentStage, ...withoutCurrentStage } = snapshot;
  void currentStage;
  return Object.freeze({
    ...withoutCurrentStage,
    state: "CANCELLED",
    updatedAt: iso(now),
  });
}
