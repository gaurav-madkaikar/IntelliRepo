export const INTELLIREPO_GITHUB_COMMENT_MARKER = "<!-- intellirepo-pr-analysis -->";

export interface GitHubPullRequestIdentity {
  readonly owner: string;
  readonly pullNumber: number;
  readonly repository: string;
  readonly url: string;
}

export interface GitHubPullRequestMetadata extends GitHubPullRequestIdentity {
  readonly baseSha: string;
  readonly headSha: string;
  readonly isFork: boolean;
  readonly state: string;
  readonly title: string;
}

export interface GitHubChangedFile {
  readonly additions: number;
  readonly changes: number;
  readonly deletions: number;
  readonly path: string;
  readonly patch?: string;
  readonly patchState: "available" | "unavailable";
  readonly previousPath?: string;
  readonly status:
    "added" | "changed" | "copied" | "modified" | "removed" | "renamed" | "unchanged";
}

interface GitHubApiOptions {
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly token?: string;
}

interface PullResponse {
  readonly base: { readonly repo: { readonly fork: boolean }; readonly sha: string };
  readonly head: { readonly repo: { readonly fork: boolean }; readonly sha: string };
  readonly html_url: string;
  readonly number: number;
  readonly state: string;
  readonly title: string;
}

interface FileResponse {
  readonly additions: number;
  readonly changes: number;
  readonly deletions: number;
  readonly filename: string;
  readonly patch?: string;
  readonly previous_filename?: string;
  readonly status: GitHubChangedFile["status"];
}

interface CommentResponse {
  readonly body?: string;
  readonly id: number;
}

export class GitHubApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly rateLimited: boolean,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export function parseGitHubPullRequestUrl(value: string): GitHubPullRequestIdentity {
  const url = new URL(value);
  if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname)) {
    throw new Error("Pull request URL must use https://github.com");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || segments[2] !== "pull" || !/^\d+$/u.test(segments[3] ?? "")) {
    throw new Error("Expected a GitHub pull request URL in /owner/repository/pull/number form");
  }
  const pullNumber = Number(segments[3]);
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1)
    throw new Error("Invalid pull request number");
  if (![segments[0], segments[1]].every((segment) => /^[A-Za-z0-9_.-]+$/u.test(segment ?? ""))) {
    throw new Error("GitHub owner and repository names contain unsupported characters");
  }
  return {
    owner: segments[0] as string,
    pullNumber,
    repository: segments[1] as string,
    url: `https://github.com/${segments[0]}/${segments[1]}/pull/${pullNumber}`,
  };
}

export class GitHubPullRequestClient {
  private readonly apiBaseUrl: string;
  private readonly fetchImplementation: typeof fetch;

  public constructor(private readonly options: GitHubApiOptions = {}) {
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
    this.fetchImplementation = options.fetch ?? fetch;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImplementation(new URL(path, this.apiBaseUrl), {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        ...(this.options.token === undefined
          ? {}
          : { authorization: `Bearer ${this.options.token}` }),
        "x-github-api-version": "2022-11-28",
        ...init?.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const rateLimited = response.status === 403 || response.status === 429;
      throw new GitHubApiError(
        rateLimited
          ? `GitHub API rate limit or policy rejected ${path}`
          : `GitHub API returned ${response.status} for ${path}`,
        response.status,
        rateLimited,
      );
    }
    return response.json() as Promise<T>;
  }

  public async pullRequest(
    identity: GitHubPullRequestIdentity,
  ): Promise<GitHubPullRequestMetadata> {
    const pull = await this.request<PullResponse>(
      `/repos/${identity.owner}/${identity.repository}/pulls/${identity.pullNumber}`,
    );
    return {
      ...identity,
      baseSha: pull.base.sha,
      headSha: pull.head.sha,
      isFork: pull.base.repo.fork || pull.head.repo.fork,
      state: pull.state,
      title: pull.title,
    };
  }

  public async changedFiles(
    identity: GitHubPullRequestIdentity,
  ): Promise<readonly GitHubChangedFile[]> {
    const files: FileResponse[] = [];
    for (let page = 1; page <= 30; page += 1) {
      const batch = await this.request<readonly FileResponse[]>(
        `/repos/${identity.owner}/${identity.repository}/pulls/${identity.pullNumber}/files?per_page=100&page=${page}`,
      );
      files.push(...batch);
      if (batch.length < 100) break;
    }
    return files.map((file) => ({
      additions: file.additions,
      changes: file.changes,
      deletions: file.deletions,
      path: file.filename,
      ...(file.patch === undefined ? {} : { patch: file.patch }),
      patchState: file.patch === undefined ? "unavailable" : "available",
      ...(file.previous_filename === undefined ? {} : { previousPath: file.previous_filename }),
      status: file.status,
    }));
  }

  public async upsertAnalysisComment(
    identity: GitHubPullRequestIdentity,
    markdown: string,
  ): Promise<{ readonly action: "created" | "updated"; readonly commentId: number }> {
    if (this.options.token === undefined)
      throw new Error("GITHUB_TOKEN is required to publish a PR comment");
    const comments: CommentResponse[] = [];
    for (let page = 1; page <= 30; page += 1) {
      const batch = await this.request<readonly CommentResponse[]>(
        `/repos/${identity.owner}/${identity.repository}/issues/${identity.pullNumber}/comments?per_page=100&page=${page}`,
      );
      comments.push(...batch);
      if (batch.length < 100) break;
    }
    const body = `${INTELLIREPO_GITHUB_COMMENT_MARKER}\n${markdown}`;
    const current = comments.find((comment) =>
      comment.body?.includes(INTELLIREPO_GITHUB_COMMENT_MARKER),
    );
    if (current !== undefined) {
      await this.request<CommentResponse>(
        `/repos/${identity.owner}/${identity.repository}/issues/comments/${current.id}`,
        { body: JSON.stringify({ body }), method: "PATCH" },
      );
      return { action: "updated", commentId: current.id };
    }
    const created = await this.request<CommentResponse>(
      `/repos/${identity.owner}/${identity.repository}/issues/${identity.pullNumber}/comments`,
      { body: JSON.stringify({ body }), method: "POST" },
    );
    return { action: "created", commentId: created.id };
  }
}
