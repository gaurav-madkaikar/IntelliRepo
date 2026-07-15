import type {
  ArtifactExtractionResult,
  ProjectDetection,
  ProjectExtractionInput,
} from "./extraction.js";

export interface FrameworkAdapterContext extends ProjectExtractionInput {
  readonly detection: ProjectDetection;
}

export interface FrameworkAdapter {
  readonly framework: string;
  readonly id: string;
  enrich(
    context: FrameworkAdapterContext,
    artifacts: readonly ArtifactExtractionResult[],
  ): Promise<readonly ArtifactExtractionResult[]>;
  supports(detection: ProjectDetection): boolean;
}
