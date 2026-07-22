import type { Embedder } from "../embedder.js";
import type { StructuredGenerator } from "../generator.js";
import { OllamaClient } from "./ollama-client.js";
import { OllamaEmbedder } from "./ollama-embedder.js";
import { OllamaStructuredGenerator } from "./ollama-generator.js";

interface OllamaTagsResponse {
  readonly models?: readonly { readonly model?: string; readonly name?: string }[];
}

export interface OllamaRuntimeOptions {
  readonly cooldownMs?: number;
  readonly embeddingModel: string;
  readonly generationModel: string;
  readonly healthyTtlMs?: number;
}

export interface OllamaCapabilities {
  readonly checkedAt: string;
  readonly embedder?: Embedder;
  readonly embeddingAvailable: boolean;
  readonly generationAvailable: boolean;
  readonly generator?: StructuredGenerator;
  readonly reason?: string;
  readonly state: "available" | "degraded" | "unavailable";
}

function normalizedModels(response: OllamaTagsResponse): ReadonlySet<string> {
  if (!Array.isArray(response.models)) throw new Error("Ollama model response is malformed");
  return new Set(
    response.models
      .flatMap(({ model, name }) => [model, name])
      .filter((value): value is string => typeof value === "string"),
  );
}

function hasModel(models: ReadonlySet<string>, requested: string): boolean {
  const base = requested.split(":")[0] ?? requested;
  return models.has(requested) || models.has(base) || models.has(`${base}:latest`);
}

export class OllamaRuntime {
  private cached?: { readonly capabilities: OllamaCapabilities; readonly expiresAt: number };
  private readonly cooldownMs: number;
  private readonly healthyTtlMs: number;

  public constructor(
    private readonly client: OllamaClient,
    private readonly options: OllamaRuntimeOptions,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.healthyTtlMs = options.healthyTtlMs ?? 10_000;
  }

  public async inspect(force = false): Promise<OllamaCapabilities> {
    const now = this.clock();
    if (!force && this.cached !== undefined && this.cached.expiresAt > now.getTime()) {
      return this.cached.capabilities;
    }
    try {
      const models = normalizedModels(await this.client.get<OllamaTagsResponse>("/api/tags"));
      const embeddingAvailable = hasModel(models, this.options.embeddingModel);
      const generationAvailable = hasModel(models, this.options.generationModel);
      const missing = [
        ...(embeddingAvailable ? [] : [`embedding model ${this.options.embeddingModel}`]),
        ...(generationAvailable ? [] : [`generation model ${this.options.generationModel}`]),
      ];
      const capabilities: OllamaCapabilities = {
        checkedAt: now.toISOString(),
        ...(embeddingAvailable
          ? { embedder: new OllamaEmbedder(this.client, this.options.embeddingModel) }
          : {}),
        embeddingAvailable,
        generationAvailable,
        ...(generationAvailable
          ? { generator: new OllamaStructuredGenerator(this.client, this.options.generationModel) }
          : {}),
        ...(missing.length === 0 ? {} : { reason: `Missing ${missing.join(" and ")}` }),
        state:
          missing.length === 0
            ? "available"
            : embeddingAvailable || generationAvailable
              ? "degraded"
              : "unavailable",
      };
      this.cached = { capabilities, expiresAt: now.getTime() + this.healthyTtlMs };
      return capabilities;
    } catch (error) {
      const capabilities: OllamaCapabilities = {
        checkedAt: now.toISOString(),
        embeddingAvailable: false,
        generationAvailable: false,
        reason: `Ollama unavailable: ${error instanceof Error ? error.message : String(error)}`,
        state: "unavailable",
      };
      this.cached = { capabilities, expiresAt: now.getTime() + this.cooldownMs };
      return capabilities;
    }
  }
}
