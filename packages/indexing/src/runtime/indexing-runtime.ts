import type { IndexingDispatchMode, ScanJobSnapshot } from "@intellirepo/contracts";

export interface ScanTarget {
  readonly commitSha: string;
  readonly worktreeFingerprint: string;
}

export interface SubmitScanInput {
  readonly repositoryId: string;
  readonly target: ScanTarget;
}

export interface ScanSubmission {
  readonly created: boolean;
  readonly scan: ScanJobSnapshot;
}

export interface ScanTargetInspector {
  inspect(repositoryRoot: string): Promise<ScanTarget>;
}

export interface IndexingRuntime {
  readonly dispatchMode: IndexingDispatchMode;
  retry(scanJobId: string): Promise<ScanSubmission>;
  status(scanJobId: string): Promise<ScanJobSnapshot>;
  submit(input: SubmitScanInput): Promise<ScanSubmission>;
}

export type IndexingRuntimeErrorCode =
  | "INVALID_INPUT"
  | "NONRECOVERABLE_SCAN"
  | "REPOSITORY_NOT_FOUND"
  | "SCAN_NOT_FOUND"
  | "SCAN_NOT_RETRYABLE"
  | "STALE_SCAN_TARGET";

export class IndexingRuntimeError extends Error {
  public constructor(
    public readonly code: IndexingRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IndexingRuntimeError";
  }
}
