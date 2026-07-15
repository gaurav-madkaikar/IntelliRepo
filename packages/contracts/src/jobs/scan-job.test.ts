import { describe, expect, it } from "vitest";

import { createScanJobId, isOptionalScanStage, nextScanStage, SCAN_STAGES } from "./scan-job.js";

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
  });

  it("rejects empty identifiers", () => {
    expect(() => createScanJobId({ repositoryId: "", revisionId: "revision-1" })).toThrow(
      "repositoryId",
    );
  });
});
