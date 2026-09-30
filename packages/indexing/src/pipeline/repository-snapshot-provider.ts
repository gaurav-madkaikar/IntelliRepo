import type { CatalogDatabase } from "@intellirepo/catalog";
import {
  RepositorySnapshotBuilder,
  type RegisteredLocalRepository,
  type RepositorySnapshot,
} from "@intellirepo/repository";
import type { Kysely } from "kysely";

import type { ScanExecutionContext } from "../executor/scan-context.js";

const SNAPSHOT_CONTEXT_KEY = "repository-snapshot";

export class RepositoryTargetChangedError extends Error {
  public constructor(scanJobId: string) {
    super(`Repository content no longer matches scan ${scanJobId}`);
    this.name = "RepositoryTargetChangedError";
  }
}

export class RepositorySnapshotProvider {
  public constructor(
    private readonly database: Kysely<CatalogDatabase>,
    private readonly builder: RepositorySnapshotBuilder,
  ) {}

  public async load(context: ScanExecutionContext): Promise<RepositorySnapshot> {
    const existing = context.get<RepositorySnapshot>(SNAPSHOT_CONTEXT_KEY);
    if (existing !== undefined) return existing;

    const target = await this.database
      .selectFrom("revisions as revision")
      .innerJoin("repositories as repository", "repository.id", "revision.repository_id")
      .select([
        "repository.default_branch",
        "repository.display_name",
        "repository.root_path",
        "revision.commit_sha",
        "revision.parent_revision_id",
        "revision.worktree_fingerprint",
      ])
      .where("revision.id", "=", context.scan.revisionId)
      .where("revision.repository_id", "=", context.scan.repositoryId)
      .executeTakeFirstOrThrow();
    const parent =
      target.parent_revision_id === null
        ? undefined
        : await this.database
            .selectFrom("revisions")
            .select("commit_sha")
            .where("id", "=", target.parent_revision_id)
            .executeTakeFirst();
    const repository = {
      ...(target.default_branch === null ? {} : { defaultBranch: target.default_branch }),
      displayName: target.display_name,
      id: context.scan.repositoryId,
      rootPath: target.root_path,
    } satisfies RegisteredLocalRepository;
    const snapshot = await this.builder.capture({
      ...(parent === undefined ? {} : { baseRevision: parent.commit_sha }),
      repository,
    });
    if (
      snapshot.headCommit !== target.commit_sha ||
      snapshot.workingTreeFingerprint !== target.worktree_fingerprint
    ) {
      throw new RepositoryTargetChangedError(context.scan.id);
    }
    context.set(SNAPSHOT_CONTEXT_KEY, snapshot);
    return snapshot;
  }

  public async assertCurrent(context: ScanExecutionContext): Promise<RepositorySnapshot> {
    const snapshot = await this.load(context);
    await this.builder.assertCurrent(snapshot);
    return snapshot;
  }

  /** Captures all safe artifacts for post-activation consumers without changing parse selection. */
  public async loadFull(context: ScanExecutionContext): Promise<RepositorySnapshot> {
    const target = await this.database
      .selectFrom("revisions as revision")
      .innerJoin("repositories as repository", "repository.id", "revision.repository_id")
      .select([
        "repository.default_branch",
        "repository.display_name",
        "repository.root_path",
        "revision.commit_sha",
        "revision.worktree_fingerprint",
      ])
      .where("revision.id", "=", context.scan.revisionId)
      .where("revision.repository_id", "=", context.scan.repositoryId)
      .executeTakeFirstOrThrow();
    const repository = {
      ...(target.default_branch === null ? {} : { defaultBranch: target.default_branch }),
      displayName: target.display_name,
      id: context.scan.repositoryId,
      rootPath: target.root_path,
    } satisfies RegisteredLocalRepository;
    const snapshot = await this.builder.capture({ repository });
    if (
      snapshot.headCommit !== target.commit_sha ||
      snapshot.workingTreeFingerprint !== target.worktree_fingerprint
    ) {
      throw new RepositoryTargetChangedError(context.scan.id);
    }
    return snapshot;
  }
}
