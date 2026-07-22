import { describe, expect, it, vi } from "vitest";

import { OllamaClient } from "./ollama-client.js";
import { OllamaRuntime } from "./ollama-runtime.js";

function runtime(fetchImplementation: typeof fetch, clock: () => Date = () => new Date(0)) {
  return new OllamaRuntime(
    new OllamaClient(
      { baseUrl: "http://ollama.test", retryCount: 0, timeoutMs: 20 },
      fetchImplementation,
    ),
    {
      cooldownMs: 1_000,
      embeddingModel: "nomic-embed-text",
      generationModel: "qwen2.5-coder",
      healthyTtlMs: 100,
    },
    clock,
  );
}

describe("OllamaRuntime", () => {
  it("constructs only adapters backed by healthy local models", async () => {
    const healthy = runtime(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            models: [{ name: "nomic-embed-text:latest" }, { model: "qwen2.5-coder" }],
          }),
        ),
      ),
    );
    await expect(healthy.inspect()).resolves.toMatchObject({
      embeddingAvailable: true,
      generationAvailable: true,
      state: "available",
    });

    const partial = runtime(() =>
      Promise.resolve(
        new Response(JSON.stringify({ models: [{ name: "nomic-embed-text:latest" }] })),
      ),
    );
    const capabilities = await partial.inspect();
    expect(capabilities).toMatchObject({
      embeddingAvailable: true,
      generationAvailable: false,
      state: "degraded",
    });
    expect(capabilities.embedder).toBeDefined();
    expect(capabilities.generator).toBeUndefined();
  });

  it("bounds failures with cooldown and permits forced recovery", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [{ name: "nomic-embed-text" }, { name: "qwen2.5-coder" }],
          }),
        ),
      );
    const ollama = runtime(request);

    await expect(ollama.inspect()).resolves.toMatchObject({ state: "unavailable" });
    await expect(ollama.inspect()).resolves.toMatchObject({ state: "unavailable" });
    expect(request).toHaveBeenCalledTimes(1);
    await expect(ollama.inspect(true)).resolves.toMatchObject({ state: "available" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("treats malformed model inventory as unavailable", async () => {
    await expect(
      runtime(() => Promise.resolve(new Response(JSON.stringify({ models: "invalid" })))).inspect(),
    ).resolves.toMatchObject({
      reason: expect.stringContaining("malformed"),
      state: "unavailable",
    });
  });
});
