import { Queue, type JobsOptions } from "bullmq";

import type { DispatchScanInput, ScanDispatcher } from "./scan-dispatcher.js";

export const SCAN_QUEUE_NAME = "intellirepo.scan";

export interface BullMqQueuePort {
  add(name: string, data: DispatchScanInput, options: JobsOptions): Promise<unknown>;
  close(): Promise<void>;
}

export interface BullMqDispatchOptions {
  readonly attempts: number;
  readonly backoffMs: number;
}

export class BullMqScanDispatcher implements ScanDispatcher {
  public constructor(
    private readonly queue: BullMqQueuePort,
    private readonly options: BullMqDispatchOptions,
  ) {
    if (!Number.isInteger(options.attempts) || options.attempts < 1) {
      throw new Error("BullMQ attempts must be a positive integer");
    }
    if (!Number.isInteger(options.backoffMs) || options.backoffMs < 0) {
      throw new Error("BullMQ backoff must be a non-negative integer");
    }
  }

  public static connect(redisUrl: string, options: BullMqDispatchOptions): BullMqScanDispatcher {
    const queue = new Queue<DispatchScanInput>(SCAN_QUEUE_NAME, {
      connection: { lazyConnect: true, maxRetriesPerRequest: null, url: redisUrl },
    });
    return new BullMqScanDispatcher(queue, options);
  }

  public async dispatch(input: DispatchScanInput): Promise<void> {
    await this.queue.add("scan", input, {
      attempts: this.options.attempts,
      backoff: { delay: this.options.backoffMs, type: "exponential" },
      jobId: input.scanJobId,
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  }

  public async close(): Promise<void> {
    await this.queue.close();
  }
}
