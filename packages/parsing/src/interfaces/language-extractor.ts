import type { SourceLanguage } from "@intellirepo/domain";

import type {
  ArtifactExtractionResult,
  ProjectDetection,
  ProjectExtractionInput,
  SourceArtifactInput,
} from "./extraction.js";

export interface LanguageExtractorContext extends ProjectExtractionInput {
  readonly detection: ProjectDetection;
}

export interface LanguageExtractor {
  readonly id: string;
  readonly language: SourceLanguage;
  extract(context: LanguageExtractorContext): Promise<readonly ArtifactExtractionResult[]>;
  supports(artifact: SourceArtifactInput): boolean;
}
