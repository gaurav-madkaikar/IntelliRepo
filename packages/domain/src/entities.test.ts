import { describe, expect, it } from "vitest";

import { createConfidence } from "./confidence.js";
import type { EntityFact } from "./entities.js";
import { createEntityStableKey } from "./identity.js";
import { createProvenance } from "./provenance.js";

describe("EntityFact", () => {
  it("keeps endpoint attributes discriminated by kind", () => {
    const handlerEntityKey = createEntityStableKey({
      kind: "method",
      language: "java",
      qualifiedName: "com.example.UserController.getUser",
      repositoryId: "repo-1",
    });
    const stableKey = createEntityStableKey({
      kind: "endpoint",
      language: "java",
      qualifiedName: "GET /users/{id}",
      repositoryId: "repo-1",
    });
    const fact = {
      attributes: {
        declaredPath: "/users/{id}",
        handlerEntityKey,
        httpMethod: "GET",
        normalizedPath: "/users/{id}",
      },
      kind: "endpoint",
      language: "java",
      name: "GET /users/{id}",
      provenance: createProvenance({
        artifactPath: "src/UserController.java",
        confidence: createConfidence({
          level: "confirmed",
          reason: "Direct route annotation",
          score: 1,
        }),
        evidence: "@GetMapping",
        extractor: "spring-adapter",
        range: { start: { column: 3, line: 12 }, end: { column: 43, line: 12 } },
        repositoryRevision: "abc123",
      }),
      qualifiedName: "GET /users/{id}",
      stableKey,
    } satisfies EntityFact;

    expect(fact.attributes.handlerEntityKey).toBe(handlerEntityKey);
  });
});
