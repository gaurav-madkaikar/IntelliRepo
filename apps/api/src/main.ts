import "reflect-metadata";

import { loadApplicationConfig } from "@intellirepo/contracts";
import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module.js";

async function bootstrap(): Promise<void> {
  const config = loadApplicationConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.enableShutdownHooks();
  await app.listen(config.apiPort, "0.0.0.0");
}

void bootstrap();
