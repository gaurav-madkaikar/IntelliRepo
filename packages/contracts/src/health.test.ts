import { describe, expect, it, vi } from "vitest";

import { loadApplicationConfig } from "./config.js";
import { checkInfrastructureHealth } from "./health.js";

describe("checkInfrastructureHealth", () => {
  const config = loadApplicationConfig({}, "/workspace");

  it("is healthy when every dependency responds", async () => {
    const checker = vi.fn().mockResolvedValue(undefined);
    const health = await checkInfrastructureHealth(config, {
      neo4j: checker,
      ollama: checker,
      postgres: checker,
      redis: checker,
    });

    expect(health.status).toBe("healthy");
    expect(health.dependencies).toHaveLength(4);
  });

  it("is degraded when only Ollama is unavailable", async () => {
    const available = vi.fn().mockResolvedValue(undefined);
    const health = await checkInfrastructureHealth(config, {
      neo4j: available,
      ollama: vi.fn().mockRejectedValue(new Error("offline")),
      postgres: available,
      redis: available,
    });

    expect(health.status).toBe("degraded");
    expect(health.dependencies.find(({ name }) => name === "ollama")).toMatchObject({
      required: false,
      state: "down",
    });
  });

  it("is unhealthy when a structural dependency is unavailable", async () => {
    const available = vi.fn().mockResolvedValue(undefined);
    const health = await checkInfrastructureHealth(config, {
      neo4j: available,
      ollama: available,
      postgres: vi.fn().mockRejectedValue(new Error("offline")),
      redis: available,
    });

    expect(health.status).toBe("unhealthy");
  });
});
