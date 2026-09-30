import type { Embedder } from "@intellirepo/ai";
import { describe, expect, it, vi } from "vitest";

import { createSemanticChunks } from "./chunker.js";
import type {
  SemanticChunkStore,
  SemanticSearchResult,
  StoredSemanticChunk,
} from "./embedding-model.js";
import { SemanticProjector } from "./projector.js";
import { redactSecrets } from "./redactor.js";
import { SemanticRetriever } from "./retriever.js";

class MemoryChunkStore implements SemanticChunkStore {
  public readonly chunks = new Map<string, Map<string, StoredSemanticChunk>>();
  public readonly searches: string[] = [];

  public delete(repositoryId: string, chunkIds: readonly string[]): Promise<void> {
    for (const id of chunkIds) this.chunks.get(repositoryId)?.delete(id);
    return Promise.resolve();
  }

  public list(repositoryId: string): Promise<readonly StoredSemanticChunk[]> {
    return Promise.resolve([...(this.chunks.get(repositoryId) ?? new Map()).values()]);
  }

  public retag(
    repositoryId: string,
    chunkIds: readonly string[],
    revisionId: string,
  ): Promise<void> {
    const repository = this.chunks.get(repositoryId);
    for (const id of chunkIds) {
      const chunk = repository?.get(id);
      if (chunk !== undefined) repository?.set(id, { ...chunk, revisionId });
    }
    return Promise.resolve();
  }

  public search(
    repositoryId: string,
    _vector: readonly number[],
    limit: number,
    revisionId?: string,
  ): Promise<readonly SemanticSearchResult[]> {
    this.searches.push(repositoryId);
    return Promise.resolve(
      [...(this.chunks.get(repositoryId) ?? new Map()).values()]
        .filter((chunk) => revisionId === undefined || chunk.revisionId === revisionId)
        .slice(0, limit)
        .map((chunk) => ({ chunk, similarity: 0.9 })),
    );
  }

  public upsert(repositoryId: string, chunks: readonly StoredSemanticChunk[]): Promise<void> {
    const repository = this.chunks.get(repositoryId) ?? new Map<string, StoredSemanticChunk>();
    this.chunks.set(repositoryId, repository);
    for (const chunk of chunks) repository.set(chunk.id, chunk);
    return Promise.resolve();
  }
}

const source = (content: string) => ({
  artifactKind: "code" as const,
  content,
  endLine: 10,
  language: "typescript",
  path: "src/auth.ts",
  sourceId: "artifact-auth",
  sourceKind: "source" as const,
  startLine: 1,
});

describe("selective semantic chunks", () => {
  it("embeds only useful source and documentation spans with observable eligibility", () => {
    expect(
      createSemanticChunks(
        source(
          "// Authentication workflow\nexport async function authenticate(user: User) {\n  return verify(user);\n}",
        ),
      )[0]?.metadata.eligibilityReason,
    ).toBe("explanatory source span");
    expect(
      createSemanticChunks({
        artifactKind: "build",
        content: "x".repeat(200),
        path: "dist/generated.js",
        sourceId: "entity-per-row",
        sourceKind: "source",
      }),
    ).toEqual([]);
    expect(
      createSemanticChunks({
        content: "This section explains authentication, token validation, and its failure modes.",
        path: "docs/auth.md",
        sourceId: "doc-section-auth",
        sourceKind: "documentation",
      }),
    ).toHaveLength(1);
  });

  it("redacts likely secrets before content leaves the deterministic chunker", () => {
    const result = redactSecrets(
      "password = super-secret\nAuthorization: Bearer abcdefghijklmnop\nmongodb://user:hunter2@db.local/app",
    );

    expect(result.redactionCount).toBe(3);
    expect(result.content).not.toContain("super-secret");
    expect(result.content).not.toContain("abcdefghijklmnop");
    expect(result.content).not.toContain("hunter2");
  });

  it("embeds changed chunks and retains unchanged checksums", async () => {
    const store = new MemoryChunkStore();
    const seen: string[][] = [];
    const embedder: Embedder = {
      embed: (input) => {
        seen.push([...input]);
        return Promise.resolve({ model: "fixture", vectors: input.map(() => [1, 0, 0]) });
      },
    };
    const projector = new SemanticProjector(store, embedder);
    const firstSource = source(
      "// Authentication workflow\nexport async function authenticate(user: User) {\n  const password = super-secret;\n  return verify(user);\n}",
    );

    await expect(
      projector.project({ repositoryId: "repo-a", revisionId: "r1", sources: [firstSource] }),
    ).resolves.toMatchObject({ embedded: 1, retained: 0, state: "current" });
    await expect(
      projector.project({ repositoryId: "repo-a", revisionId: "r2", sources: [firstSource] }),
    ).resolves.toMatchObject({ embedded: 0, retained: 1, state: "current" });
    await projector.project({
      repositoryId: "repo-a",
      revisionId: "r3",
      sources: [{ ...firstSource, content: `${firstSource.content}\n// Token refresh behavior.` }],
    });

    expect(seen).toHaveLength(5);
    expect(seen[1]?.join(" ")).not.toContain("super-secret");
    expect(seen[4]).toHaveLength(1);
    expect([...(store.chunks.get("repo-a") ?? new Map()).values()][0]?.revisionId).toBe("r3");
  });

  it("re-embeds unchanged content when the configured model changes", async () => {
    const store = new MemoryChunkStore();
    let model = "model-a";
    const embedder: Embedder = {
      embed: (input) =>
        Promise.resolve({ model, vectors: input.map(() => [model === "model-a" ? 1 : 2]) }),
    };
    const projector = new SemanticProjector(store, embedder);
    const useful = source(
      "// Authentication behavior and validation details\nexport function authenticate() { return validateCredentials(); }",
    );
    await projector.project({ repositoryId: "repo", revisionId: "r1", sources: [useful] });
    model = "model-b";

    await expect(
      projector.project({ repositoryId: "repo", revisionId: "r2", sources: [useful] }),
    ).resolves.toMatchObject({ embedded: 1, model: "model-b", retained: 0 });
  });

  it("keeps semantic retrieval repository scoped", async () => {
    const store = new MemoryChunkStore();
    await store.upsert("repo-a", [
      {
        ...(createSemanticChunks(
          source(
            "// Explains repository A authentication behavior and request validation\nexport function alpha() { return validateAndReturn(true); }",
          ),
        )[0] as StoredSemanticChunk),
        revisionId: "r1",
        vector: [1, 0],
      },
    ]);
    await store.upsert("repo-b", [
      {
        ...(createSemanticChunks(
          source(
            "// Explains repository B payment behavior and request validation\nexport function beta() { return validateAndReturn(false); }",
          ),
        )[0] as StoredSemanticChunk),
        id: "repo-b-chunk",
        revisionId: "r1",
        vector: [0, 1],
      },
    ]);
    const embedder = {
      embed: vi.fn(() => Promise.resolve({ model: "fixture", vectors: [[1, 0]] })),
    };
    const results = await new SemanticRetriever(store, embedder).search("repo-a", "alpha", 8, "r1");

    expect(store.searches).toEqual(["repo-a"]);
    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.content).toContain("repository A");
  });

  it("reports disabled and degraded projection without invalidating canonical facts", async () => {
    const store = new MemoryChunkStore();
    const disabled = new SemanticProjector(store);
    await expect(
      disabled.project({
        repositoryId: "repo",
        revisionId: "r1",
        sources: [source("x".repeat(100))],
      }),
    ).resolves.toMatchObject({ state: "disabled" });
    const degraded = new SemanticProjector(store, {
      embed: () => Promise.reject(new Error("Ollama unavailable")),
    });
    await expect(
      degraded.project({
        repositoryId: "repo",
        revisionId: "r1",
        sources: [source("// Explanation\nexport function useful() { return true; }".repeat(3))],
      }),
    ).resolves.toMatchObject({
      state: "degraded",
      statusReason: expect.stringContaining("Ollama"),
    });
  });
});
