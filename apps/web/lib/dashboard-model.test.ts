import { describe, expect, it } from "vitest";

import { boundedResultLabel, capabilityTone } from "./dashboard-model";

describe("dashboard presentation model", () => {
  it("discloses graph truncation", () => {
    expect(boundedResultLabel(200, 200, true)).toContain("truncated");
    expect(boundedResultLabel(12, 200, false)).toContain("complete within bound");
  });

  it("does not present degraded capabilities as healthy", () => {
    expect(capabilityTone("current")).toBe("success");
    expect(capabilityTone("degraded")).toBe("warning");
    expect(capabilityTone("disabled")).toBe("neutral");
  });
});
