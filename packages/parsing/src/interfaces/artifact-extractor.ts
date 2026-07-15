import type {
  ArtifactExtractionResult,
  ProjectDetection,
  ProjectExtractionInput,
  SourceArtifactInput,
} from "./extraction.js";

export interface ArtifactExtractorContext extends ProjectExtractionInput {
  readonly detection: ProjectDetection;
}

export interface ArtifactExtractor {
  readonly id: string;
  extract(
    artifact: SourceArtifactInput,
    context: ArtifactExtractorContext,
  ): Promise<ArtifactExtractionResult>;
  supports(artifact: SourceArtifactInput): boolean;
}
