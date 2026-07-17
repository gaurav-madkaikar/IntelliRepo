import type { ArtifactExtractionResult } from "../../interfaces/extraction.js";
import type {
  FrameworkAdapter,
  FrameworkAdapterContext,
} from "../../interfaces/framework-adapter.js";
import {
  dynamicRouteDiagnostic,
  enrichFrameworkFacts,
  joinPaths,
  linesWithOffsets,
  sourceArtifacts,
  stringLiteral,
  type EndpointCandidate,
  type FrameworkScanResult,
} from "../shared/framework-facts.js";

const HTTP_DECORATORS = new Set(["Delete", "Get", "Head", "Options", "Patch", "Post", "Put"]);

function controllerPrefix(content: string): string {
  return stringLiteral(/@Controller\s*\(\s*([^)]*)\)/u.exec(content)?.[1]) ?? "";
}

function scanNest(context: FrameworkAdapterContext): ReadonlyMap<string, FrameworkScanResult> {
  const scans = new Map<string, FrameworkScanResult>();
  for (const artifact of sourceArtifacts(context, "typescript").filter(({ content }) =>
    /@Controller\s*\(/u.test(content),
  )) {
    const candidates: EndpointCandidate[] = [];
    const diagnostics = [];
    const prefix = controllerPrefix(artifact.content);
    const classDeclaration = artifact.content.search(/\bclass\s+[A-Za-z_$][\w$]*/u);
    const classMiddleware = [
      ...artifact.content
        .slice(0, classDeclaration < 0 ? 0 : classDeclaration)
        .matchAll(/@(UseGuards|UseInterceptors|UsePipes)\s*\((.*)\)/gu),
    ].flatMap((value) =>
      (value[2] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    );
    let pendingRoute:
      { decorator: string; expression?: string; offset: number; text: string } | undefined;
    let pendingMiddleware: string[] = [];

    for (const { line, offset } of linesWithOffsets(artifact.content)) {
      if (offset + line.length <= classDeclaration) continue;
      const routeDecorator = /@(Delete|Get|Head|Options|Patch|Post|Put)\s*(?:\((.*)\))?/u.exec(
        line,
      );
      if (routeDecorator !== null && HTTP_DECORATORS.has(routeDecorator[1] ?? "")) {
        pendingRoute = {
          decorator: routeDecorator[1] ?? "Get",
          ...(routeDecorator[2] === undefined ? {} : { expression: routeDecorator[2] }),
          offset,
          text: line,
        };
        continue;
      }
      const middlewareDecorator = /@(UseGuards|UseInterceptors|UsePipes)\s*\((.*)\)/u.exec(line);
      if (middlewareDecorator !== null) {
        pendingMiddleware.push(
          ...(middlewareDecorator[2] ?? "")
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean),
        );
        continue;
      }
      if (pendingRoute === undefined) continue;
      const method =
        /(?:public\s+|protected\s+|private\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\((.*)\)\s*(?::\s*([^\n{=]+))?\s*\{/u.exec(
          line,
        );
      if (method === null) continue;

      const expression = pendingRoute.expression;
      const route = stringLiteral(expression);
      if (route === undefined) {
        diagnostics.push(
          dynamicRouteDiagnostic("nest", artifact, expression ?? "", pendingRoute.offset),
        );
        pendingRoute = undefined;
        pendingMiddleware = [];
        continue;
      }
      const parameters = method[2] ?? "";
      const requestType = /@Body\s*\([^)]*\)\s*[A-Za-z_$][\w$]*\s*:\s*([\w.<>[\]]+)/u.exec(
        parameters,
      )?.[1];
      const responseType = method[3]?.trim().replace(/^Promise<(.+)>$/u, "$1");
      candidates.push({
        artifactPath: artifact.path,
        declaredPath: joinPaths(prefix, route),
        endOffset: offset + line.length,
        evidence: `${pendingRoute.text}\n${line}`,
        handlerName: method[1] ?? "",
        httpMethod: pendingRoute.decorator.toUpperCase(),
        middleware: [...classMiddleware, ...pendingMiddleware],
        ...(requestType === undefined ? {} : { requestType }),
        ...(responseType === undefined ? {} : { responseType }),
        startOffset: pendingRoute.offset,
      });
      pendingRoute = undefined;
      pendingMiddleware = [];
    }
    scans.set(artifact.path, { candidates, diagnostics });
  }
  return scans;
}

export class NestFrameworkAdapter implements FrameworkAdapter {
  public readonly framework = "nestjs";
  public readonly id = "nest-framework";

  public supports(detection: FrameworkAdapterContext["detection"]): boolean {
    return detection.frameworks.includes(this.framework);
  }

  public async enrich(
    context: FrameworkAdapterContext,
    artifacts: readonly ArtifactExtractionResult[],
  ): Promise<readonly ArtifactExtractionResult[]> {
    return enrichFrameworkFacts(context, artifacts, this.id, "typescript", scanNest(context));
  }
}
