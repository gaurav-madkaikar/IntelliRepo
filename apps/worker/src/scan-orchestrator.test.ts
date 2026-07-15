import type { ScanJobSnapshot } from "@intellirepo/contracts";
import { describe, expect, it, vi } from "vitest";

import type { ScanQueue } from "./queues/scan-queue.js";
import { ScanOrchestrator, type ScanJobStore } from "./scan-orchestrator.js";

describe("ScanOrchestrator", () => {
  it("enqueues a deterministic scan once", async () => {
    const snapshots = new Map<string, ScanJobSnapshot>();
    const queue = {
      close: vi.fn(),
      enqueue: vi.fn().mockResolvedValue("scan-id"),
    } satisfies ScanQueue;
    const store = {
      findById: (id: string) => Promise.resolve(snapshots.get(id)),
      save: (snapshot: ScanJobSnapshot) => {
        snapshots.set(snapshot.id, snapshot);
        return Promise.resolve();
      },
    } satisfies ScanJobStore;
    const orchestrator = new ScanOrchestrator(queue, store);
    const request = { repositoryId: "repository-1", revisionId: "revision-1" };

    const first = await orchestrator.enqueue(request);
    const replay = await orchestrator.enqueue(request);

    expect(replay.id).toBe(first.id);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });
});
