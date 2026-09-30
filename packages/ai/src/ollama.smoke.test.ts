import { describe, expect, it } from "vitest";
import { z } from "zod";

import { OllamaClient } from "./ollama/ollama-client.js";
import { OllamaEmbedder } from "./ollama/ollama-embedder.js";
import { OllamaStructuredGenerator } from "./ollama/ollama-generator.js";

const describeWithOllama = process.env.RUN_OLLAMA_SMOKE === "true" ? describe : describe.skip;
const describeWithEmbedding =
  process.env.RUN_OLLAMA_EMBEDDING_SMOKE === "true" ? describe : describe.skip;

describeWithEmbedding("configured Ollama embedding smoke test", () => {
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

describeWithOllama("configured Ollama generation smoke test", () => {
  it("returns citation-shaped grounded structured output", async () => {
    const generator = new OllamaStructuredGenerator(
      new OllamaClient({
        baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
        retryCount: 0,
        timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 120_000),
      }),
      process.env.OLLAMA_GENERATION_MODEL ?? "qwen3.5:9b",
    );
    const schema = z.object({ answer: z.string().min(1), citationIds: z.array(z.literal("E1")) });
    const result = await generator.generate({
      jsonSchema: {
        additionalProperties: false,
        properties: {
          answer: { type: "string" },
          citationIds: { items: { const: "E1", type: "string" }, type: "array" },
        },
        required: ["answer", "citationIds"],
        type: "object",
      },
      messages: [
        {
          content:
            "Return JSON only. Evidence E1 says IntelliRepo uses PostgreSQL as its canonical store. Answer which canonical store is used and cite E1.",
          role: "user",
        },
      ],
      schema,
    });
    expect(result.answer.toLowerCase()).toContain("postgresql");
    expect(result.citationIds).toContain("E1");
  }, 120_000);
});
