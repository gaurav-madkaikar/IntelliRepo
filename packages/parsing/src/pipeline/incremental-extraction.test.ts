import { createChangeSet } from "@intellirepo/domain";
import { describe, expect, it, vi } from "vitest";

import type { ProjectExtractionInput } from "../interfaces/extraction.js";
import { IncrementalExtractionCoordinator } from "./incremental-extraction.js";

describe("IncrementalExtractionCoordinator", () => {
  it("does not invoke parsers for unchanged files in a small change set", async () => {
    const artifacts = Array.from({ length: 50 }, (_, index) => ({
      artifactKind: "code" as const,
      content: `export const value${index} = ${index};`,
      language: "typescript" as const,
      path: `src/file-${index}.ts`,
    }));
    const extract = vi.fn((input: ProjectExtractionInput) =>
      Promise.resolve({
        artifacts: [],
        detection: { configPaths: [], frameworks: [], languages: [], sourceRoots: [] },
        diagnostics: [],
        repositoryId: input.repositoryId,
        revisionId: input.revisionId,
      }),
    );
    const coordinator = new IncrementalExtractionCoordinator({ extract });

    const result = await coordinator.extract({
      artifacts,
      changeSet: createChangeSet({
        baseRevision: "r1",
        changes: [
          {
            current: { contentHash: "new-1", path: "src/file-1.ts" },
            kind: "modified",
            previous: { contentHash: "old-1", path: "src/file-1.ts" },
          },
          {
            current: { contentHash: "new-2", path: "src/file-2.ts" },
            kind: "modified",
            previous: { contentHash: "old-2", path: "src/file-2.ts" },
          },
          {
            kind: "deleted",
            previous: { contentHash: "old-51", path: "src/deleted.ts" },
          },
        ],
        repositoryId: "repo",
        targetRevision: "r2",
      }),
      revisionId: "revision-id-2",
    });

    expect(extract).toHaveBeenCalledOnce();
    expect(extract.mock.calls[0]?.[0].artifacts).toHaveLength(50);
    expect(extract.mock.calls[0]?.[0].selectedArtifactPaths).toEqual([
      "src/file-1.ts",
      "src/file-2.ts",
    ]);
    expect(result).toMatchObject({
      parsedPaths: ["src/file-1.ts", "src/file-2.ts"],
      removedPaths: ["src/deleted.ts"],
    });
  });
});
