import "reflect-metadata";

import { loadApplicationConfig } from "@intellirepo/contracts";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

import { ApiExceptionFilter } from "./api-exception.filter.js";
import { AppModule } from "./app.module.js";

async function bootstrap(): Promise<void> {
  const config = loadApplicationConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.enableShutdownHooks();
  app.enableCors({ origin: true });
  app.useGlobalFilters(new ApiExceptionFilter());
  const openApi = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("IntelliRepo Product API")
      .setDescription("Repository-scoped local-first code intelligence workflows")
      .setVersion("0.1.0")
      .build(),
  );
  SwaggerModule.setup("openapi", app, openApi);
  await app.listen(config.apiPort, "0.0.0.0");
}

void bootstrap();
