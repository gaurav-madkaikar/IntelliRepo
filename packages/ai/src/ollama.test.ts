import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { OllamaClient } from "./ollama/ollama-client.js";
import { OllamaEmbedder } from "./ollama/ollama-embedder.js";
import { OllamaStructuredGenerator } from "./ollama/ollama-generator.js";

describe("Ollama adapters", () => {
  it("uses the batch embed endpoint and validates vector cardinality", async () => {
    const request = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            embeddings: [
              [1, 0],
              [0, 1],
            ],
            model: "fixture",
          }),
        ),
      ),
    );
    const embedder = new OllamaEmbedder(
      new OllamaClient({ baseUrl: "http://ollama.test", retryCount: 0, timeoutMs: 100 }, request),
      "fixture",
    );

    await expect(embedder.embed(["one", "two"])).resolves.toEqual({
      model: "fixture",
      vectors: [
        [1, 0],
        [0, 1],
      ],
    });
    expect(request).toHaveBeenCalledWith(
      new URL("http://ollama.test/api/embed"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("requests structured chat output and rejects invalid schema responses", async () => {
    const responses = [
      new Response(JSON.stringify({ message: { content: '{"answer":42}' } })),
      new Response(JSON.stringify({ message: { content: '{"answer":"grounded"}' } })),
    ];
    const client = new OllamaClient(
      { baseUrl: "http://ollama.test", retryCount: 0, timeoutMs: 100 },
      () => Promise.resolve(responses.shift() as Response),
    );
    const generator = new OllamaStructuredGenerator(client, "fixture");
    const request = {
      jsonSchema: {
        properties: { answer: { type: "string" } },
        required: ["answer"],
        type: "object",
      },
      messages: [{ content: "answer from evidence", role: "user" as const }],
      schema: z.object({ answer: z.string() }),
    };

    await expect(generator.generate(request)).resolves.toEqual({ answer: "grounded" });
    expect(responses).toHaveLength(0);
  });

  it("retries one transient request failure", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ embeddings: [[1]] })));
    const embedder = new OllamaEmbedder(
      new OllamaClient({ baseUrl: "http://ollama.test", timeoutMs: 100 }, request),
      "fixture",
    );

    await expect(embedder.embed(["retry"])).resolves.toMatchObject({ vectors: [[1]] });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
