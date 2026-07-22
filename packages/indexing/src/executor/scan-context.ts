import type { ScanJobSnapshot } from "@intellirepo/contracts";

export class ScanExecutionContext {
  private readonly values = new Map<string, unknown>();

  public constructor(public readonly scan: ScanJobSnapshot) {}

  public get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  public require<T>(key: string): T {
    const value = this.get<T>(key);
    if (value === undefined) throw new Error(`Scan context value ${key} is unavailable`);
    return value;
  }

  public set<T>(key: string, value: T): void {
    this.values.set(key, value);
  }
}
