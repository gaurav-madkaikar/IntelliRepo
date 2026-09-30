import type { DispatchScanInput, ScanDispatcher, ScanExecutorPort } from "./scan-dispatcher.js";

export type InlineDispatchFailureHandler = (error: unknown, input: DispatchScanInput) => void;

export class InlineScanDispatcher implements ScanDispatcher {
  private closed = false;

  public constructor(
    private readonly executor: ScanExecutorPort,
    private readonly onFailure: InlineDispatchFailureHandler = () => undefined,
  ) {}

  public async dispatch(input: DispatchScanInput): Promise<void> {
    if (this.closed) throw new Error("Inline scan dispatcher is closed");
    queueMicrotask(() => {
      void this.executor.execute(input.scanJobId).catch((error: unknown) => {
        this.onFailure(error, input);
      });
    });
  }

  public close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
