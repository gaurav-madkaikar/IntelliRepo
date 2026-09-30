import { describe, expect, it } from "vitest";

import { loadApplicationConfig } from "./config.js";

describe("loadApplicationConfig", () => {
  it("loads safe local defaults and resolves allowed roots", () => {
    const config = loadApplicationConfig({}, "/workspace");

    expect(config.apiPort).toBe(4100);
    expect(config.indexingMode).toBe("bullmq");
    expect(config.redisUrl).toBe("redis://localhost:6379");
    expect(config.ollamaEnabled).toBe(true);
    expect(config.repositoryAllowedRoots).toEqual([
      "/workspace/examples",
      "/workspace/.intellirepo-demo",
    ]);
    expect(config.ollamaConcurrency).toBe(1);
    expect(config.workerConcurrency).toBe(2);
  });

  it("rejects invalid concurrency, lease timing, and empty allowed roots", () => {
    expect(() => loadApplicationConfig({ PARSER_CONCURRENCY: "0" })).toThrow();
    expect(() =>
      loadApplicationConfig({
        SCAN_HEARTBEAT_INTERVAL_MS: "30000",
        SCAN_LEASE_DURATION_MS: "30000",
      }),
    ).toThrow("SCAN_HEARTBEAT_INTERVAL_MS");
    expect(() => loadApplicationConfig({ REPOSITORY_ALLOWED_ROOTS: " , " })).toThrow(
      "REPOSITORY_ALLOWED_ROOTS",
    );
  });

  it("does not require or expose Redis in explicit inline mode", () => {
    const config = loadApplicationConfig(
      { GITHUB_TOKEN: "", INDEXING_MODE: "inline", REDIS_URL: "" },
      "/workspace",
    );

    expect(config.indexingMode).toBe("inline");
    expect(config.redisUrl).toBeUndefined();
    expect(config.githubToken).toBeUndefined();
  });

  it("accepts explicit application settings", () => {
    const config = loadApplicationConfig(
      {
        API_PORT: "4200",
        GITHUB_TOKEN: "runtime-only-token",
        INDEXING_MODE: "bullmq",
        MAX_FILE_BYTES: "2048",
        MAX_REPOSITORY_FILES: "2500",
        NODE_ENV: "test",
        OLLAMA_ENABLED: "0",
        REDIS_URL: "redis://cache.internal:6380",
        REPOSITORY_ALLOWED_ROOTS: "./one,/absolute/two",
        SCAN_HEARTBEAT_INTERVAL_MS: "5000",
        SCAN_LEASE_DURATION_MS: "20000",
        WORKER_CONCURRENCY: "6",
      },
      "/workspace",
    );

    expect(config.apiPort).toBe(4200);
    expect(config.githubToken).toBe("runtime-only-token");
    expect(config.maxFileBytes).toBe(2048);
    expect(config.maxRepositoryFiles).toBe(2500);
    expect(config.nodeEnv).toBe("test");
    expect(config.ollamaEnabled).toBe(false);
    expect(config.redisUrl).toBe("redis://cache.internal:6380");
    expect(config.scanHeartbeatIntervalMs).toBe(5000);
    expect(config.scanLeaseDurationMs).toBe(20000);
    expect(config.workerConcurrency).toBe(6);
    expect(config.repositoryAllowedRoots).toEqual(["/workspace/one", "/absolute/two"]);
  });
});
