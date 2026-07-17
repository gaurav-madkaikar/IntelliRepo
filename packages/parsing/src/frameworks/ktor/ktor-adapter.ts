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

interface Scope {
  readonly depth: number;
  readonly kind: "middleware" | "path";
  readonly value: string;
}

function scanArtifact(artifact: SourceArtifactInput): FrameworkScanResult {
  const candidates: EndpointCandidate[] = [];
  const diagnostics = [];
  const scopes: Scope[] = [];
  const globalMiddleware = [
    ...artifact.content.matchAll(/install\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/gu),
  ].map((match) => `plugin:${match[1] ?? "unknown"}`);
  let depth = 0;
  let handlerName = "";

  for (const { line, offset } of linesWithOffsets(artifact.content)) {
    const leadingClosing = /^\s*(\}+)/u.exec(line)?.[1]?.length ?? 0;
    depth = Math.max(0, depth - leadingClosing);
    while ((scopes.at(-1)?.depth ?? -1) > depth) scopes.pop();

    const functionMatch = /\bfun\s+(?:[\w.<>?]+\.)?([A-Za-z_$][\w$]*)\s*\(/u.exec(line);
    if (functionMatch !== null) handlerName = functionMatch[1] ?? "";

    const routeScope = /\broute\s*\(\s*([^)]*)\)\s*\{/u.exec(line);
    if (routeScope !== null) {
      const route = stringLiteral(routeScope[1]);
      if (route === undefined) {
        diagnostics.push(dynamicRouteDiagnostic("ktor", artifact, routeScope[1] ?? "", offset));
      } else {
        scopes.push({ depth: depth + 1, kind: "path", value: route });
      }
    }

    const authScope = /\bauthenticate\s*\(\s*([^)]*)\)\s*\{/u.exec(line);
    if (authScope !== null) {
      const name = stringLiteral(authScope[1]);
      scopes.push({
        depth: depth + 1,
        kind: "middleware",
        value: `authenticate:${name ?? "dynamic"}`,
      });
    }

    const endpoint = /\b(get|post|put|patch|delete|head|options)\s*\(\s*([^)]*)\)\s*\{/iu.exec(
      line,
    );
    if (endpoint !== null && handlerName.length > 0) {
      const expression = endpoint[2];
      const route = stringLiteral(expression);
      if (route === undefined) {
        diagnostics.push(dynamicRouteDiagnostic("ktor", artifact, expression ?? "", offset));
      } else {
        candidates.push({
          artifactPath: artifact.path,
          declaredPath: joinPaths(
            ...scopes.filter(({ kind }) => kind === "path").map(({ value }) => value),
            route,
          ),
          endOffset: offset + line.length,
          evidence: line,
          handlerName,
          httpMethod: endpoint[1]?.toUpperCase() ?? "GET",
          middleware: [
            ...globalMiddleware,
            ...scopes.filter(({ kind }) => kind === "middleware").map(({ value }) => value),
          ],
          startOffset: offset,
        });
      }
    }

    const opening = line.match(/\{/gu)?.length ?? 0;
    const closing = line.match(/\}/gu)?.length ?? 0;
    depth = Math.max(0, depth + opening - (closing - leadingClosing));
  }

  return { candidates, diagnostics };
}

export class KtorFrameworkAdapter implements FrameworkAdapter {
  public readonly framework = "ktor";
  public readonly id = "ktor-framework";

  public supports(detection: FrameworkAdapterContext["detection"]): boolean {
    return detection.frameworks.includes(this.framework);
  }

  public async enrich(
    context: FrameworkAdapterContext,
    artifacts: readonly ArtifactExtractionResult[],
  ): Promise<readonly ArtifactExtractionResult[]> {
    const scans = new Map(
      sourceArtifacts(context, "kotlin").map((artifact) => [artifact.path, scanArtifact(artifact)]),
    );
    return enrichFrameworkFacts(context, artifacts, this.id, "kotlin", scans);
  }
}
