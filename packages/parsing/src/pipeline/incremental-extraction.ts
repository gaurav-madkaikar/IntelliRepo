import type { ChangeSet } from "@intellirepo/domain";

import type {
  ProjectExtractionInput,
  ProjectExtractionResult,
  SourceArtifactInput,
} from "../interfaces/extraction.js";

export interface ProjectExtractor {
  extract(input: ProjectExtractionInput): Promise<ProjectExtractionResult>;
}

export interface IncrementalExtractionInput {
  readonly artifacts: readonly SourceArtifactInput[];
  readonly changeSet: ChangeSet;
  /** Canonical revision id; this may differ from the Git commit label in the change set. */
  readonly revisionId: string;
}

export interface IncrementalExtractionResult {
  readonly extraction: ProjectExtractionResult;
  readonly parsedPaths: readonly string[];
  readonly removedPaths: readonly string[];
}

/** Selects only added, modified, and renamed destinations for parser invocation. */
export class IncrementalExtractionCoordinator {
  public constructor(private readonly extractor: ProjectExtractor) {}

  public async extract(input: IncrementalExtractionInput): Promise<IncrementalExtractionResult> {
    if (input.changeSet.repositoryId.trim().length === 0) {
      throw new Error("Incremental extraction requires a repository id");
    }
    const artifactByPath = new Map(input.artifacts.map((artifact) => [artifact.path, artifact]));
    const parsedPaths = input.changeSet.changes.flatMap((change) =>
      "current" in change && artifactByPath.has(change.current.path) ? [change.current.path] : [],
    );
    const removedPaths = input.changeSet.changes.flatMap((change) =>
      change.kind === "deleted" || change.kind === "renamed" ? [change.previous.path] : [],
    );
    const changedArtifacts = parsedPaths.map((path) => {
      const artifact = artifactByPath.get(path);
      if (artifact === undefined) {
        throw new Error(`Changed artifact ${path} is missing from extraction input`);
      }
      return artifact;
    });
    const extraction = await this.extractor.extract({
      artifacts: input.artifacts,
      repositoryId: input.changeSet.repositoryId,
      revisionId: input.revisionId,
      selectedArtifactPaths: changedArtifacts.map(({ path }) => path),
    });
    return {
      extraction,
      parsedPaths: Object.freeze(parsedPaths),
      removedPaths: Object.freeze(removedPaths),
    };
  }
}
