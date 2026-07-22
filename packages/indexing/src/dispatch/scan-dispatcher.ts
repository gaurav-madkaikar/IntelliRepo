export interface DispatchScanInput {
  readonly repositoryId: string;
  readonly revisionId: string;
  readonly scanJobId: string;
}

export interface ScanDispatcher {
  close(): Promise<void>;
  dispatch(input: DispatchScanInput): Promise<void>;
}

export interface ScanExecutorPort {
  execute(scanJobId: string): Promise<void>;
}
