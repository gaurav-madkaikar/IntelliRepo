import type { ScanDiagnostic, ScanStage } from "@intellirepo/contracts";

import type { ScanExecutionContext } from "./scan-context.js";

export interface ScanStageResult {
  readonly counts?: Readonly<Record<string, number>>;
  readonly degradedReasons?: readonly string[];
  readonly diagnostics?: readonly ScanDiagnostic[];
}

export interface ScanStageHandler {
  readonly stage: ScanStage;
  run(context: ScanExecutionContext): Promise<ScanStageResult | void>;
}

export class ScanStageExecutionError extends Error {
  public constructor(
    message: string,
    public readonly recoverable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ScanStageExecutionError";
  }
}

export class NoOpGraphProjectionStage implements ScanStageHandler {
  public readonly stage = "PROJECTING_GRAPH" as const;

  public run(): Promise<ScanStageResult> {
    return Promise.resolve({ counts: { graphProjectionExternalCalls: 0 } });
  }
}
