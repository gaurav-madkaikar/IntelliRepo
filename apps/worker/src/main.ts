import "reflect-metadata";

import { createServer, type Server } from "node:http";

import { OllamaClient, OllamaRuntime } from "@intellirepo/ai";
import { createCatalogDatabase, migrateCatalogToLatest } from "@intellirepo/catalog";
import { checkInfrastructureHealth, loadApplicationConfig } from "@intellirepo/contracts";
import {
  BullMqScanDispatcher,
  createIndexingExecutor,
  OutboxDispatcher,
  SCAN_QUEUE_NAME,
  type DispatchScanInput,
} from "@intellirepo/indexing";
import { NestFactory } from "@nestjs/core";
import { Worker } from "bullmq";

import { WorkerModule } from "./worker.module.js";

async function bootstrap(): Promise<void> {
  const config = loadApplicationConfig();
  if (config.indexingMode !== "bullmq" || config.redisUrl === undefined) {
    throw new Error("The worker requires INDEXING_MODE=bullmq and REDIS_URL");
  }
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  const database = createCatalogDatabase(config.databaseUrl);
  const migration = await migrateCatalogToLatest(database.database);
  if (migration.error !== undefined) throw migration.error;
  const ollama = config.ollamaEnabled
    ? new OllamaRuntime(
        new OllamaClient({
          baseUrl: config.ollamaBaseUrl,
          concurrency: config.ollamaConcurrency,
          timeoutMs: config.ollamaTimeoutMs,
        }),
        {
          embeddingModel: config.ollamaEmbeddingModel,
          generationModel: config.ollamaChatModel,
        },
      )
    : undefined;
  const scanWorker = new Worker<DispatchScanInput>(
    SCAN_QUEUE_NAME,
    async (job) => {
      const capabilities = await ollama?.inspect();
      await createIndexingExecutor({
        config,
        database: database.database,
        ...(capabilities?.embedder === undefined ? {} : { embedder: capabilities.embedder }),
        owner: `worker-${String(process.pid)}-${job.id ?? "scan"}`,
      }).execute(job.data.scanJobId);
    },
    {
      concurrency: config.workerConcurrency,
      connection: { lazyConnect: true, maxRetriesPerRequest: null, url: config.redisUrl },
    },
  );
  const queueDispatcher = BullMqScanDispatcher.connect(config.redisUrl, {
    attempts: config.scanRetryCount + 1,
    backoffMs: config.scanRetryBackoffMs,
  });
  const outbox = new OutboxDispatcher(database.database, queueDispatcher, {
    limit: 100,
    owner: `worker-outbox-${String(process.pid)}`,
    retryBackoffMs: config.scanRetryBackoffMs,
  });
  let pumping = false;
  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      await outbox.pump();
    } finally {
      pumping = false;
    }
  };
  await pump();
  const outboxTimer = setInterval(() => void pump(), config.scanDispatchPollIntervalMs);

  const healthServer: Server = createServer(async (request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }

    const health = await checkInfrastructureHealth(config);
    const statusCode = health.status === "unhealthy" ? 503 : 200;

    response.writeHead(statusCode, { "content-type": "application/json" });
    response.end(JSON.stringify(health));
  });

  healthServer.listen(config.workerHealthPort, "0.0.0.0");

  const shutdown = async (): Promise<void> => {
    clearInterval(outboxTimer);
    healthServer.close();
    await queueDispatcher.close();
    await scanWorker.close();
    await database.destroy();
    await app.close();
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void bootstrap();
