export interface OllamaClientOptions {
  readonly baseUrl: string;
  readonly concurrency?: number;
  readonly retryCount?: number;
  readonly timeoutMs: number;
}

type Fetch = typeof fetch;

class ConcurrencyGate {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  public constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("Ollama concurrency must be positive");
  }

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export class OllamaClient {
  private readonly gate: ConcurrencyGate;
  private readonly retryCount: number;

  public constructor(
    private readonly options: OllamaClientOptions,
    private readonly fetchImplementation: Fetch = fetch,
  ) {
    this.gate = new ConcurrencyGate(options.concurrency ?? 1);
    this.retryCount = options.retryCount ?? 1;
  }

  public post<T>(endpoint: string, body: Readonly<Record<string, unknown>>): Promise<T> {
    return this.gate.run(async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
        try {
          const response = await this.fetchImplementation(new URL(endpoint, this.options.baseUrl), {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
            method: "POST",
            signal: controller.signal,
          });
          if (!response.ok) {
            const detail = await response.text();
            throw new Error(`Ollama returned HTTP ${response.status}: ${detail.slice(0, 300)}`);
          }
          return (await response.json()) as T;
        } catch (error) {
          lastError = error;
        } finally {
          clearTimeout(timeout);
        }
      }
      throw new Error(
        `Ollama request failed after ${this.retryCount + 1} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    });
  }
}
