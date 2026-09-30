import { describe, expect, it, vi } from "vitest";

import { BullMqScanDispatcher, type BullMqQueuePort } from "./bullmq-scan-dispatcher.js";
import { InlineScanDispatcher } from "./inline-scan-dispatcher.js";

const input = { repositoryId: "repository-1", revisionId: "revision-1", scanJobId: "scan-1" };

describe("scan dispatchers", () => {
  it("publishes one deterministic BullMQ scan job", async () => {
    const queue = {
      add: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
    } satisfies BullMqQueuePort;
    const dispatcher = new BullMqScanDispatcher(queue, { attempts: 3, backoffMs: 1_000 });

    await dispatcher.dispatch(input);

    expect(queue.add).toHaveBeenCalledWith(
      "scan",
      input,
      expect.objectContaining({ attempts: 3, jobId: input.scanJobId }),
    );
    await dispatcher.close();
    expect(queue.close).toHaveBeenCalledOnce();
  });

  it("schedules inline execution after durable dispatch acceptance", async () => {
    const execute = vi.fn(() => Promise.resolve());
    const dispatcher = new InlineScanDispatcher({ execute });

    const accepted = dispatcher.dispatch(input);
    expect(execute).not.toHaveBeenCalled();
    await accepted;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(execute).toHaveBeenCalledWith(input.scanJobId);
  });
});
