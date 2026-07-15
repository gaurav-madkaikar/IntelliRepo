import "reflect-metadata";

import { createServer, type Server } from "node:http";

import { checkInfrastructureHealth, loadApplicationConfig } from "@intellirepo/contracts";
import { NestFactory } from "@nestjs/core";

import { WorkerModule } from "./worker.module.js";

async function bootstrap(): Promise<void> {
  const config = loadApplicationConfig();
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });

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
    healthServer.close();
    await app.close();
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void bootstrap();
