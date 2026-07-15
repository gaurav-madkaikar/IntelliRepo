export interface ArtifactState {
  readonly contentHash: string;
  readonly path: string;
}

export type ArtifactChange =
  | Readonly<{ current: ArtifactState; kind: "added" }>
  | Readonly<{ current: ArtifactState; kind: "modified"; previous: ArtifactState }>
  | Readonly<{ kind: "deleted"; previous: ArtifactState }>
  | Readonly<{ current: ArtifactState; kind: "renamed"; previous: ArtifactState }>;

export interface ChangeSet {
  readonly baseRevision: string;
  readonly changes: readonly ArtifactChange[];
  readonly repositoryId: string;
  readonly targetRevision: string;
}

function validateArtifactState(state: ArtifactState, label: string): ArtifactState {
  const path = state.path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  const contentHash = state.contentHash.trim();

  if (path.length === 0 || path.startsWith("/") || path.startsWith("../")) {
    throw new Error(`${label}.path must be repository-relative`);
  }
  if (contentHash.length === 0) {
    throw new Error(`${label}.contentHash must not be empty`);
  }

  return Object.freeze({ contentHash, path });
}

export function createArtifactChange(change: ArtifactChange): ArtifactChange {
  if (change.kind === "added") {
    return Object.freeze({
      current: validateArtifactState(change.current, "current"),
      kind: "added",
    });
  }
  if (change.kind === "deleted") {
    return Object.freeze({
      kind: "deleted",
      previous: validateArtifactState(change.previous, "previous"),
    });
  }

  const current = validateArtifactState(change.current, "current");
  const previous = validateArtifactState(change.previous, "previous");

  if (change.kind === "renamed" && current.path === previous.path) {
    throw new Error("A renamed artifact must change path");
  }
  if (change.kind === "modified" && current.path !== previous.path) {
    throw new Error("A modified artifact must retain its path");
  }

  return Object.freeze({ current, kind: change.kind, previous });
}

export function createChangeSet(changeSet: ChangeSet): ChangeSet {
  const repositoryId = changeSet.repositoryId.trim();
  const baseRevision = changeSet.baseRevision.trim();
  const targetRevision = changeSet.targetRevision.trim();

  if (repositoryId.length === 0 || baseRevision.length === 0 || targetRevision.length === 0) {
    throw new Error("Change set repository and revisions must not be empty");
  }
  if (baseRevision === targetRevision) {
    throw new Error("Change set revisions must be different");
  }

  const changes = changeSet.changes.map(createArtifactChange);
  const currentPaths = changes.flatMap((change) =>
    "current" in change ? [change.current.path] : [],
  );

  if (new Set(currentPaths).size !== currentPaths.length) {
    throw new Error("Change set must not contain duplicate current artifact paths");
  }

  return Object.freeze({ baseRevision, changes, repositoryId, targetRevision });
}
