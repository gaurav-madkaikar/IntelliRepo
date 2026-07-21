import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  askQuestionSchema,
  documentationApplySchema,
  graphNeighborhoodSchema,
  registerRepositorySchema,
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

  it("requires explicit acceptance before applying documentation", () => {
    expect(documentationApplySchema.safeParse({ accepted: false }).success).toBe(false);
    expect(documentationApplySchema.parse({ accepted: true })).toEqual({ accepted: true });
  });

  it("exports schemas that can drive OpenAPI without duplicated DTO rules", () => {
    const schema = z.toJSONSchema(registerRepositorySchema);
    expect(schema.required).toContain("rootPath");
    expect(schema.properties).toHaveProperty("rootPath");
  });
});
