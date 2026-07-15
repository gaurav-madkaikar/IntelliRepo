import type { Confidence } from "./confidence.js";

export interface SourcePosition {
  readonly column: number;
  readonly line: number;
}

export interface SourceRange {
  readonly end: SourcePosition;
  readonly start: SourcePosition;
}

export interface FactProvenance {
  readonly artifactPath: string;
  readonly confidence: Confidence;
  readonly evidence: string;
  readonly extractor: string;
  readonly range: SourceRange;
  readonly repositoryRevision: string;
}

export interface CreateProvenanceInput extends Omit<FactProvenance, "artifactPath" | "range"> {
  readonly artifactPath: string;
  readonly range: SourceRange;
}

function createPosition(position: SourcePosition, name: string): SourcePosition {
  if (!Number.isInteger(position.line) || position.line < 1) {
    throw new Error(`${name}.line must be a positive integer`);
  }
  if (!Number.isInteger(position.column) || position.column < 1) {
    throw new Error(`${name}.column must be a positive integer`);
  }

  return Object.freeze({ column: position.column, line: position.line });
}

export function createSourceRange(range: SourceRange): SourceRange {
  const start = createPosition(range.start, "start");
  const end = createPosition(range.end, "end");
  const endPrecedesStart =
    end.line < start.line || (end.line === start.line && end.column < start.column);

  if (endPrecedesStart) {
    throw new Error("Source range end must not precede its start");
  }

  return Object.freeze({ end, start });
}

function normalizeArtifactPath(artifactPath: string): string {
  const normalized = artifactPath.trim().replaceAll("\\", "/").replace(/^\.\//, "");

  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error("artifactPath must be a repository-relative path");
  }

  return normalized;
}

export function createProvenance(input: CreateProvenanceInput): FactProvenance {
  const extractor = input.extractor.trim();
  const evidence = input.evidence.trim();
  const repositoryRevision = input.repositoryRevision.trim();

  if (extractor.length === 0 || evidence.length === 0 || repositoryRevision.length === 0) {
    throw new Error("Provenance extractor, evidence, and repositoryRevision must not be empty");
  }

  return Object.freeze({
    artifactPath: normalizeArtifactPath(input.artifactPath),
    confidence: input.confidence,
    evidence,
    extractor,
    range: createSourceRange(input.range),
    repositoryRevision,
  });
}
