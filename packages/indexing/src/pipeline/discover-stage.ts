import type { ScanDiagnostic } from "@intellirepo/contracts";

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

function discoveryDiagnostic(
  diagnostic: Awaited<ReturnType<RepositorySnapshotProvider["load"]>>["diagnostics"][number],
): ScanDiagnostic {
  return {
    code: `REPOSITORY_${diagnostic.reason.toUpperCase().replaceAll("-", "_")}`,
    message: diagnostic.message,
    path: diagnostic.path,
    severity: "warning",
    stage: "DISCOVERING",
  };
}

export class DiscoverRepositoryStage implements ScanStageHandler {
  public readonly stage = "DISCOVERING" as const;

  public constructor(private readonly snapshots: RepositorySnapshotProvider) {}

  public async run(context: ScanExecutionContext): Promise<ScanStageResult> {
    try {
      const snapshot = await this.snapshots.load(context);
      return {
        counts: {
          changedArtifacts: snapshot.changeSet.changes.length,
          discoveredArtifacts: snapshot.artifacts.length,
          repositoryDiagnostics: snapshot.diagnostics.length,
        },
        diagnostics: snapshot.diagnostics.map(discoveryDiagnostic),
      };
    } catch (error) {
      throw new ScanStageExecutionError(
        error instanceof Error ? error.message : "Repository discovery failed",
        !(error instanceof RepositoryTargetChangedError),
        { cause: error },
      );
    }
  }
}
