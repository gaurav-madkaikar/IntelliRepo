import type { ScanStageHandler, ScanStageResult } from "../executor/scan-stage.js";

/** Cross-file and framework resolution is performed by ExtractionPipeline before fact staging. */
export class ResolveRepositoryStage implements ScanStageHandler {
  public readonly stage = "RESOLVING" as const;

  public run(): Promise<ScanStageResult> {
    return Promise.resolve({ counts: { additionalResolutionPasses: 0 } });
  }
}
