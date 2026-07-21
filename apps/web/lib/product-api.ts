import type {
  AskQuestionRequest,
  DocumentationApplyRequest,
  DocumentationHealthQuery,
  DocumentationHealthResponse,
  DocumentationPreviewRequest,
  EntitySearchRequest,
  EntitySearchResult,
  GraphNeighborhoodRequest,
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
      signal: AbortSignal.timeout(1_000),
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

  public graph(repositoryId: string, query: GraphNeighborhoodRequest): Promise<unknown> {
    return this.request(`/repositories/${encodeURIComponent(repositoryId)}/graph/neighborhood`, {
      body: JSON.stringify(query),
      method: "POST",
    });
  }

  public impact(repositoryId: string, query: RevisionPairRequest): Promise<unknown> {
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

  public previewDocumentation(repositoryId: string, input: DocumentationPreviewRequest) {
    return this.request(
      `/repositories/${encodeURIComponent(repositoryId)}/documentation/previews`,
      { body: JSON.stringify(input), method: "POST" },
    );
  }

  public applyDocumentation(
    repositoryId: string,
    reviewId: string,
    input: DocumentationApplyRequest,
  ) {
    return this.request(
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

export type DashboardDataMode =
  | { readonly mode: "live"; readonly overview: RepositoryOverviewResponse }
  | { readonly mode: "portfolio"; readonly reason: string };

export async function loadDashboardData(repositoryId: string): Promise<DashboardDataMode> {
  try {
    return { mode: "live", overview: await new ProductApiClient().overview(repositoryId) };
  } catch (error) {
    return {
      mode: "portfolio",
      reason: error instanceof Error ? error.message : "Product API unavailable",
    };
  }
}
