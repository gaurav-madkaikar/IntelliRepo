import type {
  EntityFact,
  EntityStableKey,
  RelationshipFact,
  SourceLanguage,
  SourceRange,
} from "@intellirepo/domain";

import type { ExtractionDiagnostic } from "../diagnostics/diagnostic.js";

export type ExtractionMode = "semantic" | "syntax-fallback";

export interface SourceArtifactInput {
  readonly artifactKind: "build" | "code" | "configuration" | "test";
  readonly content: string;
  readonly language?: SourceLanguage;
  readonly path: string;
}

export interface ProjectExtractionInput {
  readonly artifacts: readonly SourceArtifactInput[];
  readonly repositoryId: string;
  readonly revisionId: string;
}

export interface UnresolvedReference {
  readonly artifactPath: string;
  readonly candidateEntityKeys: readonly EntityStableKey[];
  readonly kind: "call" | "configuration" | "heritage" | "import";
  readonly name: string;
  readonly range: SourceRange;
  readonly sourceEntityKey: EntityStableKey;
}

export interface ArtifactExtractionResult {
  readonly artifactPath: string;
  readonly diagnostics: readonly ExtractionDiagnostic[];
  readonly entities: readonly EntityFact[];
  readonly mode: ExtractionMode;
  readonly relationships: readonly RelationshipFact[];
  readonly unresolvedReferences: readonly UnresolvedReference[];
}

export interface ProjectDetection {
  readonly configPaths: readonly string[];
  readonly frameworks: readonly string[];
  readonly languages: readonly SourceLanguage[];
  readonly sourceRoots: readonly string[];
}

export interface ProjectExtractionResult {
  readonly artifacts: readonly ArtifactExtractionResult[];
  readonly detection: ProjectDetection;
  readonly diagnostics: readonly ExtractionDiagnostic[];
  readonly repositoryId: string;
  readonly revisionId: string;
}
