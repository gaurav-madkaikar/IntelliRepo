import type { LoadedRepositoryArtifact } from "@intellirepo/repository";
import { describe, expect, it } from "vitest";

import { selectSemanticSources } from "./semantic-source-builder.js";

function artifact(
  path: string,
  artifactKind: LoadedRepositoryArtifact["decision"]["artifactKind"],
  content: string,
): LoadedRepositoryArtifact {
  return {
    content,
    contentHash: `hash-${path}`,
    decision: { artifactKind, normalizedPath: path, supported: true },
    path,
    sizeBytes: content.length,
  };
}

describe("selectSemanticSources", () => {
  it("selects useful public code per artifact and Markdown per section", () => {
    const sources = selectSemanticSources({
      artifacts: [
        artifact(
          "src/auth.ts",
          "code",
          "// Authentication workflow with request validation\nexport function authenticate() { return validate(); }",
        ),
        artifact("src/private.ts", "code", "private function helper() { return true; }"),
        artifact(
          "docs/auth.md",
          "documentation",
          "# Authentication\n\nExplains the complete authentication request flow and failure behavior.\n\n## Tokens\n\nExplains token creation and validation behavior.",
        ),
        artifact("pnpm-lock.yaml", "build", "lockfileVersion: 9"),
      ],
      entities: [
        {
          artifactPath: "src/auth.ts",
          attributes: { visibility: "public" },
          kind: "function",
          stableKey: "auth",
        },
        {
          artifactPath: "src/private.ts",
          attributes: { visibility: "private" },
          kind: "function",
          stableKey: "private",
        },
      ],
      repositoryId: "repo",
      revisionId: "revision",
      sourceArtifactIds: new Map([
        ["src/auth.ts", "artifact-auth"],
        ["src/private.ts", "artifact-private"],
        ["docs/auth.md", "artifact-doc"],
        ["pnpm-lock.yaml", "artifact-lock"],
      ]),
    });

    expect(sources.map(({ sourceId }) => sourceId)).toEqual([
      "artifact-auth",
      "artifact-doc#section-1",
      "artifact-doc#section-2",
    ]);
    expect(sources[0]?.metadata?.selectedEntityKeys).toEqual(["auth"]);
    expect(sources.every(({ repositoryId }) => repositoryId === "repo")).toBe(true);
  });
});
