import { Module } from "@nestjs/common";

import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";
import { ProductModule } from "./product/product.module.js";

@Module({
  imports: [ProductModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class AppModule {}
