import { ProjectionStateCatalog, type CatalogDatabase } from "@intellirepo/catalog";
import {
  DocumentationAnalyzer,
  DocumentationCatalog,
  type MarkdownDocumentInput,
} from "@intellirepo/documentation";
import { PostgresCanonicalGraphReader, PostgresGraphTraversal } from "@intellirepo/graph";
import {
  calculateSemanticDiff,
  ImpactAnalyzer,
  ImpactReportStore,
  PostgresFactSnapshotReader,
  renderChangeSummaryMarkdown,
} from "@intellirepo/impact";
import type { Kysely } from "kysely";

import type { ScanExecutionContext } from "../executor/scan-context.js";
import type { ScanStageResult } from "../executor/scan-stage.js";
import { RepositorySnapshotProvider } from "../pipeline/repository-snapshot-provider.js";

export class RevisionAnalysis {
  public constructor(
    private readonly database: Kysely<CatalogDatabase>,
    private readonly snapshots: RepositorySnapshotProvider,
  ) {}

  public async run(context: ScanExecutionContext): Promise<ScanStageResult> {
    const revision = await this.database
      .selectFrom("revisions")
      .select(["parent_revision_id", "status"])
      .where("id", "=", context.scan.revisionId)
      .where("repository_id", "=", context.scan.repositoryId)
      .executeTakeFirstOrThrow();
    if (revision.status !== "active") {
      throw new Error(`Revision ${context.scan.revisionId} is not canonical`);
    }
    const reader = new PostgresFactSnapshotReader(this.database);
    const target = await reader.readStored(context.scan.repositoryId, context.scan.revisionId);
    const fullSnapshot = await this.snapshots.loadFull(context);
    const incrementalSnapshot = await this.snapshots.load(context);
    const changedFiles = incrementalSnapshot.changeSet.changes.flatMap((change) =>
      "current" in change ? [change.current.path] : [change.previous.path],
    );
    const documents: MarkdownDocumentInput[] = fullSnapshot.artifacts.flatMap((artifact) =>
      artifact.decision.artifactKind === "documentation"
        ? [{ content: artifact.content, path: artifact.path }]
        : [],
    );
    const base =
      revision.parent_revision_id === null
        ? undefined
        : await reader.readStored(context.scan.repositoryId, revision.parent_revision_id);
    const diff = base === undefined ? undefined : calculateSemanticDiff(base, target);
    const changedEntityKeys =
      diff === undefined
        ? target.entities.map(({ stableKey }) => stableKey)
        : diff.entities.map(({ stableKey }) => stableKey);
    const documentation = new DocumentationAnalyzer().analyze({
      affectedPaths: changedFiles,
      changedEntityKeys,
      documents,
      snapshot: target,
    });
    await new DocumentationCatalog(this.database).saveAnalysis(documentation);

    let impactReports = 0;
    if (base !== undefined) {
      const impact = await new ImpactAnalyzer(
        new PostgresGraphTraversal(new PostgresCanonicalGraphReader(this.database)),
      ).analyze({
        base,
        changedFiles,
        missingDocumentationCount: documentation.gaps.length,
        staleDocumentationCount: documentation.findings.length,
        target,
      });
      await new ImpactReportStore(this.database).save(impact, renderChangeSummaryMarkdown(impact));
      impactReports = 1;
    }
    await new ProjectionStateCatalog(this.database).save({
      projection: "analysis",
      repositoryId: context.scan.repositoryId,
      revisionId: context.scan.revisionId,
      state: "current",
    });
    return {
      counts: {
        documentationFindings: documentation.findings.length,
        documentationGaps: documentation.gaps.length,
        documentationPages: documentation.pages.length,
        impactReports,
      },
    };
  }
}
