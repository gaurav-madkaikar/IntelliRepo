import type {
  AskQuestionRequest,
  ChangeImpactResponse,
  DocumentationApplyRequest,
  DocumentationHealthQuery,
  DocumentationHealthResponse,
  DocumentationPreviewRequest,
  DocumentationReviewResponse,
  EntitySearchRequest,
  EntitySearchResult,
  GraphNeighborhoodRequest,
  GraphNeighborhoodResponse,
  QuestionTaskResponse,
  RepositoryOverviewResponse,
  RevisionPairRequest,
} from "@intellirepo/contracts";

const defaultBaseUrl = "http://localhost:4100";

function queryString(values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const rendered = query.toString();
  return rendered.length === 0 ? "" : `?${rendered}`;
}

export class ProductApiClient {
  public constructor(
    private readonly baseUrl = process.env.INTELLIREPO_API_URL ?? defaultBaseUrl,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      cache: "no-store",
      headers: { "content-type": "application/json", ...init?.headers },
      signal: AbortSignal.timeout(init?.method === "POST" ? 15_000 : 5_000),
    });
    if (!response.ok) throw new Error(`IntelliRepo API returned ${response.status} for ${path}`);
    return response.json() as Promise<T>;
  }

  public overview(repositoryId: string): Promise<RepositoryOverviewResponse> {
    return this.request(`/repositories/${encodeURIComponent(repositoryId)}/overview`);
  }

  public searchEntities(
    repositoryId: string,
    query: EntitySearchRequest,
  ): Promise<EntitySearchResult> {
    return this.request(
      `/repositories/${encodeURIComponent(repositoryId)}/entities${queryString({ kind: query.kind, limit: query.limit, query: query.query, revisionId: query.revisionId })}`,
    );
  }

  public graph(
    repositoryId: string,
    query: GraphNeighborhoodRequest,
  ): Promise<GraphNeighborhoodResponse> {
    return this.request(`/repositories/${encodeURIComponent(repositoryId)}/graph/neighborhood`, {
      body: JSON.stringify(query),
      method: "POST",
    });
  }

  public impact(repositoryId: string, query: RevisionPairRequest): Promise<ChangeImpactResponse> {
    return this.request(
      `/repositories/${encodeURIComponent(repositoryId)}/impact${queryString(query)}`,
    );
  }

  public documentationHealth(
    repositoryId: string,
    query: DocumentationHealthQuery,
  ): Promise<DocumentationHealthResponse> {
    return this.request(
      `/repositories/${encodeURIComponent(repositoryId)}/documentation/health${queryString(query)}`,
    );
  }

  public previewDocumentation(
    repositoryId: string,
    input: DocumentationPreviewRequest,
  ): Promise<DocumentationReviewResponse> {
    return this.request<DocumentationReviewResponse>(
      `/repositories/${encodeURIComponent(repositoryId)}/documentation/previews`,
      { body: JSON.stringify(input), method: "POST" },
    );
  }

  public applyDocumentation(
    repositoryId: string,
    reviewId: string,
    input: DocumentationApplyRequest,
  ): Promise<{ readonly applied: true }> {
    return this.request<{ readonly applied: true }>(
      `/repositories/${encodeURIComponent(repositoryId)}/documentation/previews/${encodeURIComponent(reviewId)}/apply`,
      { body: JSON.stringify(input), method: "POST" },
    );
  }

  public submitQuestion(
    repositoryId: string,
    input: AskQuestionRequest,
  ): Promise<QuestionTaskResponse> {
    return this.request(`/repositories/${encodeURIComponent(repositoryId)}/questions`, {
      body: JSON.stringify(input),
      method: "POST",
    });
  }

  public question(repositoryId: string, taskId: string): Promise<QuestionTaskResponse> {
    return this.request(
      `/repositories/${encodeURIComponent(repositoryId)}/questions/${encodeURIComponent(taskId)}`,
    );
  }
}

export type LiveDashboardData =
  | { readonly mode: "error"; readonly reason: string }
  | { readonly mode: "live"; readonly overview: RepositoryOverviewResponse };

export async function loadDashboardData(repositoryId: string): Promise<LiveDashboardData> {
  try {
    return { mode: "live", overview: await new ProductApiClient().overview(repositoryId) };
  } catch (error) {
    return {
      mode: "error",
      reason: error instanceof Error ? error.message : "Product API unavailable",
    };
  }
}
