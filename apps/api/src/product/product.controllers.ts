import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBody, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import {
  askQuestionSchema,
  documentationApplySchema,
  documentationHealthQuerySchema,
  documentationPreviewSchema,
  entitySearchSchema,
  graphNeighborhoodSchema,
  registerRepositorySchema,
  revisionPairSchema,
  triggerScanSchema,
} from "@intellirepo/contracts";
import { z } from "zod";

import { PRODUCT_FACADE, type ProductFacade } from "./product-facade.js";

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException({
      error: "request_validation_failed",
      issues: result.error.issues.map(({ message, path }) => ({ message, path })),
      message: "Request does not match the IntelliRepo API contract",
    });
  }
  return result.data;
}

function openApiSchema(schema: z.ZodType): never {
  return z.toJSONSchema(schema) as never;
}

@ApiTags("repositories")
@Controller("repositories")
export class RepositoriesController {
  public constructor(@Inject(PRODUCT_FACADE) private readonly facade: ProductFacade) {}

  @Get()
  @ApiOperation({ summary: "List registered local repositories" })
  public list() {
    return this.facade.listRepositories();
  }

  @Post()
  @ApiOperation({ summary: "Register a repository inside an allowed local root" })
  @ApiBody({ schema: openApiSchema(registerRepositorySchema) })
  public register(@Body() body: unknown) {
    return this.facade.registerRepository(parse(registerRepositorySchema, body));
  }
}

@ApiTags("overview")
@Controller("repositories/:repositoryId/overview")
export class OverviewController {
  public constructor(@Inject(PRODUCT_FACADE) private readonly facade: ProductFacade) {}

  @Get()
  @ApiParam({ name: "repositoryId" })
  public get(@Param("repositoryId") repositoryId: string) {
    return this.facade.overview(repositoryId);
  }
}

@ApiTags("scans")
@Controller("repositories/:repositoryId/scans")
export class ScansController {
  public constructor(@Inject(PRODUCT_FACADE) private readonly facade: ProductFacade) {}

  @Post()
  @ApiBody({ schema: openApiSchema(triggerScanSchema) })
  public trigger(@Param("repositoryId") repositoryId: string, @Body() body: unknown) {
    return this.facade.triggerScan(repositoryId, parse(triggerScanSchema, body));
  }

  @Get(":jobId")
  public status(@Param("repositoryId") repositoryId: string, @Param("jobId") jobId: string) {
    return this.facade.scan(repositoryId, jobId);
  }

  @Post(":jobId/retry")
  public retry(@Param("repositoryId") repositoryId: string, @Param("jobId") jobId: string) {
    return this.facade.retryScan(repositoryId, jobId);
  }
}

@ApiTags("entities")
@Controller("repositories/:repositoryId/entities")
export class EntitiesController {
  public constructor(@Inject(PRODUCT_FACADE) private readonly facade: ProductFacade) {}

  @Get()
  public search(@Param("repositoryId") repositoryId: string, @Query() query: unknown) {
    return this.facade.searchEntities(repositoryId, parse(entitySearchSchema, query));
  }
}

@ApiTags("graph")
@Controller("repositories/:repositoryId/graph")
export class GraphController {
  public constructor(@Inject(PRODUCT_FACADE) private readonly facade: ProductFacade) {}

  @Post("neighborhood")
  @ApiBody({ schema: openApiSchema(graphNeighborhoodSchema) })
  public neighborhood(@Param("repositoryId") repositoryId: string, @Body() body: unknown) {
    return this.facade.graph(repositoryId, parse(graphNeighborhoodSchema, body));
  }
}

@ApiTags("impact")
@Controller("repositories/:repositoryId/impact")
export class ImpactController {
  public constructor(@Inject(PRODUCT_FACADE) private readonly facade: ProductFacade) {}

  @Get()
  public get(@Param("repositoryId") repositoryId: string, @Query() query: unknown) {
    return this.facade.impact(repositoryId, parse(revisionPairSchema, query));
  }
}

@ApiTags("documentation")
@Controller("repositories/:repositoryId/documentation")
export class DocumentationController {
  public constructor(@Inject(PRODUCT_FACADE) private readonly facade: ProductFacade) {}

  @Get("health")
  public health(@Param("repositoryId") repositoryId: string, @Query() query: unknown) {
    return this.facade.documentationHealth(
      repositoryId,
      parse(documentationHealthQuerySchema, query),
    );
  }

  @Post("previews")
  @ApiBody({ schema: openApiSchema(documentationPreviewSchema) })
  public preview(@Param("repositoryId") repositoryId: string, @Body() body: unknown) {
    return this.facade.previewDocumentation(repositoryId, parse(documentationPreviewSchema, body));
  }

  @Post("previews/:reviewId/apply")
  @ApiBody({ schema: openApiSchema(documentationApplySchema) })
  public apply(
    @Param("repositoryId") repositoryId: string,
    @Param("reviewId") reviewId: string,
    @Body() body: unknown,
  ) {
    parse(documentationApplySchema, body);
    return this.facade.applyDocumentation(repositoryId, reviewId);
  }
}

@ApiTags("questions")
@Controller("repositories/:repositoryId/questions")
export class QuestionsController {
  public constructor(@Inject(PRODUCT_FACADE) private readonly facade: ProductFacade) {}

  @Post()
  @ApiBody({ schema: openApiSchema(askQuestionSchema) })
  public submit(@Param("repositoryId") repositoryId: string, @Body() body: unknown) {
    return this.facade.submitQuestion(repositoryId, parse(askQuestionSchema, body));
  }

  @Get(":taskId")
  public status(@Param("repositoryId") repositoryId: string, @Param("taskId") taskId: string) {
    return this.facade.question(repositoryId, taskId);
  }
}

@ApiTags("diagnostics")
@Controller("repositories/:repositoryId/diagnostics")
export class DiagnosticsController {
  public constructor(@Inject(PRODUCT_FACADE) private readonly facade: ProductFacade) {}

  @Get()
  public get(@Param("repositoryId") repositoryId: string) {
    return this.facade.diagnostics(repositoryId);
  }
}

export const PRODUCT_CONTROLLERS = [
  RepositoriesController,
  OverviewController,
  ScansController,
  EntitiesController,
  GraphController,
  ImpactController,
  DocumentationController,
  QuestionsController,
  DiagnosticsController,
] as const;
