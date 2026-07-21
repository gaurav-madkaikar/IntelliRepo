import { randomUUID } from "node:crypto";

import {
  createCatalogDatabase,
  migrateCatalogToLatest,
  ProjectionStateCatalog,
  RepositoryCatalog,
  RevisionCatalog,
  ScanJobCatalog,
  type CatalogDatabase,
  type CatalogDatabaseHandle,
} from "@intellirepo/catalog";
import {
  createScanJobId,
  type ApplicationConfig,
  type AskQuestionRequest,
  type DocumentationHealthQuery,
  type DocumentationHealthResponse,
  type DocumentationPreviewRequest,
  type EntitySearchRequest,
  type EntitySearchResult,
  type GraphNeighborhoodRequest,
  type QuestionTaskResponse,
  type RegisterRepositoryRequest,
  type RepositoryOverviewResponse,
  type RevisionPairRequest,
  type ScanJobSnapshot,
  type TriggerScanRequest,
} from "@intellirepo/contracts";
import {
  DocumentationCatalog,
  DocumentationGenerator,
  DocumentationReviewWorkflow,
  LocalDocumentationWorkspace,
  type DocumentationFactSnapshot,
  type DocumentationReviewPreview,
} from "@intellirepo/documentation";
import { PostgresCanonicalGraphReader, PostgresGraphTraversal } from "@intellirepo/graph";
import {
  EvidencePackBuilder,
  PostgresEntityLookup,
  PostgresStructuralEvidenceReader,
  QuestionCatalog,
  RepositoryQuestionAnswerer,
  type RepositoryAnswer,
} from "@intellirepo/qa";
import { FilePolicy, LocalRepositoryAdapter } from "@intellirepo/repository";
import { sql, type Kysely } from "kysely";

export const PRODUCT_FACADE = Symbol("PRODUCT_FACADE");

export interface ProductDiagnostics {
  readonly canonicalStore: "postgresql";
  readonly deterministicFeaturesAvailable: true;
  readonly neo4j: { readonly enabled: boolean; readonly state: string };
  readonly ollama: { readonly enabled: boolean; readonly state: string };
  readonly repositoryId: string;
  readonly semantic: { readonly state: string };
}

export interface ProductFacade {
  applyDocumentation(repositoryId: string, reviewId: string): Promise<{ applied: true }>;
  diagnostics(repositoryId: string): Promise<ProductDiagnostics>;
  documentationHealth(
    repositoryId: string,
    query: DocumentationHealthQuery,
  ): Promise<DocumentationHealthResponse>;
  graph(repositoryId: string, query: GraphNeighborhoodRequest): Promise<unknown>;
  impact(repositoryId: string, query: RevisionPairRequest): Promise<unknown>;
  listRepositories(): Promise<readonly unknown[]>;
  overview(repositoryId: string): Promise<RepositoryOverviewResponse>;
  previewDocumentation(
    repositoryId: string,
    input: DocumentationPreviewRequest,
  ): Promise<DocumentationReviewPreview>;
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

function nowIso(): string {
  return new Date().toISOString();
}

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
    return new DatabaseResource(handle);
  }

  public onModuleDestroy(): Promise<void> {
    return this.handle.destroy();
  }
}

interface StoredQuestionTask extends QuestionTaskResponse<RepositoryAnswer> {
  readonly repositoryId: string;
}

export class PostgresProductFacade implements ProductFacade {
  private readonly database: Kysely<CatalogDatabase>;
  private readonly localRepository: LocalRepositoryAdapter;
  private readonly previews = new Map<string, DocumentationReviewPreview>();
  private readonly questionTasks = new Map<string, StoredQuestionTask>();

  public constructor(
    resource: DatabaseResource,
    private readonly config: ApplicationConfig,
  ) {
    this.database = resource.handle.database;
    this.localRepository = new LocalRepositoryAdapter(
      config.repositoryAllowedRoots,
      new FilePolicy(config.maxFileBytes),
    );
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
    const [neo4j, semantic] = await Promise.all([
      projections.find(repositoryId, "neo4j"),
      projections.find(repositoryId, "semantic"),
    ]);
    const capability = (
      projection: typeof neo4j,
      disabled: boolean,
      label: string,
    ): RepositoryOverviewResponse["capabilities"]["neo4j"] => {
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
        canonical: {
          detail:
            revision === undefined ? "No active scan" : "PostgreSQL canonical facts are current",
          lagRevisions: 0,
          ...(revision === undefined ? {} : { projectedRevisionId: revision.id }),
          state: revision === undefined ? "degraded" : "current",
        },
        neo4j: capability(neo4j, !this.config.neo4jEnabled, "Neo4j projection"),
        ollama: {
          detail: this.config.ollamaEnabled
            ? "Ollama configured; failures degrade to deterministic evidence"
            : "Ollama disabled; deterministic answers remain available",
          lagRevisions: 0,
          state: this.config.ollamaEnabled ? "current" : "disabled",
        },
        semantic: capability(semantic, !this.config.ollamaEnabled, "pgvector semantic projection"),
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
                : { currentStage: latestJob.current_stage }),
              degradedReasons: latestJob.degraded_reasons,
              id: latestJob.id,
              revisionId: latestJob.revision_id,
              state: latestJob.state,
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
    await this.repository(repositoryId);
    const current = await activeRevisionQuery(this.database, repositoryId).executeTakeFirst();
    const revision = await new RevisionCatalog(this.database).create({
      commitSha: input.commitSha,
      ...(current === undefined ? {} : { parentRevisionId: current.id }),
      repositoryId,
      status: "indexing",
      worktreeFingerprint: input.worktreeFingerprint,
    });
    const time = nowIso();
    const job: ScanJobSnapshot = {
      attempt: 0,
      completedStages: [],
      createdAt: time,
      degradedReasons: [],
      id: createScanJobId({ repositoryId, revisionId: revision.id }),
      repositoryId,
      revisionId: revision.id,
      stageTimings: {},
      state: "QUEUED",
      updatedAt: time,
    };
    await new ScanJobCatalog(this.database).save(job);
    return job;
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
    const previous = await this.scan(repositoryId, jobId);
    if (previous.state !== "FAILED")
      throw new ApiConflictError(
        `Scan job ${jobId} is ${previous.state}; only failed jobs can be retried`,
      );
    const retry: ScanJobSnapshot = {
      attempt: previous.attempt + 1,
      completedStages: previous.completedStages,
      createdAt: previous.createdAt,
      degradedReasons: previous.degradedReasons,
      id: previous.id,
      repositoryId,
      revisionId: previous.revisionId,
      stageTimings: previous.stageTimings,
      state: "QUEUED",
      updatedAt: nowIso(),
    };
    await new ScanJobCatalog(this.database).save(retry);
    return retry;
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

  public async graph(repositoryId: string, query: GraphNeighborhoodRequest): Promise<unknown> {
    const revision = await this.revision(repositoryId, query.revisionId);
    return new PostgresGraphTraversal(new PostgresCanonicalGraphReader(this.database)).traverse({
      ...query,
      repositoryId,
      revisionId: revision.id,
    });
  }

  public async impact(repositoryId: string, query: RevisionPairRequest): Promise<unknown> {
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
    return {
      ...report.report,
      generatedAt: report.created_at.toISOString(),
      markdown: report.markdown,
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
  ): Promise<DocumentationReviewPreview> {
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
    this.previews.set(preview.id, preview);
    await new DocumentationCatalog(this.database).saveReview(preview);
    return preview;
  }

  public async applyDocumentation(
    repositoryId: string,
    reviewId: string,
  ): Promise<{ applied: true }> {
    const repository = await this.repository(repositoryId);
    const preview = this.previews.get(reviewId);
    if (preview === undefined || preview.repositoryId !== repositoryId)
      throw new ApiResourceNotFoundError(
        `Documentation review ${reviewId} is not pending for repository ${repositoryId}`,
      );
    const workflow = new DocumentationReviewWorkflow(
      new DocumentationGenerator(),
      new LocalDocumentationWorkspace(repository.root_path),
    );
    await workflow.apply(preview, true);
    await this.database
      .updateTable("documentation_reviews")
      .set({ applied_at: new Date(), state: "applied" })
      .where("id", "=", reviewId)
      .where("repository_id", "=", repositoryId)
      .execute();
    this.previews.delete(reviewId);
    return { applied: true };
  }

  public async submitQuestion(
    repositoryId: string,
    input: AskQuestionRequest,
  ): Promise<QuestionTaskResponse<RepositoryAnswer>> {
    await this.repository(repositoryId);
    const revision = await this.revision(repositoryId, input.revisionId);
    const id = randomUUID();
    const queued: StoredQuestionTask = { id, repositoryId, state: "queued", updatedAt: nowIso() };
    this.questionTasks.set(id, queued);
    void this.runQuestion(id, repositoryId, revision.id, input.question);
    return queued;
  }

  private async runQuestion(
    id: string,
    repositoryId: string,
    revisionId: string,
    question: string,
  ): Promise<void> {
    this.questionTasks.set(id, { id, repositoryId, state: "running", updatedAt: nowIso() });
    try {
      const traversal = new PostgresGraphTraversal(new PostgresCanonicalGraphReader(this.database));
      const answerer = new RepositoryQuestionAnswerer(
        new EvidencePackBuilder(
          traversal,
          new PostgresEntityLookup(this.database),
          new PostgresStructuralEvidenceReader(this.database),
        ),
      );
      const result = await answerer.ask({ question, repositoryId, revisionId });
      await new QuestionCatalog(this.database).save(result);
      this.questionTasks.set(id, {
        id,
        repositoryId,
        result,
        state: "succeeded",
        updatedAt: nowIso(),
      });
    } catch (error) {
      this.questionTasks.set(id, {
        error: error instanceof Error ? error.message : String(error),
        id,
        repositoryId,
        state: "failed",
        updatedAt: nowIso(),
      });
    }
  }

  public async question(
    repositoryId: string,
    taskId: string,
  ): Promise<QuestionTaskResponse<RepositoryAnswer>> {
    const task = this.questionTasks.get(taskId);
    if (task === undefined || task.repositoryId !== repositoryId)
      throw new ApiResourceNotFoundError(
        `Question task ${taskId} was not found in repository ${repositoryId}`,
      );
    return task;
  }

  public async diagnostics(repositoryId: string): Promise<ProductDiagnostics> {
    await this.repository(repositoryId);
    const projections = new ProjectionStateCatalog(this.database);
    const [neo4j, semantic] = await Promise.all([
      projections.find(repositoryId, "neo4j"),
      projections.find(repositoryId, "semantic"),
    ]);
    return {
      canonicalStore: "postgresql",
      deterministicFeaturesAvailable: true,
      neo4j: { enabled: this.config.neo4jEnabled, state: neo4j?.state ?? "not_projected" },
      ollama: {
        enabled: this.config.ollamaEnabled,
        state: this.config.ollamaEnabled ? "configured" : "disabled",
      },
      repositoryId,
      semantic: {
        state: semantic?.state ?? (this.config.ollamaEnabled ? "not_projected" : "disabled"),
      },
    };
  }
}
