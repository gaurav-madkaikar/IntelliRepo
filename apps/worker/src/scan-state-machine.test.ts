import { describe, expect, it } from "vitest";

import {
  cancelScan,
  completeCurrentStage,
  createQueuedScan,
  failCurrentStage,
  resumeScan,
  startScan,
} from "./scan-state-machine.js";

const request = { repositoryId: "repository-1", revisionId: "revision-1" };

describe("scan state machine", () => {
  it("advances through every stage and records timings", () => {
    let snapshot = startScan(createQueuedScan(request, new Date(0)), new Date(1_000));

    for (let index = 0; index < 7; index += 1) {
      snapshot = completeCurrentStage(snapshot, {}, new Date(2_000 + index * 1_000));
    }

    expect(snapshot.state).toBe("COMPLETED");
    expect(snapshot.completedStages).toHaveLength(7);
    expect(snapshot.stageTimings.DISCOVERING).toMatchObject({ durationMs: 1_000 });
  });

  it("records Ollama-related embedding degradation and continues analysis", () => {
    let snapshot = startScan(createQueuedScan(request));
    while (snapshot.currentStage !== "EMBEDDING") {
      snapshot = completeCurrentStage(snapshot);
    }

    snapshot = completeCurrentStage(snapshot, { degradedReason: "Ollama unavailable" });

    expect(snapshot.state).toBe("RUNNING");
    expect(snapshot.currentStage).toBe("ANALYZING");
    expect(snapshot.degradedReasons).toEqual(["Ollama unavailable"]);
  });

  it("resumes a recoverable projection failure without duplicating completed stages", () => {
    let snapshot = startScan(createQueuedScan(request));
    while (snapshot.currentStage !== "PROJECTING_GRAPH") {
      snapshot = completeCurrentStage(snapshot);
    }
    const beforeFailure = snapshot.completedStages;
    snapshot = failCurrentStage(snapshot, "Neo4j unavailable", true);
    snapshot = resumeScan(snapshot);

    expect(snapshot.attempt).toBe(2);
    expect(snapshot.currentStage).toBe("PROJECTING_GRAPH");
    expect(snapshot.completedStages).toEqual(beforeFailure);
    expect(snapshot.error).toBeUndefined();
  });

  it("rejects invalid transitions and supports cancellation", () => {
    const queued = createQueuedScan(request);
    expect(() => completeCurrentStage(queued)).toThrow("running");
    expect(cancelScan(queued).state).toBe("CANCELLED");
    expect(() => resumeScan(failCurrentStage(startScan(queued), "fatal", false))).toThrow(
      "recoverable",
    );
  });
});
