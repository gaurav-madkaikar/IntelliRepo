import type { ScanJobRequest } from "@intellirepo/contracts";

export interface ScanQueue {
  close(): Promise<void>;
  enqueue(request: ScanJobRequest): Promise<string>;
}
