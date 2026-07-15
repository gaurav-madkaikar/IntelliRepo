import { describe, expect, it } from "vitest";

import { createEntityStableKey } from "./identity.js";

describe("createEntityStableKey", () => {
  it("is stable for repeated named-entity extraction", () => {
    const identity = {
      kind: "method" as const,
      language: "java" as const,
      qualifiedName: "com.example.AuthService.authenticate(java.lang.String)",
      repositoryId: "repo-1",
    };

    expect(createEntityStableKey(identity)).toBe(createEntityStableKey(identity));
  });

  it("keeps repositories and languages isolated", () => {
    const base = {
      kind: "class" as const,
      language: "kotlin" as const,
      qualifiedName: "com.example.User",
      repositoryId: "repo-1",
    };

    expect(createEntityStableKey(base)).not.toBe(
      createEntityStableKey({ ...base, repositoryId: "repo-2" }),
    );
    expect(createEntityStableKey(base)).not.toBe(
      createEntityStableKey({ ...base, language: "java" }),
    );
  });

  it("normalizes anonymous syntax paths deterministically", () => {
    expect(
      createEntityStableKey({
        kind: "function",
        language: "typescript",
        repositoryId: "repo-1",
        syntaxPath: "src\\router.ts/function[2]/arrow[0]",
      }),
    ).toBe(
      createEntityStableKey({
        kind: "function",
        language: "typescript",
        repositoryId: "repo-1",
        syntaxPath: "src/router.ts/function[2]/arrow[0]",
      }),
    );
  });

  it("rejects an identity without a name or syntax path", () => {
    expect(() => createEntityStableKey({ kind: "file", repositoryId: "repo-1" })).toThrow(
      "qualifiedName or syntaxPath",
    );
  });
});
