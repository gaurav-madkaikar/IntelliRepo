import { describe, expect, it } from "vitest";

import { ExtractionPipeline } from "../../pipeline/extraction-pipeline.js";
import { createDefaultAdapterRegistry } from "../../pipeline/default-registry.js";

describe("NestFrameworkAdapter", () => {
  it("extracts composed routes, guards, interceptors, and DTOs", async () => {
    const result = await new ExtractionPipeline(createDefaultAdapterRegistry()).extract({
      artifacts: [
        {
          artifactKind: "build",
          content: JSON.stringify({ dependencies: { "@nestjs/core": "latest" } }),
          path: "package.json",
        },
        {
          artifactKind: "code",
          content: `@Controller("payments")
export class PaymentController {
  @Get(":id")
  @UseGuards(AuthGuard)
  getPayment(id: string): Promise<PaymentDto> { throw new Error(); }

  @Post()
  @UseInterceptors(AuditInterceptor)
  create(@Body() input: CreatePaymentDto): PaymentDto { throw new Error(); }
}`,
          language: "typescript",
          path: "src/payment.controller.ts",
        },
      ],
      repositoryId: "nest-fixture",
      revisionId: "nest-revision",
    });

    const entities = result.artifacts.flatMap(({ entities }) => entities);
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "endpoint", name: "GET /payments/{id}" }),
        expect.objectContaining({
          kind: "endpoint",
          name: "POST /payments",
          attributes: expect.objectContaining({ requestType: "CreatePaymentDto" }),
        }),
        expect.objectContaining({ kind: "middleware", name: "AuthGuard" }),
        expect.objectContaining({ kind: "middleware", name: "AuditInterceptor" }),
      ]),
    );
  });
});
