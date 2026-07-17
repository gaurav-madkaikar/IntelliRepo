import { describe, expect, it, vi } from "vitest";

import { loadApplicationConfig } from "./config.js";
import { checkInfrastructureHealth } from "./health.js";

describe("checkInfrastructureHealth", () => {
  const config = loadApplicationConfig({}, "/workspace");

  it("is healthy when optional dependencies are disabled", async () => {
    const checker = vi.fn().mockResolvedValue(undefined);
    const health = await checkInfrastructureHealth(config, {
      neo4j: checker,
      ollama: checker,
      postgres: checker,
      redis: checker,
    });

    expect(health.status).toBe("healthy");
    expect(health.dependencies).toHaveLength(4);
    expect(checker).toHaveBeenCalledTimes(2);
    expect(health.dependencies.find(({ name }) => name === "neo4j")).toMatchObject({
      required: false,
      state: "disabled",
    });
    expect(health.dependencies.find(({ name }) => name === "ollama")).toMatchObject({
      required: false,
      state: "disabled",
    });
  });

  it("is degraded when an enabled optional dependency is unavailable", async () => {
    const available = vi.fn().mockResolvedValue(undefined);
    const enabledConfig = loadApplicationConfig(
      { NEO4J_ENABLED: "true", OLLAMA_ENABLED: "true" },
      "/workspace",
    );
    const health = await checkInfrastructureHealth(enabledConfig, {
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

  it("checks an enabled Neo4j adapter without making it required", async () => {
    const available = vi.fn().mockResolvedValue(undefined);
    const neo4j = vi.fn().mockRejectedValue(new Error("offline"));
    const enabledConfig = loadApplicationConfig({ NEO4J_ENABLED: "true" }, "/workspace");
    const health = await checkInfrastructureHealth(enabledConfig, {
      neo4j,
      ollama: available,
      postgres: available,
      redis: available,
    });

    expect(neo4j).toHaveBeenCalledOnce();
    expect(health.status).toBe("degraded");
    expect(health.dependencies.find(({ name }) => name === "neo4j")).toMatchObject({
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
