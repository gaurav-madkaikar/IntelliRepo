import { Controller, Get, Res } from "@nestjs/common";
import type { InfrastructureHealth } from "@intellirepo/contracts";

import { HealthService } from "./health.service.js";

interface StatusResponse {
  status(code: number): unknown;
}

@Controller("health")
export class HealthController {
  public constructor(private readonly healthService: HealthService) {}

  @Get()
  public async check(
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<InfrastructureHealth> {
    const health = await this.healthService.check();
    response.status(health.status === "unhealthy" ? 503 : 200);
    return health;
  }
}
