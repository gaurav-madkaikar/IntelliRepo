import type { SemanticProjector } from "@intellirepo/embeddings";

import type { ScanExecutionContext } from "../executor/scan-context.js";
import type { ScanStageHandler, ScanStageResult } from "../executor/scan-stage.js";
import { SemanticSourceBuilder } from "./semantic-source-builder.js";

export class EmbeddingStage implements ScanStageHandler {
  public readonly stage = "EMBEDDING" as const;

  public constructor(
    private readonly sources: SemanticSourceBuilder,
    private readonly projector: SemanticProjector,
  ) {}

  public async run(context: ScanExecutionContext): Promise<ScanStageResult> {
    try {
      const input = await this.sources.build(context);
      const result = await this.projector.project({
        removedSourceIds: input.removedSourceIds,
        repositoryId: context.scan.repositoryId,
        revisionId: context.scan.revisionId,
        sources: input.sources,
      });
      const degraded = result.state !== "current";
      return {
        counts: {
          embeddedChunks: result.embedded,
          eligibleSemanticChunks: result.eligible,
          removedSemanticChunks: result.removed,
          retainedSemanticChunks: result.retained,
        },
        ...(degraded
          ? {
              degradedReasons: [result.statusReason ?? "Semantic projection unavailable"],
              diagnostics: [
                {
                  code: "SEMANTIC_PROJECTION_DEGRADED",
                  message: result.statusReason ?? "Semantic projection unavailable",
                  severity: "warning" as const,
                  stage: "EMBEDDING" as const,
                },
              ],
            }
          : {}),
      };
    } catch (error) {
      const message = `Semantic projection failed; canonical facts remain available: ${error instanceof Error ? error.message : String(error)}`;
      return {
        counts: { embeddedChunks: 0 },
        degradedReasons: [message],
        diagnostics: [
          {
            code: "SEMANTIC_PROJECTION_FAILED",
            message,
            severity: "warning",
            stage: "EMBEDDING",
          },
        ],
      };
    }
  }
}
