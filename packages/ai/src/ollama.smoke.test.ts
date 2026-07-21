import { describe, expect, it } from "vitest";

import { OllamaClient } from "./ollama/ollama-client.js";
import { OllamaEmbedder } from "./ollama/ollama-embedder.js";

const describeWithOllama = process.env.RUN_OLLAMA_SMOKE === "true" ? describe : describe.skip;

describeWithOllama("configured Ollama model smoke test", () => {
  it("embeds one local text without gating the normal unit suite", async () => {
    const embedder = new OllamaEmbedder(
      new OllamaClient({
        baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
        retryCount: 0,
        timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 120_000),
      }),
      process.env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text",
    );

    const result = await embedder.embed(["IntelliRepo local model compatibility check"]);
    expect(result.vectors).toHaveLength(1);
    expect(result.vectors[0]?.length).toBeGreaterThan(0);
  });
});
