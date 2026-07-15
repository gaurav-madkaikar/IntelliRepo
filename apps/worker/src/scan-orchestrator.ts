import type { ScanJobRequest, ScanJobSnapshot } from "@intellirepo/contracts";

import type { ScanQueue } from "./queues/scan-queue.js";
import { createQueuedScan } from "./scan-state-machine.js";

export interface ScanJobStore {
  findById(id: string): Promise<ScanJobSnapshot | undefined>;
  save(snapshot: ScanJobSnapshot): Promise<void>;
}

export class ScanOrchestrator {
  public constructor(
    private readonly queue: ScanQueue,
    private readonly store: ScanJobStore,
  ) {}

  public async enqueue(request: ScanJobRequest, now = new Date()): Promise<ScanJobSnapshot> {
    const queued = createQueuedScan(request, now);
    const existing = await this.store.findById(queued.id);

    if (existing !== undefined && existing.state !== "FAILED") {
      return existing;
    }

    await this.store.save(queued);
    await this.queue.enqueue(request);
    return queued;
  }
}
