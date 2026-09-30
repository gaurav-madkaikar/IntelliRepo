import { activateRevisionFacts, type CatalogDatabase } from "@intellirepo/catalog";
import { PostgresFactSnapshotReader } from "@intellirepo/impact";
import type { Kysely } from "kysely";

import type { ScanExecutionContext } from "../executor/scan-context.js";
import {
  ScanStageExecutionError,
  type ScanStageHandler,
  type ScanStageResult,
} from "../executor/scan-stage.js";
import {
  RepositorySnapshotProvider,
  RepositoryTargetChangedError,
} from "./repository-snapshot-provider.js";

export class CommitRepositoryFactsStage implements ScanStageHandler {
  public readonly stage = "COMMITTING_FACTS" as const;

  public constructor(
    private readonly database: Kysely<CatalogDatabase>,
    private readonly snapshots: RepositorySnapshotProvider,
  ) {}

  public async run(context: ScanExecutionContext): Promise<ScanStageResult> {
    try {
      const snapshot = await this.snapshots.assertCurrent(context);
      const factSnapshots = new PostgresFactSnapshotReader(this.database);
      const revision = await this.database
        .selectFrom("revisions")
        .select("parent_revision_id")
        .where("id", "=", context.scan.revisionId)
        .executeTakeFirstOrThrow();
      if (revision.parent_revision_id !== null) {
        const storedParent = await this.database
          .selectFrom("revision_fact_snapshots")
          .select("revision_id")
          .where("repository_id", "=", context.scan.repositoryId)
          .where("revision_id", "=", revision.parent_revision_id)
          .executeTakeFirst();
        if (storedParent === undefined) {
          const activeParent = await this.database
            .selectFrom("revisions")
            .select("id")
            .where("id", "=", revision.parent_revision_id)
            .where("status", "=", "active")
            .executeTakeFirst();
          if (activeParent === undefined) {
            throw new Error(
              `Parent fact snapshot ${revision.parent_revision_id} is unavailable before activation`,
            );
          }
          await factSnapshots.captureCurrent(
            context.scan.repositoryId,
            revision.parent_revision_id,
          );
        }
      }
      const stagingRuns = await this.database
        .selectFrom("fact_staging_runs")
        .select("id")
        .where("repository_id", "=", context.scan.repositoryId)
        .where("revision_id", "=", context.scan.revisionId)
        .orderBy("id")
        .execute();
      const removedPaths = [
        ...new Set(
          snapshot.changeSet.changes.flatMap((change) =>
            change.kind === "deleted" || change.kind === "renamed" ? [change.previous.path] : [],
          ),
        ),
      ];
      const deletedArtifacts =
        removedPaths.length === 0
          ? []
          : await this.database
              .selectFrom("source_artifacts")
              .select("id")
              .where("repository_id", "=", context.scan.repositoryId)
              .where("path", "in", removedPaths)
              .execute();

      await activateRevisionFacts(this.database, {
        deletedArtifactIds: deletedArtifacts.map(({ id }) => id),
        repositoryId: context.scan.repositoryId,
        revisionId: context.scan.revisionId,
        stagingRunIds: stagingRuns.map(({ id }) => id),
      });
      await factSnapshots.captureCurrent(context.scan.repositoryId, context.scan.revisionId);
      return {
        counts: {
          activatedArtifacts: stagingRuns.length,
          deletedArtifacts: deletedArtifacts.length,
        },
      };
    } catch (error) {
      throw new ScanStageExecutionError(
        error instanceof Error ? error.message : "Fact activation failed",
        !(error instanceof RepositoryTargetChangedError),
        { cause: error },
      );
    }
  }
}
