import { resolve } from "node:path";

import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();

const environmentSchema = z.object({
  API_PORT: positiveInteger.default(4100),
  DATABASE_URL: z
    .string()
    .url()
    .default("postgresql://intellirepo:intellirepo@localhost:5432/intellirepo"),
  GRAPH_QUERY_MAX_DEPTH: positiveInteger.max(12).default(4),
  GRAPH_QUERY_MAX_NODES: positiveInteger.max(10_000).default(200),
  MAX_FILE_BYTES: positiveInteger.default(1_048_576),
  NEO4J_PASSWORD: z.string().min(8).default("intellirepo-password"),
  NEO4J_URI: z.string().url().default("bolt://localhost:7687"),
  NEO4J_USERNAME: z.string().min(1).default("neo4j"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),
  OLLAMA_CHAT_MODEL: z.string().min(1).default("qwen2.5-coder:7b"),
  OLLAMA_CONCURRENCY: positiveInteger.max(16).default(1),
  OLLAMA_EMBEDDING_MODEL: z.string().min(1).default("nomic-embed-text"),
  OLLAMA_TIMEOUT_MS: positiveInteger.default(120_000),
  PARSER_CONCURRENCY: positiveInteger.max(64).default(4),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  REPOSITORY_ALLOWED_ROOTS: z.string().default("./examples,./.intellirepo-demo"),
  WORKER_HEALTH_PORT: positiveInteger.default(4101),
});

export interface ApplicationConfig {
  readonly apiPort: number;
  readonly databaseUrl: string;
  readonly graphQueryMaxDepth: number;
  readonly graphQueryMaxNodes: number;
  readonly maxFileBytes: number;
  readonly neo4jPassword: string;
  readonly neo4jUri: string;
  readonly neo4jUsername: string;
  readonly nodeEnv: "development" | "test" | "production";
  readonly ollamaBaseUrl: string;
  readonly ollamaChatModel: string;
  readonly ollamaConcurrency: number;
  readonly ollamaEmbeddingModel: string;
  readonly ollamaTimeoutMs: number;
  readonly parserConcurrency: number;
  readonly redisUrl: string;
  readonly repositoryAllowedRoots: readonly string[];
  readonly workerHealthPort: number;
}

export function loadApplicationConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): ApplicationConfig {
  const parsed = environmentSchema.parse(environment);
  const repositoryAllowedRoots = parsed.REPOSITORY_ALLOWED_ROOTS.split(",")
    .map((root) => root.trim())
    .filter((root) => root.length > 0)
    .map((root) => resolve(workingDirectory, root));

  if (repositoryAllowedRoots.length === 0) {
    throw new Error("REPOSITORY_ALLOWED_ROOTS must contain at least one path");
  }

  return {
    apiPort: parsed.API_PORT,
    databaseUrl: parsed.DATABASE_URL,
    graphQueryMaxDepth: parsed.GRAPH_QUERY_MAX_DEPTH,
    graphQueryMaxNodes: parsed.GRAPH_QUERY_MAX_NODES,
    maxFileBytes: parsed.MAX_FILE_BYTES,
    neo4jPassword: parsed.NEO4J_PASSWORD,
    neo4jUri: parsed.NEO4J_URI,
    neo4jUsername: parsed.NEO4J_USERNAME,
    nodeEnv: parsed.NODE_ENV,
    ollamaBaseUrl: parsed.OLLAMA_BASE_URL,
    ollamaChatModel: parsed.OLLAMA_CHAT_MODEL,
    ollamaConcurrency: parsed.OLLAMA_CONCURRENCY,
    ollamaEmbeddingModel: parsed.OLLAMA_EMBEDDING_MODEL,
    ollamaTimeoutMs: parsed.OLLAMA_TIMEOUT_MS,
    parserConcurrency: parsed.PARSER_CONCURRENCY,
    redisUrl: parsed.REDIS_URL,
    repositoryAllowedRoots,
    workerHealthPort: parsed.WORKER_HEALTH_PORT,
  };
}
