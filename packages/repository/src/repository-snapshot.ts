import { createHash } from "node:crypto";

import {
  createArtifactChange,
  createChangeSet,
  type ArtifactChange,
  type ChangeSet,
} from "@intellirepo/domain";

import { GitChangeDetector } from "./git-change-detector.js";
import {
  LocalRepositoryAdapter,
  RepositoryArtifactReadError,
  type LoadedRepositoryArtifact,
  type RegisteredLocalRepository,
  type RepositoryInventory,
  type RepositoryInventoryDiagnosticReason,
} from "./local-repository-adapter.js";

export interface RepositorySnapshotDiagnostic {
  readonly message: string;
  readonly path: string;
  readonly reason: RepositoryInventoryDiagnosticReason | "change-detection";
  readonly source: "change-detection" | "inventory" | "source-loading";
}

export interface RepositorySnapshot {
  readonly artifacts: readonly LoadedRepositoryArtifact[];
  readonly capturedAt: string;
  readonly changeSet: ChangeSet;
  readonly clean: boolean;
  readonly diagnostics: readonly RepositorySnapshotDiagnostic[];
  readonly fingerprint: string;
  readonly headCommit: string;
  readonly inventoryFingerprint: string;
  readonly repositoryId: string;
  readonly repositoryRoot: string;
  readonly workingTreeFingerprint: string;
}

export interface CaptureRepositorySnapshotInput {
  readonly baseRevision?: string;
  readonly repository: RegisteredLocalRepository;
}

export class StaleRepositorySnapshotError extends Error {
  public readonly code = "STALE_REPOSITORY_SNAPSHOT";

  public constructor(
    public readonly expectedFingerprint: string,
    public readonly actualFingerprint: string,
  ) {
    super("Repository content changed while the snapshot was being used");
    this.name = "StaleRepositorySnapshotError";
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inventoryFingerprint(inventory: RepositoryInventory): string {
  return hash(
    JSON.stringify({
      artifacts: inventory.artifacts
        .map(({ decision, path, sizeBytes }) => ({
          artifactKind: decision.artifactKind,
          language: decision.language ?? null,
          path,
          sizeBytes,
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      diagnostics: inventory.diagnostics
        .map(({ path, reason, sizeBytes }) => ({ path, reason, sizeBytes: sizeBytes ?? null }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    }),
  );
}

function snapshotFingerprint(
  headCommit: string,
  workingTreeFingerprint: string,
  inventory: string,
): string {
  return hash(`${headCommit}\0${workingTreeFingerprint}\0${inventory}`);
}

function inventoryDiagnostics(inventory: RepositoryInventory): RepositorySnapshotDiagnostic[] {
  return inventory.diagnostics.map(({ message, path, reason }) => ({
    message,
    path,
    reason,
    source: "inventory",
  }));
}

function normalizeChanges(
  changes: readonly ArtifactChange[],
  loadedPaths: ReadonlySet<string>,
): readonly ArtifactChange[] {
  return changes.flatMap((change): readonly ArtifactChange[] => {
    if (!("current" in change) || loadedPaths.has(change.current.path)) return [change];
    if (change.kind === "added") return [];
    return [createArtifactChange({ kind: "deleted", previous: change.previous })];
  });
}

export class RepositorySnapshotBuilder {
  public constructor(
    private readonly repositoryAdapter: LocalRepositoryAdapter,
    private readonly changeDetector: GitChangeDetector,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async currentIdentity(repositoryRoot: string): Promise<{
    readonly clean: boolean;
    readonly headCommit: string;
    readonly inventory: RepositoryInventory;
    readonly inventoryFingerprint: string;
    readonly workingTreeFingerprint: string;
  }> {
    const [headCommit, workingTreeFingerprint, clean, inventory] = await Promise.all([
      this.changeDetector.headRevision(repositoryRoot),
      this.changeDetector.fingerprintWorkingTree(repositoryRoot),
      this.changeDetector.isWorkingTreeClean(repositoryRoot),
      this.repositoryAdapter.inventory(repositoryRoot),
    ]);
    return {
      clean,
      headCommit,
      inventory,
      inventoryFingerprint: inventoryFingerprint(inventory),
      workingTreeFingerprint,
    };
  }

  public async capture(input: CaptureRepositorySnapshotInput): Promise<RepositorySnapshot> {
    const repositoryRoot = input.repository.rootPath;
    const before = await this.currentIdentity(repositoryRoot);
    const selectedPaths = before.inventory.artifacts.map(({ path }) => path);
    const diagnostics = inventoryDiagnostics(before.inventory);
    let changes: readonly ArtifactChange[];

    if (input.baseRevision === undefined) {
      changes = [];
    } else {
      const detection = await this.changeDetector.detect({
        baseRevision: input.baseRevision,
        repositoryId: input.repository.id,
        repositoryRoot,
        selectedCurrentPaths: selectedPaths,
      });
      changes = detection.changeSet.changes;
      diagnostics.push(
        ...detection.diagnostics.map(({ path, reason }) => ({
          message: reason,
          path,
          reason: "change-detection" as const,
          source: "change-detection" as const,
        })),
      );
    }

    const pathsToLoad =
      input.baseRevision === undefined
        ? selectedPaths
        : [
            ...new Set([
              ...changes.flatMap((change) => ("current" in change ? [change.current.path] : [])),
              ...before.inventory.artifacts.flatMap(({ decision, path }) =>
                decision.artifactKind === "build" || decision.artifactKind === "configuration"
                  ? [path]
                  : [],
              ),
            ]),
          ];
    const artifacts: LoadedRepositoryArtifact[] = [];
    for (const path of pathsToLoad) {
      try {
        artifacts.push(await this.repositoryAdapter.readArtifact(repositoryRoot, path));
      } catch (error) {
        const reason =
          error instanceof RepositoryArtifactReadError ? error.reason : ("unreadable" as const);
        diagnostics.push({
          message: error instanceof Error ? error.message : `${path}: artifact cannot be read`,
          path,
          reason,
          source: "source-loading",
        });
      }
    }

    if (input.baseRevision === undefined) {
      changes = artifacts.map(({ contentHash, path }) =>
        createArtifactChange({ current: { contentHash, path }, kind: "added" }),
      );
    } else {
      changes = normalizeChanges(changes, new Set(artifacts.map(({ path }) => path)));
    }

    const after = await this.currentIdentity(repositoryRoot);
    const expected = snapshotFingerprint(
      before.headCommit,
      before.workingTreeFingerprint,
      before.inventoryFingerprint,
    );
    const actual = snapshotFingerprint(
      after.headCommit,
      after.workingTreeFingerprint,
      after.inventoryFingerprint,
    );
    if (expected !== actual) throw new StaleRepositorySnapshotError(expected, actual);

    const targetRevision = `snapshot:${expected}`;
    return Object.freeze({
      artifacts: Object.freeze(artifacts),
      capturedAt: this.clock().toISOString(),
      changeSet: createChangeSet({
        baseRevision: input.baseRevision ?? "EMPTY",
        changes,
        repositoryId: input.repository.id,
        targetRevision,
      }),
      clean: before.clean,
      diagnostics: Object.freeze(diagnostics),
      fingerprint: expected,
      headCommit: before.headCommit,
      inventoryFingerprint: before.inventoryFingerprint,
      repositoryId: input.repository.id,
      repositoryRoot,
      workingTreeFingerprint: before.workingTreeFingerprint,
    });
  }

  public async assertCurrent(snapshot: RepositorySnapshot): Promise<void> {
    const current = await this.currentIdentity(snapshot.repositoryRoot);
    const actual = snapshotFingerprint(
      current.headCommit,
      current.workingTreeFingerprint,
      current.inventoryFingerprint,
    );
    if (actual !== snapshot.fingerprint) {
      throw new StaleRepositorySnapshotError(snapshot.fingerprint, actual);
    }
  }
}

export const repositorySnapshotFingerprintForTesting = { inventory: inventoryFingerprint };
