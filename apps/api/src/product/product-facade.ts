import { randomUUID } from "node:crypto";

import { OllamaClient, OllamaRuntime } from "@intellirepo/ai";
import {
  createCatalogDatabase,
  migrateCatalogToLatest,
  ProjectionStateCatalog,
  RepositoryCatalog,
  ScanJobCatalog,
  type CatalogDatabase,
  type CatalogDatabaseHandle,
} from "@intellirepo/catalog";
import {
  type ApplicationConfig,
  type AskQuestionRequest,
  type ChangeImpactResponse,
  type DocumentationHealthQuery,
  type DocumentationHealthResponse,
  type DocumentationPreviewRequest,
  type DocumentationReviewResponse,
  type EntitySearchRequest,
  type EntitySearchResult,
  type GraphNeighborhoodRequest,
  type GraphNeighborhoodResponse,
  type GitHubPullRequestAnalysisRequest,
  type GitHubPullRequestAnalysisResponse,
  type QuestionTaskResponse,
  type RegisterRepositoryRequest,
  type RepositoryOverviewResponse,
  type RevisionPairRequest,
  type ScanJobSnapshot,
  type ScanJobState,
  type ScanStage,
  type TriggerScanRequest,
} from "@intellirepo/contracts";
import {
  DocumentationCatalog,
  DocumentationGenerator,
  DocumentationReviewWorkflow,
  LocalDocumentationWorkspace,
  type DocumentationFactSnapshot,
} from "@intellirepo/documentation";
import { PostgresSemanticChunkStore, SemanticRetriever } from "@intellirepo/embeddings";
import { PostgresCanonicalGraphReader, PostgresGraphTraversal } from "@intellirepo/graph";
import {
  BullMqScanDispatcher,
  createIndexingExecutor,
  IndexingRuntimeError,
  InlineScanDispatcher,
  OutboxDispatcher,
  PostgresIndexingRuntime,
  type ScanTargetInspector,
} from "@intellirepo/indexing";
import {
  EvidencePackBuilder,
  PostgresEntityLookup,
  PostgresStructuralEvidenceReader,
  QuestionCatalog,
  QuestionTaskCatalog,
  RepositoryQuestionAnswerer,
  type RepositoryAnswer,
} from "@intellirepo/qa";
import {
  FilePolicy,
  GitChangeDetector,
  GitHubPullRequestClient,
  LocalRepositoryAdapter,
  parseGitHubPullRequestUrl,
} from "@intellirepo/repository";
import { sql, type Kysely } from "kysely";

export const PRODUCT_FACADE = Symbol("PRODUCT_FACADE");

export interface ProductDiagnostics {
  readonly analysis: { readonly state: string };
  readonly canonicalStore: "postgresql";
  readonly deterministicFeaturesAvailable: true;
  readonly ollama: { readonly enabled: boolean; readonly state: string };
  readonly repositoryId: string;
  readonly semantic: { readonly state: string };
  readonly worker: { readonly mode: "bullmq" | "inline"; readonly state: string };
}

export interface ProductFacade {
  applyDocumentation(repositoryId: string, reviewId: string): Promise<{ applied: true }>;
  diagnostics(repositoryId: string): Promise<ProductDiagnostics>;
  documentationHealth(
    repositoryId: string,
    query: DocumentationHealthQuery,
  ): Promise<DocumentationHealthResponse>;
  graph(repositoryId: string, query: GraphNeighborhoodRequest): Promise<GraphNeighborhoodResponse>;
  analyzeGitHubPullRequest(
    repositoryId: string,
    input: GitHubPullRequestAnalysisRequest,
  ): Promise<GitHubPullRequestAnalysisResponse>;
  impact(repositoryId: string, query: RevisionPairRequest): Promise<ChangeImpactResponse>;
  listRepositories(): Promise<readonly unknown[]>;
  overview(repositoryId: string): Promise<RepositoryOverviewResponse>;
  previewDocumentation(
    repositoryId: string,
    input: DocumentationPreviewRequest,
  ): Promise<DocumentationReviewResponse>;
  question(repositoryId: string, taskId: string): Promise<QuestionTaskResponse<RepositoryAnswer>>;
  registerRepository(input: RegisterRepositoryRequest): Promise<unknown>;
  retryScan(repositoryId: string, jobId: string): Promise<ScanJobSnapshot>;
  scan(repositoryId: string, jobId: string): Promise<ScanJobSnapshot>;
  searchEntities(repositoryId: string, query: EntitySearchRequest): Promise<EntitySearchResult>;
  submitQuestion(
    repositoryId: string,
    input: AskQuestionRequest,
  ): Promise<QuestionTaskResponse<RepositoryAnswer>>;
  triggerScan(repositoryId: string, input: TriggerScanRequest): Promise<ScanJobSnapshot>;
}

export class ApiResourceNotFoundError extends Error {}
export class ApiConflictError extends Error {}

function activeRevisionQuery(database: Kysely<CatalogDatabase>, repositoryId: string) {
  return database
    .selectFrom("revisions")
    .selectAll()
    .where("repository_id", "=", repositoryId)
    .where("status", "=", "active")
    .orderBy("created_at", "desc")
    .limit(1);
}

export class DatabaseResource {
  private constructor(public readonly handle: CatalogDatabaseHandle) {}

  public static async create(connectionString: string): Promise<DatabaseResource> {
    const handle = createCatalogDatabase(connectionString);
    const migration = await migrateCatalogToLatest(handle.database);
    if (migration.error !== undefined) {
      await handle.destroy();
      throw migration.error;
    }
    await new QuestionTaskCatalog(handle.database).failAbandoned(
      "API restarted while this question was running; submit it again",
    );
    return new DatabaseResource(handle);
  }

  public onModuleDestroy(): Promise<void> {
    return this.handle.destroy();
  }
}

export class PostgresProductFacade implements ProductFacade {
  private readonly database: Kysely<CatalogDatabase>;
  private readonly localRepository: LocalRepositoryAdapter;
  private readonly ollama?: OllamaRuntime;
  private readonly runtime: PostgresIndexingRuntime;

  public constructor(
    resource: DatabaseResource,
    private readonly config: ApplicationConfig,
  ) {
    this.database = resource.handle.database;
    this.localRepository = new LocalRepositoryAdapter(
      config.repositoryAllowedRoots,
      new FilePolicy(config.maxFileBytes),
    );
    const detector = new GitChangeDetector(new FilePolicy(config.maxFileBytes));
    const targetInspector: ScanTargetInspector = {
      inspect: async (repositoryRoot) => ({
        commitSha: await detector.headRevision(repositoryRoot),
        worktreeFingerprint: await detector.fingerprintWorkingTree(repositoryRoot),
      }),
    };
    this.runtime = new PostgresIndexingRuntime(this.database, config.indexingMode, targetInspector);
    if (config.ollamaEnabled) {
      this.ollama = new OllamaRuntime(
        new OllamaClient({
          baseUrl: config.ollamaBaseUrl,
          concurrency: config.ollamaConcurrency,
          timeoutMs: config.ollamaTimeoutMs,
        }),
        {
          embeddingModel: config.ollamaEmbeddingModel,
          generationModel: config.ollamaChatModel,
        },
      );
    }
  }

  private async dispatchPendingScans(): Promise<void> {
    const dispatcher =
      this.config.indexingMode === "inline"
        ? new InlineScanDispatcher({
            execute: async (scanJobId) => {
              const capabilities = await this.ollama?.inspect();
              await createIndexingExecutor({
                config: this.config,
                database: this.database,
                ...(capabilities?.embedder === undefined
                  ? {}
                  : { embedder: capabilities.embedder }),
                owner: `api-inline-${String(process.pid)}`,
              }).execute(scanJobId);
            },
          })
        : BullMqScanDispatcher.connect(this.config.redisUrl as string, {
            attempts: this.config.scanRetryCount + 1,
            backoffMs: this.config.scanRetryBackoffMs,
          });
    try {
      await new OutboxDispatcher(this.database, dispatcher, {
        limit: 50,
        owner: `api-outbox-${String(process.pid)}`,
        retryBackoffMs: this.config.scanRetryBackoffMs,
      }).pump();
    } finally {
      await dispatcher.close();
    }
  }

  private async repository(repositoryId: string) {
    const repository = await new RepositoryCatalog(this.database).findById(repositoryId);
    if (repository === undefined)
      throw new ApiResourceNotFoundError(`Repository ${repositoryId} was not found`);
    return repository;
  }

  private async revision(repositoryId: string, requested?: string) {
    if (requested !== undefined) {
      const revision = await this.database
        .selectFrom("revisions")
        .selectAll()
        .where("repository_id", "=", repositoryId)
        .where("id", "=", requested)
        .executeTakeFirst();
      if (revision === undefined)
        throw new ApiResourceNotFoundError(
          `Revision ${requested} does not belong to repository ${repositoryId}`,
        );
      if (revision.status !== "active")
        throw new ApiConflictError(
          `Revision ${requested} is ${revision.status}; use the active canonical revision`,
        );
      return revision;
    }
    const revision = await activeRevisionQuery(this.database, repositoryId).executeTakeFirst();
    if (revision === undefined)
      throw new ApiConflictError(
        `Repository ${repositoryId} has no active canonical revision; trigger and complete a scan first`,
      );
    return revision;
  }

  public listRepositories(): Promise<readonly unknown[]> {
    return this.database
      .selectFrom("repositories")
      .select(["id", "display_name", "root_path", "default_branch", "created_at"])
      .orderBy("display_name")
      .execute();
  }

  public async registerRepository(input: RegisterRepositoryRequest): Promise<unknown> {
    const discovered = await this.localRepository.register(input.rootPath);
    return new RepositoryCatalog(this.database).register(discovered);
  }

  public async overview(repositoryId: string): Promise<RepositoryOverviewResponse> {
    const repository = await this.repository(repositoryId);
    const revision = await activeRevisionQuery(this.database, repositoryId).executeTakeFirst();
    const entityCounts = await this.database
      .selectFrom("entities")
      .select(["kind", sql<number>`count(*)::int`.as("count")])
      .where("repository_id", "=", repositoryId)
      .groupBy("kind")
      .execute();
    const latestJob = await this.database
      .selectFrom("scan_jobs")
      .selectAll()
      .where("repository_id", "=", repositoryId)
      .orderBy("updated_at", "desc")
      .limit(1)
      .executeTakeFirst();
    const health =
      revision === undefined
        ? undefined
        : await new DocumentationCatalog(this.database).findHealth(repositoryId, revision.id);
    const projections = new ProjectionStateCatalog(this.database);
    const [analysis, semantic] = await Promise.all([
      projections.find(repositoryId, "analysis"),
      projections.find(repositoryId, "semantic"),
    ]);
    const capability = (
      projection: typeof semantic,
      disabled: boolean,
      label: string,
    ): RepositoryOverviewResponse["capabilities"]["semantic"] => {
      if (disabled)
        return {
          detail: `${label} is disabled; PostgreSQL remains available`,
          lagRevisions: 0,
          state: "disabled",
        };
      if (projection === undefined)
        return {
          detail: `${label} has not been projected`,
          lagRevisions: revision === undefined ? 0 : 1,
          state: "stale",
        };
      const current = projection.revision_id === revision?.id && projection.state === "current";
      return {
        detail: current
          ? `${label} matches the canonical revision`
          : `${label} is behind canonical facts`,
        lagRevisions: current ? 0 : 1,
        ...(projection.revision_id === null ? {} : { projectedRevisionId: projection.revision_id }),
        state: current ? "current" : projection.state === "failed" ? "failed" : "stale",
      };
    };
    return {
      capabilities: {
        analysis: capability(analysis, false, "Revision analysis"),
        canonical: {
          detail:
            revision === undefined ? "No active scan" : "PostgreSQL canonical facts are current",
          lagRevisions: 0,
          ...(revision === undefined ? {} : { projectedRevisionId: revision.id }),
          state: revision === undefined ? "degraded" : "current",
        },
        ollama: {
          detail: this.config.ollamaEnabled
            ? "Ollama configured; live model capability check pending"
            : "Ollama disabled; deterministic answers remain available",
          lagRevisions: 0,
          state: this.config.ollamaEnabled ? "degraded" : "disabled",
        },
        semantic: capability(semantic, !this.config.ollamaEnabled, "pgvector semantic projection"),
        worker: {
          detail:
            this.config.indexingMode === "inline"
              ? "Explicit in-process local demo dispatch"
              : "BullMQ asynchronous worker dispatch configured",
          dispatchMode: this.config.indexingMode,
          lagRevisions: 0,
          state: "current",
        },
      },
      counts: Object.fromEntries(entityCounts.map(({ count, kind }) => [kind, count])),
      ...(health === undefined
        ? {}
        : { documentationHealth: { explanation: health.explanation, score: health.score } }),
      ...(latestJob === undefined
        ? {}
        : {
            latestJob: {
              attempt: latestJob.attempt,
              ...(latestJob.current_stage === null
                ? {}
                : { currentStage: latestJob.current_stage as ScanStage }),
              degradedReasons: latestJob.degraded_reasons,
              id: latestJob.id,
              revisionId: latestJob.revision_id,
              state: latestJob.state as ScanJobState,
              updatedAt: latestJob.updated_at.toISOString(),
            },
          }),
      repository: {
        ...(repository.default_branch === null ? {} : { defaultBranch: repository.default_branch }),
        displayName: repository.display_name,
        id: repository.id,
        rootPath: repository.root_path,
      },
      ...(revision === undefined
        ? {}
        : {
            revision: {
              commitSha: revision.commit_sha,
              createdAt: revision.created_at.toISOString(),
              id: revision.id,
              status: revision.status,
            },
          }),
      selectedTraversalAdapter: "postgresql",
    };
  }

  public async triggerScan(
    repositoryId: string,
    input: TriggerScanRequest,
  ): Promise<ScanJobSnapshot> {
    const repository = await this.repository(repositoryId);
    const detector = new GitChangeDetector(new FilePolicy(this.config.maxFileBytes));
    const current = {
      commitSha: await detector.headRevision(repository.root_path),
      worktreeFingerprint: await detector.fingerprintWorkingTree(repository.root_path),
    };
    if (
      (input.commitSha !== undefined && current.commitSha !== input.commitSha) ||
      (input.worktreeFingerprint !== undefined &&
        current.worktreeFingerprint !== input.worktreeFingerprint)
    ) {
      throw new ApiConflictError("Requested scan target does not match current repository content");
    }
    try {
      const submission = await this.runtime.submit({ repositoryId, target: current });
      await this.dispatchPendingScans();
      return this.runtime.status(submission.scan.id);
    } catch (error) {
      if (error instanceof IndexingRuntimeError) throw new ApiConflictError(error.message);
      throw error;
    }
  }

  public async scan(repositoryId: string, jobId: string): Promise<ScanJobSnapshot> {
    const job = await new ScanJobCatalog(this.database).findById(jobId);
    if (job === undefined || job.repositoryId !== repositoryId)
      throw new ApiResourceNotFoundError(
        `Scan job ${jobId} was not found in repository ${repositoryId}`,
      );
    return job;
  }

  public async retryScan(repositoryId: string, jobId: string): Promise<ScanJobSnapshot> {
    await this.scan(repositoryId, jobId);
    try {
      const submission = await this.runtime.retry(jobId);
      await this.dispatchPendingScans();
      return this.runtime.status(submission.scan.id);
    } catch (error) {
      if (error instanceof IndexingRuntimeError) throw new ApiConflictError(error.message);
      throw error;
    }
  }

  public async searchEntities(
    repositoryId: string,
    query: EntitySearchRequest,
  ): Promise<EntitySearchResult> {
    await this.repository(repositoryId);
    const revision = await this.revision(repositoryId, query.revisionId);
    const term = `%${query.query.replace(/[%_]/gu, "")}%`;
    let statement = this.database
      .selectFrom("entities as entity")
      .innerJoin("source_artifacts as artifact", "artifact.id", "entity.owner_artifact_id")
      .select([
        "entity.id",
        "entity.kind",
        "entity.language",
        "entity.name",
        "entity.qualified_name",
        "entity.stable_key",
        "artifact.path",
      ])
      .where("entity.repository_id", "=", repositoryId)
      .where((expression) =>
        expression.or([
          expression("entity.name", "ilike", term),
          expression("entity.qualified_name", "ilike", term),
          expression("entity.stable_key", "ilike", term),
        ]),
      );
    if (query.kind !== undefined) statement = statement.where("entity.kind", "=", query.kind);
    const rows = await statement.orderBy("entity.name").limit(query.limit).execute();
    return {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        ...(row.language === null ? {} : { language: row.language }),
        name: row.name,
        path: row.path,
        ...(row.qualified_name === null ? {} : { qualifiedName: row.qualified_name }),
        stableKey: row.stable_key,
      })),
      repositoryId,
      revisionId: revision.id,
      total: rows.length,
    };
  }

  public async graph(
    repositoryId: string,
    query: GraphNeighborhoodRequest,
  ): Promise<GraphNeighborhoodResponse> {
    const revision = await this.revision(repositoryId, query.revisionId);
    const result = await new PostgresGraphTraversal(
      new PostgresCanonicalGraphReader(this.database),
    ).traverse({
      ...query,
      repositoryId,
      revisionId: revision.id,
    });
    return {
      adapter: "postgresql",
      edges: result.edges,
      missingStartEntityKeys: result.missingStartEntityKeys,
      nodes: result.nodes,
      repositoryId: result.repositoryId,
      revisionId: result.revisionId,
      truncated: result.truncated,
    };
  }

  public async impact(
    repositoryId: string,
    query: RevisionPairRequest,
  ): Promise<ChangeImpactResponse> {
    await this.repository(repositoryId);
    const report = await this.database
      .selectFrom("impact_reports")
      .selectAll()
      .where("repository_id", "=", repositoryId)
      .where("base_revision_id", "=", query.baseRevisionId)
      .where("target_revision_id", "=", query.targetRevisionId)
      .executeTakeFirst();
    if (report === undefined)
      throw new ApiResourceNotFoundError(
        `No impact report exists for ${query.baseRevisionId} → ${query.targetRevisionId}`,
      );
    const stored = report.report as unknown as Omit<
      ChangeImpactResponse,
      "generatedAt" | "markdown"
    >;
    return {
      ...stored,
      generatedAt: report.created_at.toISOString(),
      markdown: report.markdown,
    };
  }

  public async analyzeGitHubPullRequest(
    repositoryId: string,
    input: GitHubPullRequestAnalysisRequest,
  ): Promise<GitHubPullRequestAnalysisResponse> {
    await this.repository(repositoryId);
    const identity = parseGitHubPullRequestUrl(input.pullRequestUrl);
    const client = new GitHubPullRequestClient(
      this.config.githubToken === undefined ? {} : { token: this.config.githubToken },
    );
    const [pullRequest, changedFiles, revisions, impact] = await Promise.all([
      client.pullRequest(identity),
      client.changedFiles(identity),
      this.database
        .selectFrom("revisions")
        .select(["id", "commit_sha"])
        .where("repository_id", "=", repositoryId)
        .where("id", "in", [input.baseRevisionId, input.targetRevisionId])
        .execute(),
      this.impact(repositoryId, {
        baseRevisionId: input.baseRevisionId,
        targetRevisionId: input.targetRevisionId,
      }),
    ]);
    const baseRevision = revisions.find(({ id }) => id === input.baseRevisionId);
    const targetRevision = revisions.find(({ id }) => id === input.targetRevisionId);
    if (baseRevision === undefined || targetRevision === undefined) {
      throw new ApiResourceNotFoundError("Both PR revisions must be indexed for this repository");
    }
    if (
      baseRevision.commit_sha !== pullRequest.baseSha ||
      targetRevision.commit_sha !== pullRequest.headSha
    ) {
      throw new ApiConflictError(
        "Indexed base/head revisions do not match the GitHub pull request commit SHAs",
      );
    }
    const warnings = [
      ...(pullRequest.isFork ? ["Pull request originates from a fork"] : []),
      ...(changedFiles.some(({ patchState }) => patchState === "unavailable")
        ? ["GitHub omitted one or more patches; canonical indexed revisions remain authoritative"]
        : []),
    ];
    const markdown = [
      `## IntelliRepo analysis — #${pullRequest.pullNumber}: ${pullRequest.title}`,
      "",
      ...warnings.map((warning) => `> ${warning}`),
      ...(warnings.length === 0 ? [] : [""]),
      impact.markdown,
    ].join("\n");
    const comment = input.publishComment
      ? await client.upsertAnalysisComment(identity, markdown)
      : undefined;
    return {
      changedFiles: changedFiles.map((file) => ({
        patchState: file.patchState,
        path: file.path,
        ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
        status: file.status,
      })),
      ...(comment === undefined ? {} : { comment }),
      impact,
      pullRequest: {
        baseSha: pullRequest.baseSha,
        headSha: pullRequest.headSha,
        isFork: pullRequest.isFork,
        number: pullRequest.pullNumber,
        state: pullRequest.state,
        title: pullRequest.title,
        url: pullRequest.url,
      },
      warnings,
    };
  }

  public async documentationHealth(
    repositoryId: string,
    query: DocumentationHealthQuery,
  ): Promise<DocumentationHealthResponse> {
    const revision = await this.revision(repositoryId, query.revisionId);
    const health = await new DocumentationCatalog(this.database).findHealth(
      repositoryId,
      revision.id,
    );
    let statement = this.database
      .selectFrom("documentation_findings")
      .selectAll()
      .where("repository_id", "=", repositoryId)
      .where("revision_id", "=", revision.id);
    if (query.severity !== undefined) statement = statement.where("severity", "=", query.severity);
    if (query.status !== undefined) statement = statement.where("status", "=", query.status);
    const findings = await statement.orderBy("created_at", "desc").execute();
    return {
      explanation: health?.explanation ?? "Documentation analysis has not run for this revision.",
      findings: findings.map((finding) => ({
        evidence: finding.evidence,
        id: finding.id,
        kind: finding.finding_kind,
        severity: finding.severity,
        status: finding.status,
      })),
      repositoryId,
      revisionId: revision.id,
      score: health?.score ?? 0,
    };
  }

  private async documentationSnapshot(
    repositoryId: string,
    revisionId: string,
  ): Promise<DocumentationFactSnapshot> {
    const [entities, relationships] = await Promise.all([
      this.database
        .selectFrom("entities as entity")
        .innerJoin("source_artifacts as artifact", "artifact.id", "entity.owner_artifact_id")
        .select([
          "entity.attributes",
          "entity.id",
          "entity.kind",
          "entity.name",
          "entity.qualified_name",
          "entity.stable_key",
          "artifact.path",
        ])
        .where("entity.repository_id", "=", repositoryId)
        .execute(),
      this.database
        .selectFrom("relationships as relationship")
        .innerJoin("entities as source", "source.id", "relationship.source_entity_id")
        .innerJoin("entities as target", "target.id", "relationship.target_entity_id")
        .select([
          "relationship.attributes",
          "relationship.id",
          "relationship.kind",
          "source.stable_key as source_key",
          "target.stable_key as target_key",
        ])
        .where("relationship.repository_id", "=", repositoryId)
        .execute(),
    ]);
    return {
      entities: entities.map((entity) => ({
        attributes: entity.attributes,
        id: entity.id,
        kind: entity.kind,
        name: entity.name,
        ...(entity.qualified_name === null ? {} : { qualifiedName: entity.qualified_name }),
        source: { artifactPath: entity.path, evidence: `${entity.kind} ${entity.name}` },
        stableKey: entity.stable_key,
      })),
      relationships: relationships.map((relationship) => ({
        attributes: relationship.attributes,
        id: relationship.id,
        kind: relationship.kind,
        sourceEntityKey: relationship.source_key,
        targetEntityKey: relationship.target_key,
      })),
      repositoryId,
      revisionId,
    };
  }

  public async previewDocumentation(
    repositoryId: string,
    input: DocumentationPreviewRequest,
  ): Promise<DocumentationReviewResponse> {
    const repository = await this.repository(repositoryId);
    const revision = await this.revision(repositoryId, input.revisionId);
    const workflow = new DocumentationReviewWorkflow(
      new DocumentationGenerator(),
      new LocalDocumentationWorkspace(repository.root_path),
    );
    const preview = await workflow.preview({
      ...(input.entityKeys === undefined ? {} : { entityKeys: input.entityKeys }),
      kind: input.kind,
      snapshot: await this.documentationSnapshot(repositoryId, revision.id),
      ...(input.targetPath === undefined ? {} : { targetPath: input.targetPath }),
      title: input.title,
    });
    await new DocumentationCatalog(this.database).saveReview(preview);
    return preview;
  }

  public async applyDocumentation(
    repositoryId: string,
    reviewId: string,
  ): Promise<{ applied: true }> {
    const repository = await this.repository(repositoryId);
    const catalog = new DocumentationCatalog(this.database);
    const stored = await catalog.findReview(repositoryId, reviewId);
    if (stored === undefined)
      throw new ApiResourceNotFoundError(
        `Documentation review ${reviewId} is not pending for repository ${repositoryId}`,
      );
    if (stored.state !== "pending") {
      throw new ApiConflictError(`Documentation review ${reviewId} is ${stored.state}`);
    }
    const preview = stored.preview;
    await this.revision(repositoryId, preview.revisionId);
    if (!(await catalog.claimReview(repositoryId, reviewId, preview.revisionId))) {
      throw new ApiConflictError(`Documentation review ${reviewId} is no longer pending`);
    }
    const workflow = new DocumentationReviewWorkflow(
      new DocumentationGenerator(),
      new LocalDocumentationWorkspace(repository.root_path),
    );
    try {
      await workflow.apply(preview, true);
      await catalog.markReviewApplied(repositoryId, reviewId);
    } catch (error) {
      await catalog.releaseReview(repositoryId, reviewId);
      throw error;
    }
    return { applied: true };
  }

  public async submitQuestion(
    repositoryId: string,
    input: AskQuestionRequest,
  ): Promise<QuestionTaskResponse<RepositoryAnswer>> {
    await this.repository(repositoryId);
    const revision = await this.revision(repositoryId, input.revisionId);
    const id = randomUUID();
    const queued = await new QuestionTaskCatalog(this.database).create({
      id,
      question: input.question,
      repositoryId,
      revisionId: revision.id,
    });
    queueMicrotask(() => void this.runQuestion(id, repositoryId, revision.id, input.question));
    return { id, state: "queued", updatedAt: queued.updated_at.toISOString() };
  }

  private async runQuestion(
    id: string,
    repositoryId: string,
    revisionId: string,
    question: string,
  ): Promise<void> {
    const tasks = new QuestionTaskCatalog(this.database);
    if (!(await tasks.markRunning(repositoryId, id))) return;
    try {
      const traversal = new PostgresGraphTraversal(new PostgresCanonicalGraphReader(this.database));
      const capabilities = await this.ollama?.inspect();
      const answerer = new RepositoryQuestionAnswerer(
        new EvidencePackBuilder(
          traversal,
          new PostgresEntityLookup(this.database),
          new PostgresStructuralEvidenceReader(this.database),
          capabilities?.embedder === undefined
            ? undefined
            : new SemanticRetriever(
                new PostgresSemanticChunkStore(this.database),
                capabilities.embedder,
              ),
        ),
        capabilities?.generator,
      );
      const result = await answerer.ask({ question, repositoryId, revisionId });
      await new QuestionCatalog(this.database).save(result);
      await tasks.succeed(repositoryId, id, result);
    } catch (error) {
      await tasks.fail(repositoryId, id, error instanceof Error ? error.message : String(error));
    }
  }

  public async question(
    repositoryId: string,
    taskId: string,
  ): Promise<QuestionTaskResponse<RepositoryAnswer>> {
    const task = await new QuestionTaskCatalog(this.database).find(repositoryId, taskId);
    if (task === undefined)
      throw new ApiResourceNotFoundError(
        `Question task ${taskId} was not found in repository ${repositoryId}`,
      );
    const error = task.error as { message?: string } | null;
    return {
      ...(error?.message === undefined ? {} : { error: error.message }),
      id: task.id,
      ...(task.result === null ? {} : { result: task.result as unknown as RepositoryAnswer }),
      state: task.state as QuestionTaskResponse<RepositoryAnswer>["state"],
      updatedAt: task.updated_at.toISOString(),
    };
  }

  public async diagnostics(repositoryId: string): Promise<ProductDiagnostics> {
    await this.repository(repositoryId);
    const projections = new ProjectionStateCatalog(this.database);
    const [analysis, semantic] = await Promise.all([
      projections.find(repositoryId, "analysis"),
      projections.find(repositoryId, "semantic"),
    ]);
    const ollama = await this.ollama?.inspect();
    return {
      analysis: { state: analysis?.state ?? "not_analyzed" },
      canonicalStore: "postgresql",
      deterministicFeaturesAvailable: true,
      ollama: {
        enabled: this.config.ollamaEnabled,
        state: ollama?.state ?? "disabled",
      },
      repositoryId,
      semantic: {
        state: semantic?.state ?? (this.config.ollamaEnabled ? "not_projected" : "disabled"),
      },
      worker: { mode: this.config.indexingMode, state: "configured" },
    };
  }
}
