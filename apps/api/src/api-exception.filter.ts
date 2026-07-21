import {
  ArgumentsHost,
  Catch,
  ConflictException,
  ExceptionFilter,
  NotFoundException,
} from "@nestjs/common";

import { ApiConflictError, ApiResourceNotFoundError } from "./product/product-facade.js";

@Catch(ApiConflictError, ApiResourceNotFoundError)
export class ApiExceptionFilter implements ExceptionFilter {
  public catch(exception: Error, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { json(body: unknown): void };
    }>();
    const mapped =
      exception instanceof ApiResourceNotFoundError
        ? new NotFoundException({ error: "resource_not_found", message: exception.message })
        : new ConflictException({ error: "canonical_state_conflict", message: exception.message });
    response.status(mapped.getStatus()).json(mapped.getResponse());
  }
}
