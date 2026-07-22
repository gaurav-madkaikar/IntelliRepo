import { ProjectionStateCatalog, type CatalogDatabase } from "@intellirepo/catalog";
import type { Kysely } from "kysely";

import type { ScanExecutionContext } from "../executor/scan-context.js";
import {
  ScanStageExecutionError,
  type ScanStageHandler,
  type ScanStageResult,
} from "../executor/scan-stage.js";
import { RevisionAnalysis } from "./revision-analysis.js";

export class AnalysisStage implements ScanStageHandler {
  public readonly stage = "ANALYZING" as const;

  public constructor(
    private readonly database: Kysely<CatalogDatabase>,
    private readonly analysis: RevisionAnalysis,
  ) {}

  public async run(context: ScanExecutionContext): Promise<ScanStageResult> {
    try {
      return await this.analysis.run(context);
    } catch (error) {
      const states = new ProjectionStateCatalog(this.database);
      const previous = await states.find(context.scan.repositoryId, "analysis");
      await states.save({
        error: {
          message: error instanceof Error ? error.message : "Revision analysis failed",
        },
        projection: "analysis",
        repositoryId: context.scan.repositoryId,
        ...(previous?.revision_id === null || previous?.revision_id === undefined
          ? {}
          : { revisionId: previous.revision_id }),
        state: "failed",
      });
      throw new ScanStageExecutionError(
        error instanceof Error ? error.message : "Revision analysis failed",
        true,
        { cause: error },
      );
    }
  }
}
