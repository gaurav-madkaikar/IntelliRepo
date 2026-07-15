import { SCAN_STAGES } from "@intellirepo/contracts";
import type { FlowJob } from "bullmq";
import { describe, expect, it } from "vitest";

import { buildScanFlow, type ScanStageJobData } from "./bullmq-scan-queue.js";

function executionOrder(flow: FlowJob): readonly string[] {
  return [...(flow.children?.flatMap(executionOrder) ?? []), flow.name];
}

describe("buildScanFlow", () => {
  it("builds a child-first BullMQ chain in scan-stage order", () => {
    const flow = buildScanFlow({ repositoryId: "repository-1", revisionId: "revision-1" });
    expect(executionOrder(flow)).toEqual(SCAN_STAGES);

    const data = flow.data as ScanStageJobData;
    expect(data.scanJobId).toMatch(/^scan-/u);
    expect(flow.opts?.jobId).not.toContain(":");
  });
});
