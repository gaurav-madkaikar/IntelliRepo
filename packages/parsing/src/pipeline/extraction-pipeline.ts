import { createDiagnostic } from "../diagnostics/diagnostic.js";
import type {
  ArtifactExtractionResult,
  ProjectExtractionInput,
  ProjectExtractionResult,
} from "../interfaces/extraction.js";
import type { LanguageExtractor } from "../interfaces/language-extractor.js";
import { AdapterRegistry } from "./adapter-registry.js";
import { detectProject, inferArtifactLanguage } from "./project-detector.js";
import { validateArtifactExtraction } from "./validation.js";
import { linkConfigurationReferences } from "../configuration/configuration-linker.js";
import { resolveCrossLanguageReferences } from "./cross-language-resolver.js";

function emptyFailureResult(
  artifactPath: string,
  extractor: Pick<LanguageExtractor, "id">,
  error: unknown,
) {
  return Object.freeze({
    artifactPath,
    diagnostics: [
      createDiagnostic({
        artifactPath,
        code: "EXTRACTOR_FAILURE",
        message: `${extractor.id}: ${error instanceof Error ? error.message : "Unknown failure"}`,
        severity: "error",
      }),
    ],
    entities: [],
    mode: "syntax-fallback" as const,
    relationships: [],
    unresolvedReferences: [],
  });
}

export class ExtractionPipeline {
  public constructor(private readonly registry: AdapterRegistry) {}

  public async extract(input: ProjectExtractionInput): Promise<ProjectExtractionResult> {
    const detection = detectProject(input.artifacts);
    const byExtractor = new Map<LanguageExtractor, typeof input.artifacts>();

    for (const artifact of input.artifacts) {
      const language = inferArtifactLanguage(artifact) ?? "unknown";
      const extractor = this.registry.extractorFor(language);
      if (extractor !== undefined && extractor.supports(artifact)) {
        byExtractor.set(extractor, [...(byExtractor.get(extractor) ?? []), artifact]);
      }
    }

    const artifacts: ArtifactExtractionResult[] = [];
    for (const [extractor, supportedArtifacts] of byExtractor) {
      try {
        const extracted = await extractor.extract({
          ...input,
          artifacts: input.artifacts,
          detection,
        });
        artifacts.push(
          ...extracted.map((result) => validateArtifactExtraction(result, input.revisionId)),
        );
      } catch (error) {
        artifacts.push(
          ...supportedArtifacts.map(({ path }) => emptyFailureResult(path, extractor, error)),
        );
      }
    }

    for (const artifact of input.artifacts) {
      const extractor = this.registry.artifactExtractorFor(artifact);
      if (extractor === undefined) continue;
      try {
        artifacts.push(
          validateArtifactExtraction(
            await extractor.extract(artifact, { ...input, detection }),
            input.revisionId,
          ),
        );
      } catch (error) {
        artifacts.push(emptyFailureResult(artifact.path, extractor, error));
      }
    }

    let enriched: readonly ArtifactExtractionResult[] = linkConfigurationReferences(
      resolveCrossLanguageReferences(artifacts, input.repositoryId, input.revisionId),
      input.repositoryId,
      input.revisionId,
    );
    for (const adapter of this.registry.frameworkAdaptersFor(detection)) {
      enriched = await adapter.enrich({ ...input, detection }, enriched);
      enriched = enriched.map((result) => validateArtifactExtraction(result, input.revisionId));
    }

    const diagnostics = enriched.flatMap(
      ({ diagnostics: artifactDiagnostics }) => artifactDiagnostics,
    );
    return Object.freeze({
      artifacts: Object.freeze([...enriched]),
      detection,
      diagnostics: Object.freeze(diagnostics),
      repositoryId: input.repositoryId,
      revisionId: input.revisionId,
    });
  }
}
