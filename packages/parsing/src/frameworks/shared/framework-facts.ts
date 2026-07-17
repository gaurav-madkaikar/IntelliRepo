import type { EntityFact, SourceLanguage } from "@intellirepo/domain";

import { createDiagnostic, type ExtractionDiagnostic } from "../../diagnostics/diagnostic.js";
import type { ArtifactExtractionResult, SourceArtifactInput } from "../../interfaces/extraction.js";
import type { FrameworkAdapterContext } from "../../interfaces/framework-adapter.js";
import {
  makeMetadataEntityFact,
  makeMetadataRelationshipFact,
  rangeForOffsets,
} from "../../metadata/fact-factory.js";

export interface EndpointCandidate {
  readonly artifactPath: string;
  readonly declaredPath: string;
  readonly endOffset: number;
  readonly evidence: string;
  readonly handlerName: string;
  readonly httpMethod: string;
  readonly middleware?: readonly string[];
  readonly requestType?: string;
  readonly responseType?: string;
  readonly startOffset: number;
}

export interface FrameworkScanResult {
  readonly candidates: readonly EndpointCandidate[];
  readonly diagnostics?: readonly ExtractionDiagnostic[];
}

export function sourceArtifacts(
  context: FrameworkAdapterContext,
  language: SourceLanguage,
): readonly SourceArtifactInput[] {
  return context.artifacts.filter(
    (artifact) =>
      artifact.language === language &&
      (artifact.artifactKind === "code" || artifact.artifactKind === "test"),
  );
}

export function joinPaths(...parts: readonly string[]): string {
  const joined = parts
    .filter((part) => part.trim().length > 0 && part.trim() !== "/")
    .map((part) => part.trim().replace(/^\/+|\/+$/gu, ""))
    .filter((part) => part.length > 0)
    .join("/");
  return joined.length === 0 ? "/" : `/${joined}`;
}

export function normalizeEndpointPath(path: string): string {
  return joinPaths(path).replace(/:([A-Za-z_$][\w$]*)/gu, "{$1}");
}

export function stringLiteral(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return "";
  const match = /^\s*["'`]([^"'`]*)["'`]\s*$/u.exec(value);
  return match?.[1];
}

export function dynamicRouteDiagnostic(
  adapterId: string,
  artifact: SourceArtifactInput,
  expression: string,
  startOffset: number,
): ExtractionDiagnostic {
  return createDiagnostic({
    artifactPath: artifact.path,
    code: `${adapterId.toUpperCase().replaceAll("-", "_")}_DYNAMIC_ROUTE`,
    message: `Route expression ${expression.trim()} is not a supported static string`,
    range: rangeForOffsets(artifact.content, startOffset, startOffset + expression.length),
    severity: "warning",
  });
}

function handlerFor(
  result: ArtifactExtractionResult,
  candidate: EndpointCandidate,
  sourceContent: string,
): EntityFact | undefined {
  const supportedKinds = new Set(["function", "method"]);
  const candidates = result.entities.filter(
    (entity) => supportedKinds.has(entity.kind) && entity.name === candidate.handlerName,
  );
  const routeLine = rangeForOffsets(sourceContent, candidate.startOffset, candidate.endOffset).start
    .line;
  return [...candidates].sort(
    (left, right) =>
      Math.abs(left.provenance.range.start.line - routeLine) -
      Math.abs(right.provenance.range.start.line - routeLine),
  )[0];
}

export function linesWithOffsets(content: string): readonly { line: string; offset: number }[] {
  const lines: { line: string; offset: number }[] = [];
  let offset = 0;
  for (const line of content.split("\n")) {
    lines.push({ line, offset });
    offset += line.length + 1;
  }
  return lines;
}

export function enrichFrameworkFacts(
  context: FrameworkAdapterContext,
  artifacts: readonly ArtifactExtractionResult[],
  adapterId: string,
  language: SourceLanguage,
  scans: ReadonlyMap<string, FrameworkScanResult>,
): readonly ArtifactExtractionResult[] {
  return artifacts.map((result) => {
    const scan = scans.get(result.artifactPath);
    if (scan === undefined) return result;

    const source = context.artifacts.find(({ path }) => path === result.artifactPath);
    if (source === undefined) return result;

    const entities = [...result.entities];
    const relationships = [...result.relationships];
    const diagnostics = [...result.diagnostics, ...(scan.diagnostics ?? [])];
    const middlewareByName = new Map(
      result.entities
        .filter((entity) => entity.kind === "middleware")
        .map((entity) => [entity.name, entity]),
    );
    const entityKeys = new Set(result.entities.map(({ stableKey }) => stableKey));

    for (const candidate of scan.candidates) {
      const handler = handlerFor(result, candidate, source.content);
      if (handler === undefined) {
        diagnostics.push(
          createDiagnostic({
            artifactPath: result.artifactPath,
            code: `${adapterId.toUpperCase().replaceAll("-", "_")}_UNRESOLVED_HANDLER`,
            message: `Handler ${candidate.handlerName} could not be resolved in the source artifact`,
            range: rangeForOffsets(source.content, candidate.startOffset, candidate.endOffset),
            severity: "warning",
          }),
        );
        continue;
      }

      const range = rangeForOffsets(source.content, candidate.startOffset, candidate.endOffset);
      const normalizedPath = normalizeEndpointPath(candidate.declaredPath);
      const httpMethod = candidate.httpMethod.toUpperCase();
      const factContext = {
        artifactPath: result.artifactPath,
        extractor: adapterId,
        language,
        repositoryId: context.repositoryId,
        revisionId: context.revisionId,
      } as const;
      const endpoint = makeMetadataEntityFact(factContext, {
        attributes: {
          declaredPath: candidate.declaredPath,
          handlerEntityKey: handler.stableKey,
          httpMethod,
          normalizedPath,
          ...(candidate.requestType === undefined ? {} : { requestType: candidate.requestType }),
          ...(candidate.responseType === undefined ? {} : { responseType: candidate.responseType }),
        },
        evidence: candidate.evidence,
        kind: "endpoint",
        level: "confirmed",
        name: `${httpMethod} ${normalizedPath}`,
        qualifiedName: `${result.artifactPath}#endpoint:${httpMethod}:${normalizedPath}:${handler.stableKey}`,
        range,
        reason: "Static framework route declaration",
        score: 1,
      });
      if (entityKeys.has(endpoint.stableKey)) continue;
      entityKeys.add(endpoint.stableKey);
      entities.push(endpoint);
      relationships.push(
        makeMetadataRelationshipFact(factContext, {
          attributes: { httpMethod, path: normalizedPath },
          evidence: candidate.evidence,
          kind: "HANDLES",
          level: "confirmed",
          range,
          reason: "Framework route directly names the handler",
          score: 1,
          source: handler.stableKey,
          target: endpoint.stableKey,
        }),
      );

      for (const [order, middlewareName] of (candidate.middleware ?? []).entries()) {
        let middleware = middlewareByName.get(middlewareName);
        if (middleware === undefined) {
          middleware = makeMetadataEntityFact(factContext, {
            attributes: { signature: middlewareName },
            evidence: candidate.evidence,
            kind: "middleware",
            level: "confirmed",
            name: middlewareName,
            qualifiedName: `${result.artifactPath}#middleware:${middlewareName}`,
            range,
            reason: "Static framework middleware declaration",
            score: 1,
          });
          middlewareByName.set(middlewareName, middleware);
          entityKeys.add(middleware.stableKey);
          entities.push(middleware);
        }
        relationships.push(
          makeMetadataRelationshipFact(factContext, {
            attributes: { order },
            evidence: candidate.evidence,
            kind: "USES_MIDDLEWARE",
            level: "confirmed",
            range,
            reason: "Middleware is declared on the route or its enclosing scope",
            score: 1,
            source: endpoint.stableKey,
            target: middleware.stableKey,
          }),
        );
      }
    }

    return Object.freeze({
      ...result,
      diagnostics: Object.freeze(diagnostics),
      entities: Object.freeze(entities),
      relationships: Object.freeze(relationships),
    });
  });
}
