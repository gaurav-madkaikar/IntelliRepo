import { describe, expect, it, vi } from "vitest";

import {
  GitHubPullRequestClient,
  INTELLIREPO_GITHUB_COMMENT_MARKER,
  parseGitHubPullRequestUrl,
} from "./github-pr-client.js";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("GitHubPullRequestClient", () => {
  it("accepts only canonical GitHub pull request URLs", () => {
    expect(parseGitHubPullRequestUrl("https://www.github.com/acme/service/pull/42")).toMatchObject({
      owner: "acme",
      pullNumber: 42,
      repository: "service",
      url: "https://github.com/acme/service/pull/42",
    });
    expect(() => parseGitHubPullRequestUrl("https://example.com/acme/service/pull/42")).toThrow();
    expect(() => parseGitHubPullRequestUrl("https://github.com/acme/service/issues/42")).toThrow();
  });

  it("preserves rename and unavailable-patch evidence explicitly", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      json([
        {
          additions: 2,
          changes: 3,
          deletions: 1,
          filename: "src/new.ts",
          previous_filename: "src/old.ts",
          status: "renamed",
        },
      ]),
    );
    const files = await new GitHubPullRequestClient({ fetch: fetchImplementation }).changedFiles(
      parseGitHubPullRequestUrl("https://github.com/acme/service/pull/7"),
    );
    expect(files).toEqual([
      expect.objectContaining({
        patchState: "unavailable",
        path: "src/new.ts",
        previousPath: "src/old.ts",
        status: "renamed",
      }),
    ]);
  });

  it("updates the existing marked comment and never places the token in content", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json([{ body: `${INTELLIREPO_GITHUB_COMMENT_MARKER}\nold`, id: 91 }]))
      .mockResolvedValueOnce(json({ id: 91 }));
    const client = new GitHubPullRequestClient({
      fetch: fetchImplementation,
      token: "secret-token",
    });
    const result = await client.upsertAnalysisComment(
      parseGitHubPullRequestUrl("https://github.com/acme/service/pull/7"),
      "# Analysis",
    );
    expect(result).toEqual({ action: "updated", commentId: 91 });
    const [, init] = fetchImplementation.mock.calls[1] as [URL, RequestInit];
    expect(init.method).toBe("PATCH");
    expect(init.body).toContain(INTELLIREPO_GITHUB_COMMENT_MARKER);
    expect(init.body).not.toContain("secret-token");
  });
});
