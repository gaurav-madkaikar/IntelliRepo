import { describe, expect, it, vi } from "vitest";

import { loadApplicationConfig } from "./config.js";
import { checkInfrastructureHealth } from "./health.js";

describe("checkInfrastructureHealth", () => {
  const config = loadApplicationConfig({ OLLAMA_ENABLED: "false" }, "/workspace");

  it("is healthy when optional dependencies are disabled", async () => {
    const checker = vi.fn().mockResolvedValue(undefined);
    const health = await checkInfrastructureHealth(config, {
      ollama: checker,
      postgres: checker,
      redis: checker,
    });

    expect(health.status).toBe("healthy");
    expect(health.dependencies).toHaveLength(3);
    expect(checker).toHaveBeenCalledTimes(2);
    expect(health.dependencies.find(({ name }) => name === "ollama")).toMatchObject({
      required: false,
      state: "disabled",
    });
  });

  it("is degraded when an enabled optional dependency is unavailable", async () => {
    const available = vi.fn().mockResolvedValue(undefined);
    const enabledConfig = loadApplicationConfig({ OLLAMA_ENABLED: "true" }, "/workspace");
    const health = await checkInfrastructureHealth(enabledConfig, {
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

  it("disables Redis in explicit inline mode", async () => {
    const available = vi.fn().mockResolvedValue(undefined);
    const redis = vi.fn().mockRejectedValue(new Error("offline"));
    const inlineConfig = loadApplicationConfig(
      { INDEXING_MODE: "inline", OLLAMA_ENABLED: "false" },
      "/workspace",
    );
    const health = await checkInfrastructureHealth(inlineConfig, {
      ollama: available,
      postgres: available,
      redis,
    });

    expect(redis).not.toHaveBeenCalled();
    expect(health.status).toBe("healthy");
    expect(health.dependencies.find(({ name }) => name === "redis")).toMatchObject({
      required: false,
      state: "disabled",
    });
  });

  it("is unhealthy when a structural dependency is unavailable", async () => {
    const available = vi.fn().mockResolvedValue(undefined);
    const health = await checkInfrastructureHealth(config, {
      ollama: available,
      postgres: vi.fn().mockRejectedValue(new Error("offline")),
      redis: available,
    });

    expect(health.status).toBe("unhealthy");
  });
});
