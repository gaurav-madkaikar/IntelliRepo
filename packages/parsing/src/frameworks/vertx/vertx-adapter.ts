import type { ArtifactExtractionResult, SourceArtifactInput } from "../../interfaces/extraction.js";
import type {
  FrameworkAdapter,
  FrameworkAdapterContext,
} from "../../interfaces/framework-adapter.js";
import {
  dynamicRouteDiagnostic,
  enrichFrameworkFacts,
  linesWithOffsets,
  sourceArtifacts,
  stringLiteral,
  type EndpointCandidate,
  type FrameworkScanResult,
} from "../shared/framework-facts.js";

function referenceName(expression: string): string | undefined {
  const normalized = expression.trim().replace(/^(?:this|[A-Za-z_$][\w$]*)::/u, "");
  return /^[A-Za-z_$][\w$]*$/u.test(normalized) ? normalized : undefined;
}

function scanArtifact(artifact: SourceArtifactInput): FrameworkScanResult {
  const candidates: EndpointCandidate[] = [];
  const diagnostics = [];

  for (const { line, offset } of linesWithOffsets(artifact.content)) {
    const direct = /\brouter\.(get|post|put|patch|delete|head|options)\s*\(\s*([^)]*)\)/iu.exec(
      line,
    );
    const constrained =
      /\brouter\.route\s*\(\s*([^)]*)\)\s*\.method\s*\(\s*HttpMethod\.([A-Z]+)\s*\)/u.exec(line);
    if (direct === null && constrained === null) continue;

    const expression = direct?.[2] ?? constrained?.[1];
    const route = stringLiteral(expression);
    if (route === undefined) {
      diagnostics.push(dynamicRouteDiagnostic("vertx", artifact, expression ?? "", offset));
      continue;
    }

    const handlers = [...line.matchAll(/\.handler\s*\(\s*([^)]*)\)/gu)]
      .map((match) => referenceName(match[1] ?? ""))
      .filter((name): name is string => name !== undefined);
    const handlerName = handlers.at(-1);
    if (handlerName === undefined) continue;
    candidates.push({
      artifactPath: artifact.path,
      declaredPath: route,
      endOffset: offset + line.length,
      evidence: line,
      handlerName,
      httpMethod: direct?.[1]?.toUpperCase() ?? constrained?.[2] ?? "GET",
      middleware: handlers.slice(0, -1),
      startOffset: offset,
    });
  }

  return { candidates, diagnostics };
}

export class VertxFrameworkAdapter implements FrameworkAdapter {
  public readonly framework = "vertx";
  public readonly id = "vertx-framework";

  public supports(detection: FrameworkAdapterContext["detection"]): boolean {
    return detection.frameworks.includes(this.framework);
  }

  public async enrich(
    context: FrameworkAdapterContext,
    artifacts: readonly ArtifactExtractionResult[],
  ): Promise<readonly ArtifactExtractionResult[]> {
    let enriched = artifacts;
    for (const language of ["java", "kotlin"] as const) {
      const scans = new Map(
        sourceArtifacts(context, language).map((artifact) => [
          artifact.path,
          scanArtifact(artifact),
        ]),
      );
      enriched = await Promise.resolve(
        enrichFrameworkFacts(context, enriched, this.id, language, scans),
      );
    }
    return enriched;
  }
}
