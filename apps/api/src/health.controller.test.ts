import type { InfrastructureHealth } from "@intellirepo/contracts";
import { describe, expect, it, vi } from "vitest";

import { HealthController } from "./health.controller.js";
import type { HealthService } from "./health.service.js";

function health(status: InfrastructureHealth["status"]): InfrastructureHealth {
  return { dependencies: [], status, timestamp: "2026-07-15T00:00:00.000Z" };
}

describe("HealthController", () => {
  it.each([
    ["healthy", 200],
    ["degraded", 200],
    ["unhealthy", 503],
  ] as const)("maps %s application health to HTTP %s", async (state, expectedStatus) => {
    const healthService = {
      check: vi.fn().mockResolvedValue(health(state)),
    } as unknown as HealthService;
    const response = { status: vi.fn() };
    const controller = new HealthController(healthService);

    await expect(controller.check(response)).resolves.toMatchObject({ status: state });
    expect(response.status).toHaveBeenCalledWith(expectedStatus);
  });
});
