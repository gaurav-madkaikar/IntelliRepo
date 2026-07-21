import { describe, expect, it } from "vitest";

import {
  createScanJobId,
  INDEXING_DISPATCH_MODES,
  isDegradableScanStage,
  isOptionalScanStage,
  isPostActivationScanStage,
  nextScanStage,
  SCAN_DISPATCH_STATES,
  scanJobSnapshotSchema,
  SCAN_STAGES,
} from "./scan-job.js";

describe("scan job contracts", () => {
  it("creates deterministic repository-scoped job IDs", () => {
    const request = { repositoryId: "repository-1", revisionId: "revision-1" };
    expect(createScanJobId(request)).toBe(createScanJobId(request));
    expect(createScanJobId(request)).not.toBe(
      createScanJobId({ ...request, repositoryId: "repository-2" }),
    );
  });

  it("defines an ordered pipeline and only treats embeddings as optional", () => {
    expect(nextScanStage("DISCOVERING")).toBe("PARSING");
    expect(nextScanStage("ANALYZING")).toBeUndefined();
    expect(SCAN_STAGES.filter(isOptionalScanStage)).toEqual(["EMBEDDING"]);
    expect(SCAN_STAGES.filter(isDegradableScanStage)).toEqual(["EMBEDDING"]);
    expect(SCAN_STAGES.filter(isPostActivationScanStage)).toEqual([
      "PROJECTING_GRAPH",
      "EMBEDDING",
      "ANALYZING",
    ]);
  });

  it("defines explicit dispatch modes and durable dispatch states", () => {
    expect(INDEXING_DISPATCH_MODES).toEqual(["bullmq", "inline"]);
    expect(SCAN_DISPATCH_STATES).toEqual(["pending", "dispatched", "failed"]);
  });

  it("rejects empty identifiers", () => {
    expect(() => createScanJobId({ repositoryId: "", revisionId: "revision-1" })).toThrow(
      "repositoryId",
    );
  });

  it("validates durable dispatch metadata and counts", () => {
    const timestamp = "2026-07-21T10:00:00.000Z";
    expect(
      scanJobSnapshotSchema.parse({
        attempt: 0,
        completedStages: [],
        counts: { discovered: 12, parsed: 4 },
        createdAt: timestamp,
        degradedReasons: [],
        dispatchMode: "bullmq",
        dispatchState: "pending",
        id: "scan-1",
        repositoryId: "repository-1",
        revisionId: "revision-1",
        stageTimings: {},
        state: "QUEUED",
        updatedAt: timestamp,
      }),
    ).toMatchObject({ dispatchMode: "bullmq", dispatchState: "pending" });

    expect(() =>
      scanJobSnapshotSchema.parse({
        attempt: 0,
        completedStages: [],
        counts: { parsed: -1 },
        createdAt: timestamp,
        degradedReasons: [],
        dispatchMode: "automatic",
        id: "scan-1",
        repositoryId: "repository-1",
        revisionId: "revision-1",
        stageTimings: {},
        state: "QUEUED",
        updatedAt: timestamp,
      }),
    ).toThrow();
  });

  it("rejects impossible lifecycle and lease combinations", () => {
    const base = {
      attempt: 1,
      completedStages: [],
      createdAt: "2026-07-21T10:00:00.000Z",
      degradedReasons: [],
      id: "scan-1",
      repositoryId: "repository-1",
      revisionId: "revision-1",
      stageTimings: {},
      updatedAt: "2026-07-21T10:00:01.000Z",
    };
    expect(() => scanJobSnapshotSchema.parse({ ...base, state: "RUNNING" })).toThrow(
      "currentStage",
    );
    expect(() =>
      scanJobSnapshotSchema.parse({
        ...base,
        lease: {
          expiresAt: "2026-07-21T10:00:02.000Z",
          heartbeatAt: "2026-07-21T10:00:03.000Z",
          owner: "worker-1",
        },
        state: "QUEUED",
      }),
    ).toThrow("lease expiry");
  });
});
