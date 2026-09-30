import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  askQuestionSchema,
  documentationApplySchema,
  graphNeighborhoodSchema,
  registerRepositorySchema,
  triggerScanSchema,
  type RepositoryOverviewResponse,
} from "./product-api.js";

describe("product API contracts", () => {
  it("normalizes bounded graph queries", () => {
    expect(graphNeighborhoodSchema.parse({ startEntityKeys: ["endpoint:GET:/users"] })).toEqual({
      direction: "both",
      maxDepth: 3,
      maxNodes: 200,
      mode: "neighborhood",
      relationshipKinds: [],
      startEntityKeys: ["endpoint:GET:/users"],
    });
    expect(() =>
      graphNeighborhoodSchema.parse({ maxNodes: 1_001, startEntityKeys: ["entity"] }),
    ).toThrow();
  });

  it("rejects empty repository paths and low-information questions", () => {
    expect(() => registerRepositorySchema.parse({ rootPath: " " })).toThrow();
    expect(() => askQuestionSchema.parse({ question: "?" })).toThrow();
  });

  it("allows the server to capture the current scan target", () => {
    expect(triggerScanSchema.parse({})).toEqual({});
    expect(
      triggerScanSchema.parse({ commitSha: "abc123", worktreeFingerprint: "fingerprint" }),
    ).toEqual({ commitSha: "abc123", worktreeFingerprint: "fingerprint" });
  });

  it("requires explicit acceptance before applying documentation", () => {
    expect(documentationApplySchema.safeParse({ accepted: false }).success).toBe(false);
    expect(documentationApplySchema.parse({ accepted: true })).toEqual({ accepted: true });
  });

  it("exports schemas that can drive OpenAPI without duplicated DTO rules", () => {
    const schema = z.toJSONSchema(registerRepositorySchema);
    expect(schema.required).toContain("rootPath");
    expect(schema.properties).toHaveProperty("rootPath");
  });

  it("keeps PostgreSQL as the only advertised traversal adapter", () => {
    const overview = {
      capabilities: {
        analysis: { detail: "current", lagRevisions: 0, state: "current" },
        canonical: { detail: "current", lagRevisions: 0, state: "current" },
        ollama: { detail: "available", lagRevisions: 0, state: "current" },
        semantic: { detail: "current", lagRevisions: 0, state: "current" },
        worker: {
          detail: "BullMQ worker available",
          dispatchMode: "bullmq",
          lagRevisions: 0,
          state: "current",
        },
      },
      counts: {},
      repository: { displayName: "sample", id: "repository-1", rootPath: "/workspace/sample" },
      selectedTraversalAdapter: "postgresql",
    } satisfies RepositoryOverviewResponse;

    expect(overview.selectedTraversalAdapter).toBe("postgresql");
    expect(Object.keys(overview.capabilities).sort()).toEqual([
      "analysis",
      "canonical",
      "ollama",
      "semantic",
      "worker",
    ]);
  });
});
