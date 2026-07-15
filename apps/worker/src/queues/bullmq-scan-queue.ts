import {
  createScanJobId,
  SCAN_STAGES,
  type ScanJobRequest,
  type ScanStage,
} from "@intellirepo/contracts";
import { FlowProducer, type FlowJob } from "bullmq";
import { Redis } from "ioredis";

import type { ScanQueue } from "./scan-queue.js";

export const SCAN_QUEUE_NAME = "intellirepo.scan";

export interface ScanStageJobData extends ScanJobRequest {
  readonly scanJobId: string;
  readonly stage: ScanStage;
}

export function buildScanFlow(request: ScanJobRequest): FlowJob {
  const scanJobId = createScanJobId(request);
  const stageJob = (stage: ScanStage): FlowJob => ({
    data: { ...request, scanJobId, stage } satisfies ScanStageJobData,
    name: stage,
    opts: { jobId: `${scanJobId}--${stage}` },
    queueName: SCAN_QUEUE_NAME,
  });
  let flow = stageJob(SCAN_STAGES[0]);

  for (const stage of SCAN_STAGES.slice(1)) {
    flow = { ...stageJob(stage), children: [flow] };
  }

  return flow;
}

export class BullMqScanQueue implements ScanQueue {
  private readonly connection: Redis;
  private readonly producer: FlowProducer;

  public constructor(redisUrl: string) {
    this.connection = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
    this.producer = new FlowProducer({ connection: this.connection });
  }

  public async enqueue(request: ScanJobRequest): Promise<string> {
    const scanJobId = createScanJobId(request);
    await this.producer.add(buildScanFlow(request));
    return scanJobId;
  }

  public async close(): Promise<void> {
    await this.producer.close();
    this.connection.disconnect();
  }
}
