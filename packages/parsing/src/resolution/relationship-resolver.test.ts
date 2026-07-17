import {
  createConfidence,
  createEntityStableKey,
  createProvenance,
  type EntityFact,
} from "@intellirepo/domain";
import { describe, expect, it } from "vitest";

import type { ArtifactExtractionResult } from "../interfaces/extraction.js";
import { resolveAffectedRelationships } from "./relationship-resolver.js";

function entity(path: string, language: "java" | "typescript", name: string): EntityFact {
  return {
    attributes: {},
    kind: "function",
    language,
    name,
    provenance: createProvenance({
      artifactPath: path,
      confidence: createConfidence({ level: "confirmed", reason: "fixture", score: 1 }),
      evidence: name,
      extractor: "fixture",
      range: { start: { column: 1, line: 1 }, end: { column: 2, line: 1 } },
      repositoryRevision: "revision-2",
    }),
    qualifiedName: `${path}.${name}`,
    stableKey: createEntityStableKey({
      kind: "function",
      language,
      qualifiedName: `${path}.${name}`,
      repositoryId: "repository-1",
    }),
  };
}

describe("resolveAffectedRelationships", () => {
  it("uses unchanged canonical entities as context without returning them for activation", () => {
    const changed = entity("src/caller.ts", "typescript", "caller");
    const unchanged = entity("src/Service.java", "java", "serve");
    const result: ArtifactExtractionResult = {
      artifactPath: "src/caller.ts",
      diagnostics: [],
      entities: [changed],
      mode: "semantic",
      relationships: [],
      unresolvedReferences: [
        {
          artifactPath: "src/caller.ts",
          candidateEntityKeys: [],
          kind: "call",
          name: "serve",
          range: { start: { column: 1, line: 2 }, end: { column: 6, line: 2 } },
          sourceEntityKey: changed.stableKey,
        },
      ],
    };

    const resolved = resolveAffectedRelationships({
      changedArtifacts: [result],
      repositoryId: "repository-1",
      revisionId: "revision-2",
      unchangedEntities: [unchanged],
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.entities).toEqual([changed]);
    expect(resolved[0]?.relationships).toMatchObject([
      { kind: "CALLS", source: changed.stableKey, target: unchanged.stableKey },
    ]);
  });
});
