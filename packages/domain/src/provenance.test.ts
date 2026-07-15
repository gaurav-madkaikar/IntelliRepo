import { describe, expect, it } from "vitest";

import { createConfidence } from "./confidence.js";
import { createProvenance, createSourceRange } from "./provenance.js";

describe("source provenance", () => {
  it("normalizes a repository-relative artifact path", () => {
    const provenance = createProvenance({
      artifactPath: "./src\\AuthService.java",
      confidence: createConfidence({ level: "confirmed", reason: "AST declaration", score: 1 }),
      evidence: "method_declaration",
      extractor: "java-tree-sitter",
      range: { start: { column: 3, line: 12 }, end: { column: 4, line: 18 } },
      repositoryRevision: "abc123",
    });

    expect(provenance.artifactPath).toBe("src/AuthService.java");
  });

  it("rejects invalid positions and backwards ranges", () => {
    expect(() =>
      createSourceRange({ start: { column: 0, line: 1 }, end: { column: 1, line: 1 } }),
    ).toThrow("positive integer");
    expect(() =>
      createSourceRange({ start: { column: 5, line: 3 }, end: { column: 4, line: 3 } }),
    ).toThrow("must not precede");
  });

  it("rejects paths outside the repository", () => {
    const confidence = createConfidence({ level: "confirmed", reason: "AST", score: 1 });
    expect(() =>
      createProvenance({
        artifactPath: "../secret.env",
        confidence,
        evidence: "fixture",
        extractor: "fixture",
        range: { start: { column: 1, line: 1 }, end: { column: 1, line: 1 } },
        repositoryRevision: "abc123",
      }),
    ).toThrow("repository-relative");
  });
});
