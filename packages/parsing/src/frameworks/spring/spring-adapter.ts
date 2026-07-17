import type {
  FrameworkAdapter,
  FrameworkAdapterContext,
} from "../../interfaces/framework-adapter.js";
import type { ArtifactExtractionResult } from "../../interfaces/extraction.js";
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

const METHOD_BY_MAPPING: Readonly<Record<string, string>> = {
  DeleteMapping: "DELETE",
  GetMapping: "GET",
  PatchMapping: "PATCH",
  PostMapping: "POST",
  PutMapping: "PUT",
};

function annotationPath(expression: string | undefined): string | undefined {
  if (expression === undefined || expression.trim().length === 0) return "";
  const assigned = /(?:path|value)\s*=\s*(["'`][^"'`]*["'`])/u.exec(expression)?.[1];
  return stringLiteral(assigned ?? expression);
}

function requestMappingMethods(expression: string | undefined): readonly string[] {
  if (expression === undefined) return ["ANY"];
  const methods = [...expression.matchAll(/RequestMethod\.([A-Z]+)/gu)].map(
    (match) => match[1] ?? "ANY",
  );
  return methods.length === 0 ? ["ANY"] : methods;
}

function controllerPrefix(content: string): string {
  const classIndex = content.search(/\bclass\s+[A-Za-z_$][\w$]*/u);
  if (classIndex < 0) return "";
  const prefix = content.slice(0, classIndex);
  const mappings = [...prefix.matchAll(/@RequestMapping\s*\(\s*([^)]*)\)/gu)];
  return annotationPath(mappings.at(-1)?.[1]) ?? "";
}

function scanSpring(context: FrameworkAdapterContext): ReadonlyMap<string, FrameworkScanResult> {
  const scans = new Map<string, FrameworkScanResult>();
  for (const artifact of sourceArtifacts(context, "java").filter(({ content }) =>
    /@RestController\b/u.test(content),
  )) {
    const candidates: EndpointCandidate[] = [];
    const diagnostics = [];
    const prefix = controllerPrefix(artifact.content);
    let pendingMapping:
      { expression?: string; methods: readonly string[]; offset: number; text: string } | undefined;
    const classDeclaration = artifact.content.search(/\bclass\s+[A-Za-z_$][\w$]*/u);
    const classMiddleware = [
      ...artifact.content
        .slice(0, classDeclaration < 0 ? 0 : classDeclaration)
        .matchAll(/@(PreAuthorize|Secured|RolesAllowed)\b/gu),
    ].map((match) => match[1] ?? "security");
    let pendingMiddleware: string[] = [];

    for (const { line, offset } of linesWithOffsets(artifact.content)) {
      if (offset + line.length <= classDeclaration) continue;
      const mapping =
        /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*(?:\((.*)\))?/u.exec(
          line,
        );
      if (mapping !== null) {
        const mappingName = mapping[1] ?? "RequestMapping";
        pendingMapping = {
          ...(mapping[2] === undefined ? {} : { expression: mapping[2] }),
          methods:
            mappingName === "RequestMapping"
              ? requestMappingMethods(mapping[2])
              : [METHOD_BY_MAPPING[mappingName] ?? "ANY"],
          offset,
          text: line,
        };
        continue;
      }
      const security = /@(PreAuthorize|Secured|RolesAllowed)\b/u.exec(line)?.[1];
      if (security !== undefined) {
        pendingMiddleware.push(security);
        continue;
      }
      if (pendingMapping === undefined) continue;
      const method =
        /(?:public\s+|protected\s+|private\s+)?(?:static\s+)?([\w.<>?[\]]+)\s+([A-Za-z_$][\w$]*)\s*\((.*)\)\s*(?:\{|throws\b)/u.exec(
          line,
        );
      if (method === null) continue;

      const expression = pendingMapping.expression;
      const route = annotationPath(expression);
      if (route === undefined) {
        diagnostics.push(
          dynamicRouteDiagnostic("spring", artifact, expression ?? "", pendingMapping.offset),
        );
        pendingMapping = undefined;
        pendingMiddleware = [];
        continue;
      }
      const parameters = method[3] ?? "";
      const requestType = /@RequestBody\s+([\w.<>?]+)/u.exec(parameters)?.[1];
      const handlerName = method[2] ?? "";
      const responseType = method[1];
      const evidence = `${pendingMapping.text}\n${line}`;
      for (const httpMethod of pendingMapping.methods) {
        candidates.push({
          artifactPath: artifact.path,
          declaredPath: joinPaths(prefix, route),
          endOffset: offset + line.length,
          evidence,
          handlerName,
          httpMethod,
          middleware: [...classMiddleware, ...pendingMiddleware],
          ...(requestType === undefined ? {} : { requestType }),
          ...(responseType === undefined ? {} : { responseType }),
          startOffset: pendingMapping.offset,
        });
      }
      pendingMapping = undefined;
      pendingMiddleware = [];
    }
    scans.set(artifact.path, { candidates, diagnostics });
  }
  return scans;
}

export class SpringFrameworkAdapter implements FrameworkAdapter {
  public readonly framework = "spring-boot";
  public readonly id = "spring-framework";

  public supports(detection: FrameworkAdapterContext["detection"]): boolean {
    return detection.frameworks.includes(this.framework);
  }

  public async enrich(
    context: FrameworkAdapterContext,
    artifacts: readonly ArtifactExtractionResult[],
  ): Promise<readonly ArtifactExtractionResult[]> {
    return enrichFrameworkFacts(context, artifacts, this.id, "java", scanSpring(context));
  }
}
