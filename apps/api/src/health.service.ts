import { Injectable } from "@nestjs/common";
import {
  checkInfrastructureHealth,
  loadApplicationConfig,
  type InfrastructureHealth,
} from "@intellirepo/contracts";

@Injectable()
export class HealthService {
  private readonly config = loadApplicationConfig();

  public check(): Promise<InfrastructureHealth> {
    return checkInfrastructureHealth(this.config);
  }
}
