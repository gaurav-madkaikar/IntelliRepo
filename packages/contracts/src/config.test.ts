import { describe, expect, it } from "vitest";

import { loadApplicationConfig } from "./config.js";

describe("loadApplicationConfig", () => {
  it("loads safe local defaults and resolves allowed roots", () => {
    const config = loadApplicationConfig({}, "/workspace");

    expect(config.apiPort).toBe(4100);
    expect(config.neo4jEnabled).toBe(false);
    expect(config.ollamaEnabled).toBe(false);
    expect(config.repositoryAllowedRoots).toEqual([
      "/workspace/examples",
      "/workspace/.intellirepo-demo",
    ]);
    expect(config.ollamaConcurrency).toBe(1);
  });

  it("rejects invalid concurrency and empty allowed roots", () => {
    expect(() => loadApplicationConfig({ PARSER_CONCURRENCY: "0" })).toThrow();
    expect(() => loadApplicationConfig({ NEO4J_ENABLED: "sometimes" })).toThrow();
    expect(() => loadApplicationConfig({ REPOSITORY_ALLOWED_ROOTS: " , " })).toThrow(
      "REPOSITORY_ALLOWED_ROOTS",
    );
  });

  it("accepts explicit application settings", () => {
    const config = loadApplicationConfig(
      {
        API_PORT: "4200",
        MAX_FILE_BYTES: "2048",
        NEO4J_ENABLED: "true",
        NODE_ENV: "test",
        OLLAMA_ENABLED: "1",
        REPOSITORY_ALLOWED_ROOTS: "./one,/absolute/two",
      },
      "/workspace",
    );

    expect(config.apiPort).toBe(4200);
    expect(config.maxFileBytes).toBe(2048);
    expect(config.neo4jEnabled).toBe(true);
    expect(config.nodeEnv).toBe("test");
    expect(config.ollamaEnabled).toBe(true);
    expect(config.repositoryAllowedRoots).toEqual(["/workspace/one", "/absolute/two"]);
  });
});
