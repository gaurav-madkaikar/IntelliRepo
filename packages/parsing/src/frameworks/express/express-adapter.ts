import type { ArtifactExtractionResult, SourceArtifactInput } from "../../interfaces/extraction.js";
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

function identifier(expression: string): string | undefined {
  const normalized = expression.trim();
  return /^[A-Za-z_$][\w$]*$/u.test(normalized) ? normalized : undefined;
}

function mounts(content: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const match of content.matchAll(
    /\b(?:app|router)\.use\s*\(\s*([^,]+),\s*([A-Za-z_$][\w$]*)\s*\)/gu,
  )) {
    const prefix = stringLiteral(match[1]);
    if (prefix !== undefined) values.set(match[2] ?? "", prefix);
  }
  return values;
}

function scanArtifact(artifact: SourceArtifactInput): FrameworkScanResult {
  const candidates: EndpointCandidate[] = [];
  const diagnostics = [];
  const mountedPrefixes = mounts(artifact.content);
  const knownReceivers = new Set(["app", "router"]);
  for (const match of artifact.content.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:express\.)?Router\s*\(/gu,
  )) {
    knownReceivers.add(match[1] ?? "");
  }

  for (const { line, offset } of linesWithOffsets(artifact.content)) {
    const route =
      /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|head|options)\s*\((.*)\)\s*;?/iu.exec(line);
    if (route === null) continue;
    const receiver = route[1] ?? "app";
    if (!knownReceivers.has(receiver)) continue;
    const args = (route[3] ?? "").split(",").map((value) => value.trim());
    const expression = args.shift();
    const path = stringLiteral(expression);
    if (path === undefined) {
      diagnostics.push(dynamicRouteDiagnostic("express", artifact, expression ?? "", offset));
      continue;
    }
    const handlers = args.map(identifier).filter((name): name is string => name !== undefined);
    const handlerName = handlers.at(-1);
    if (handlerName === undefined) continue;
    candidates.push({
      artifactPath: artifact.path,
      declaredPath: joinPaths(
        receiver === "app" ? "" : (mountedPrefixes.get(receiver) ?? ""),
        path,
      ),
      endOffset: offset + line.length,
      evidence: line,
      handlerName,
      httpMethod: route[2]?.toUpperCase() ?? "GET",
      middleware: handlers.slice(0, -1),
      startOffset: offset,
    });
  }

  return { candidates, diagnostics };
}

export class ExpressFrameworkAdapter implements FrameworkAdapter {
  public readonly framework = "express";
  public readonly id = "express-framework";

  public supports(detection: FrameworkAdapterContext["detection"]): boolean {
    return detection.frameworks.includes(this.framework);
  }

  public async enrich(
    context: FrameworkAdapterContext,
    artifacts: readonly ArtifactExtractionResult[],
  ): Promise<readonly ArtifactExtractionResult[]> {
    const scans = new Map(
      sourceArtifacts(context, "typescript").map((artifact) => [
        artifact.path,
        scanArtifact(artifact),
      ]),
    );
    return enrichFrameworkFacts(context, artifacts, this.id, "typescript", scans);
  }
}
