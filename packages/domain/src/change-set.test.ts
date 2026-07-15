import { describe, expect, it } from "vitest";

import { createArtifactChange, createChangeSet } from "./change-set.js";

describe("artifact changes", () => {
  it.each(["added", "modified", "deleted", "renamed"] as const)(
    "represents a %s artifact",
    (kind) => {
      const previous = { contentHash: "before", path: "src/Old.ts" };
      const current = {
        contentHash: "after",
        path: kind === "renamed" ? "src/New.ts" : "src/Old.ts",
      };
      const change =
        kind === "added"
          ? createArtifactChange({ current, kind })
          : kind === "deleted"
            ? createArtifactChange({ kind, previous })
            : createArtifactChange({ current, kind, previous });

      expect(change.kind).toBe(kind);
    },
  );

  it("rejects invalid rename and modify path semantics", () => {
    const state = { contentHash: "hash", path: "src/file.ts" };
    expect(() =>
      createArtifactChange({ current: state, kind: "renamed", previous: state }),
    ).toThrow("change path");
    expect(() =>
      createArtifactChange({
        current: { ...state, path: "src/new.ts" },
        kind: "modified",
        previous: state,
      }),
    ).toThrow("retain its path");
  });

  it("rejects duplicate current paths in a change set", () => {
    expect(() =>
      createChangeSet({
        baseRevision: "base",
        changes: [
          { current: { contentHash: "one", path: "src/file.ts" }, kind: "added" },
          {
            current: { contentHash: "two", path: "src/file.ts" },
            kind: "modified",
            previous: { contentHash: "one", path: "src/file.ts" },
          },
        ],
        repositoryId: "repo-1",
        targetRevision: "target",
      }),
    ).toThrow("duplicate current artifact paths");
  });
});
