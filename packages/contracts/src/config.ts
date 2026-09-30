import { resolve } from "node:path";

import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();
const nonNegativeInteger = z.coerce.number().int().nonnegative();
const environmentBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return value;
}, z.boolean());

const environmentSchema = z.object({
  API_PORT: positiveInteger.default(4100),
  DATABASE_URL: z
    .string()
    .url()
    .default("postgresql://intellirepo:intellirepo@localhost:5432/intellirepo"),
  GRAPH_QUERY_MAX_DEPTH: positiveInteger.max(12).default(4),
  GRAPH_QUERY_MAX_NODES: positiveInteger.max(10_000).default(200),
  GITHUB_TOKEN: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  INDEXING_MODE: z.enum(["bullmq", "inline"]).default("bullmq"),
  MAX_FILE_BYTES: positiveInteger.default(1_048_576),
  MAX_REPOSITORY_FILES: positiveInteger.max(100_000).default(5_000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  OLLAMA_ENABLED: environmentBoolean.default(true),
  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),
  OLLAMA_CHAT_MODEL: z.string().min(1).default("qwen2.5-coder:7b"),
  OLLAMA_CONCURRENCY: positiveInteger.max(16).default(1),
  OLLAMA_EMBEDDING_MODEL: z.string().min(1).default("nomic-embed-text"),
  OLLAMA_TIMEOUT_MS: positiveInteger.default(120_000),
  PARSER_CONCURRENCY: positiveInteger.max(64).default(4),
  REDIS_URL: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().url().optional(),
  ),
  REPOSITORY_ALLOWED_ROOTS: z.string().default("./examples,./.intellirepo-demo"),
  SCAN_DISPATCH_POLL_INTERVAL_MS: positiveInteger.max(60_000).default(1_000),
  SCAN_HEARTBEAT_INTERVAL_MS: positiveInteger.max(300_000).default(10_000),
  SCAN_LEASE_DURATION_MS: positiveInteger.max(900_000).default(30_000),
  SCAN_RETRY_BACKOFF_MS: positiveInteger.max(300_000).default(1_000),
  SCAN_RETRY_COUNT: nonNegativeInteger.max(20).default(3),
  WORKER_CONCURRENCY: positiveInteger.max(64).default(2),
  WORKER_HEALTH_PORT: positiveInteger.default(4101),
});

export interface ApplicationConfig {
  readonly apiPort: number;
  readonly databaseUrl: string;
  readonly graphQueryMaxDepth: number;
  readonly graphQueryMaxNodes: number;
  readonly githubToken?: string;
  readonly indexingMode: "bullmq" | "inline";
  readonly maxFileBytes: number;
  readonly maxRepositoryFiles: number;
  readonly nodeEnv: "development" | "test" | "production";
  readonly ollamaEnabled: boolean;
  readonly ollamaBaseUrl: string;
  readonly ollamaChatModel: string;
  readonly ollamaConcurrency: number;
  readonly ollamaEmbeddingModel: string;
  readonly ollamaTimeoutMs: number;
  readonly parserConcurrency: number;
  readonly redisUrl?: string;
  readonly repositoryAllowedRoots: readonly string[];
  readonly scanDispatchPollIntervalMs: number;
  readonly scanHeartbeatIntervalMs: number;
  readonly scanLeaseDurationMs: number;
  readonly scanRetryBackoffMs: number;
  readonly scanRetryCount: number;
  readonly workerConcurrency: number;
  readonly workerHealthPort: number;
}

export function loadApplicationConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): ApplicationConfig {
  const parsed = environmentSchema.parse(environment);
  if (parsed.SCAN_HEARTBEAT_INTERVAL_MS >= parsed.SCAN_LEASE_DURATION_MS) {
    throw new Error("SCAN_HEARTBEAT_INTERVAL_MS must be shorter than SCAN_LEASE_DURATION_MS");
  }
  const repositoryAllowedRoots = parsed.REPOSITORY_ALLOWED_ROOTS.split(",")
    .map((root) => root.trim())
    .filter((root) => root.length > 0)
    .map((root) => resolve(workingDirectory, root));

  if (repositoryAllowedRoots.length === 0) {
    throw new Error("REPOSITORY_ALLOWED_ROOTS must contain at least one path");
  }

  const redisUrl =
    parsed.INDEXING_MODE === "bullmq" ? (parsed.REDIS_URL ?? "redis://localhost:6379") : undefined;

  return {
    apiPort: parsed.API_PORT,
    databaseUrl: parsed.DATABASE_URL,
    graphQueryMaxDepth: parsed.GRAPH_QUERY_MAX_DEPTH,
    graphQueryMaxNodes: parsed.GRAPH_QUERY_MAX_NODES,
    ...(parsed.GITHUB_TOKEN === undefined ? {} : { githubToken: parsed.GITHUB_TOKEN }),
    indexingMode: parsed.INDEXING_MODE,
    maxFileBytes: parsed.MAX_FILE_BYTES,
    maxRepositoryFiles: parsed.MAX_REPOSITORY_FILES,
    nodeEnv: parsed.NODE_ENV,
    ollamaEnabled: parsed.OLLAMA_ENABLED,
    ollamaBaseUrl: parsed.OLLAMA_BASE_URL,
    ollamaChatModel: parsed.OLLAMA_CHAT_MODEL,
    ollamaConcurrency: parsed.OLLAMA_CONCURRENCY,
    ollamaEmbeddingModel: parsed.OLLAMA_EMBEDDING_MODEL,
    ollamaTimeoutMs: parsed.OLLAMA_TIMEOUT_MS,
    parserConcurrency: parsed.PARSER_CONCURRENCY,
    ...(redisUrl === undefined ? {} : { redisUrl }),
    repositoryAllowedRoots,
    scanDispatchPollIntervalMs: parsed.SCAN_DISPATCH_POLL_INTERVAL_MS,
    scanHeartbeatIntervalMs: parsed.SCAN_HEARTBEAT_INTERVAL_MS,
    scanLeaseDurationMs: parsed.SCAN_LEASE_DURATION_MS,
    scanRetryBackoffMs: parsed.SCAN_RETRY_BACKOFF_MS,
    scanRetryCount: parsed.SCAN_RETRY_COUNT,
    workerConcurrency: parsed.WORKER_CONCURRENCY,
    workerHealthPort: parsed.WORKER_HEALTH_PORT,
  };
}
